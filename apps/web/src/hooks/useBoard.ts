'use client'

import { useQuery } from '@tanstack/react-query'
import { useAccount, useWalletClient } from 'wagmi'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  boardOf,
  currentEpoch,
  globalPage,
  hydrateThreads,
  indexPage,
  loadBoards,
  loadGlobalIndex,
  loadIndex,
  loadThread,
  parseEntity,
  resolveBoard,
  type BoardGate,
  type IndexPageItem,
  type PostRecord,
  type ResolvedBoard,
  type ThreadRecord,
} from '@fairhaven/board-core'
import { arkivStore } from '@/lib/arkiv'
import { membership } from '@/lib/evm'
import { hasUnlocked, openSealedText, parseGateJson, unlock, type WalletClientLike } from '@/lib/aol'
import { useSession } from '@/store/session'

const INDEX_POLL_MS = 6000
const THREAD_POLL_MS = 3000

export function useBoards() {
  return useQuery({ queryKey: ['boards'], queryFn: () => loadBoards(arkivStore), staleTime: 30_000 })
}

export function useResolvedBoard(slugOrGate: string | null) {
  return useQuery({
    queryKey: ['board', slugOrGate],
    queryFn: async () => (slugOrGate ? ((await resolveBoard(arkivStore, slugOrGate)) ?? null) : null),
    enabled: !!slugOrGate,
    staleTime: 60_000,
  })
}

export function useCurrentBlock() {
  return useQuery({ queryKey: ['block'], queryFn: () => arkivStore.currentBlock(), refetchInterval: 10_000 })
}

/** Index with membership filtering and OP payload hydration for the current page. */
export function useIndex(board: ResolvedBoard | null | undefined, page: number) {
  const block = useCurrentBlock()
  const q = useQuery({
    queryKey: ['index', board?.ref.slug, board?.ref.gate.tokenAddress, block.data ?? null],
    queryFn: async () => {
      if (!board) return null
      const idx = await loadIndex(arkivStore, board, block.data ?? undefined)
      return idx
    },
    enabled: !!board,
    refetchInterval: INDEX_POLL_MS,
  })
  const pageQ = useQuery({
    queryKey: ['index-page', board?.ref.slug, page, q.data?.folded.map((f) => `${f.key}:${f.bumpKey}`).join(',') ?? ''],
    queryFn: async () => {
      if (!board || !q.data) return null
      const pg = indexPage(q.data, page)
      const owners = [...pg.items.map((i) => i.thread.owner), ...pg.items.flatMap((i) => i.tail.map((t) => t.owner))]
      const uniq = [...new Set(owners)]
      const checks = await Promise.all(uniq.map((o) => membership.isMember(board.ref.gate, o)))
      const member = new Map(uniq.map((o, i) => [o, checks[i] as boolean]))
      const items: IndexPageItem[] = pg.items.filter((i) => member.get(i.thread.owner)).map((i) => ({ ...i, tail: i.tail.filter((t) => member.get(t.owner)) }))
      const hydrated = await hydrateThreads(arkivStore, items.map((i) => i.thread), board.ref)
      const withPayload = items.map((i, n) => ({ ...i, thread: hydrated[n] ?? i.thread }))
      // Replies on the index need payloads too (tail is at most 3 per thread).
      const tails = await Promise.all(
        withPayload.map(async (i) => ({
          ...i,
          tail: await Promise.all(
            i.tail.map(async (t) => {
              if (t.payload) return t
              const raw = await arkivStore.get(t.key)
              if (!raw) return t
              const rec = parseEntity(raw, { board: board.ref })
              return rec?.kind === 'post' ? rec : t
            }),
          ),
        })),
      )
      return { items: tails, page: pg.page, pages: pg.pages, total: q.data.folded.length }
    },
    enabled: !!board && !!q.data,
  })
  return { index: q, page: pageQ, currentBlock: block.data ?? undefined }
}

// ── Global feed ─────────────────────────────────────────────────────────

const GLOBAL_POLL_MS = 8000

/** Every gate at once. Membership is checked per thread against that thread's gate. */
export function useGlobalFeed(page: number) {
  const block = useCurrentBlock()
  const q = useQuery({
    queryKey: ['global', block.data ?? null],
    queryFn: () => loadGlobalIndex(arkivStore, { ...(block.data !== undefined ? { currentBlock: block.data } : {}) }),
    refetchInterval: GLOBAL_POLL_MS,
  })
  const pageQ = useQuery({
    queryKey: ['global-page', page, q.data?.folded.map((f) => `${f.key}:${f.bumpKey}`).join(',') ?? ''],
    queryFn: async () => {
      if (!q.data) return null
      const pg = globalPage(q.data, page)
      // One membership check per (gate, owner) pair on this page.
      const checks = await Promise.all(
        pg.items.map(async (i) => {
          const gate = i.thread.gate
          const owners = [...new Set([i.thread.owner, ...i.tail.map((t) => t.owner)])]
          const ok = await Promise.all(owners.map((o) => membership.isMember(gate, o)))
          return new Map(owners.map((o, n) => [o, ok[n] as boolean]))
        }),
      )
      const items: IndexPageItem[] = []
      for (let n = 0; n < pg.items.length; n++) {
        const i = pg.items[n]!
        const m = checks[n]!
        if (!m.get(i.thread.owner)) continue
        items.push({ ...i, tail: i.tail.filter((t) => m.get(t.owner)) })
      }
      const hydrated = await Promise.all(
        items.map(async (i) => {
          const board = boardOf(q.data!, i.thread)
          const [thread] = await hydrateThreads(arkivStore, [i.thread], board.ref)
          const tail = await Promise.all(
            i.tail.map(async (t) => {
              if (t.payload) return t
              const raw = await arkivStore.get(t.key)
              if (!raw) return t
              const rec = parseEntity(raw, { board: board.ref })
              return rec?.kind === 'post' ? rec : t
            }),
          )
          return { ...i, thread: thread ?? i.thread, tail }
        }),
      )
      return { items: hydrated, page: pg.page, pages: pg.pages, total: q.data.folded.length }
    },
    enabled: !!q.data,
  })
  return { index: q, page: pageQ, currentBlock: block.data ?? undefined, boards: q.data?.boards ?? new Map<string, ResolvedBoard>() }
}

export function useThread(board: ResolvedBoard | null | undefined, rootKey: string | null) {
  const block = useCurrentBlock()
  return useQuery({
    queryKey: ['thread', board?.ref.slug, rootKey, block.data ?? null],
    queryFn: async () => {
      if (!board || !rootKey) return null
      const t = await loadThread(arkivStore, board, rootKey, block.data ?? undefined)
      if (!t) return null
      const owners = [t.root.owner, ...t.replies.map((r) => r.owner)]
      const uniq = [...new Set(owners)]
      const checks = await Promise.all(uniq.map((o) => membership.isMember(board.ref.gate, o)))
      const member = new Map(uniq.map((o, i) => [o, checks[i] as boolean]))
      if (!member.get(t.root.owner)) return { ...t, rootHidden: true as const, replies: [] as PostRecord[] }
      return { ...t, rootHidden: false as const, replies: t.replies.filter((r) => member.get(r.owner)) }
    },
    enabled: !!board && !!rootKey,
    refetchInterval: THREAD_POLL_MS,
  })
}

// ── Membership of the connected wallet ──────────────────────────────────

export function useMyMembership(gate: BoardGate | undefined) {
  const { address } = useAccount()
  return useQuery({
    queryKey: ['me', gate?.chain, gate?.tokenAddress, gate?.threshold.toString(), address],
    queryFn: async () => {
      if (!gate || !address) return { balance: 0n, member: false }
      const balance = await membership.balance(gate, address)
      return { balance, member: balance >= gate.threshold }
    },
    enabled: !!gate && !!address,
    staleTime: 60_000,
  })
}

// ── Unlock ──────────────────────────────────────────────────────────────

export function useUnlock(gate: BoardGate | undefined) {
  const { data: walletClient } = useWalletClient()
  const bump = useSession((s) => s.bumpUnlock)
  const version = useSession((s) => s.unlockVersion)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const epoch = currentEpoch()
  const unlocked = useMemo(() => (gate ? hasUnlocked(gate, epoch) : false), [gate, epoch, version])
  const run = useCallback(
    async (targetEpoch: number = epoch) => {
      if (!gate || !walletClient) return false
      setError(null)
      try {
        await unlock(walletClient as unknown as WalletClientLike, gate, targetEpoch, setBusy)
        bump()
        return true
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return false
      } finally {
        setBusy(null)
      }
    },
    [gate, walletClient, epoch, bump],
  )
  return { unlocked, epoch, busy, error, unlock: run, canUnlock: !!walletClient }
}

// ── Opening sealed text, lazily, per record ─────────────────────────────

export type OpenState = { state: 'clear' | 'open'; text: string } | { state: 'locked' | 'unlocking' | 'failed' | 'foreign'; reason?: string; epoch?: number }

export function useOpenText(rec: ThreadRecord | PostRecord | undefined, gate: BoardGate | undefined) {
  const version = useSession((s) => s.unlockVersion)
  const [st, setSt] = useState<OpenState>({ state: 'locked' })
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!rec?.payload) {
        setSt({ state: 'locked' })
        return
      }
      if ('clear' in rec.payload.text) {
        setSt({ state: 'clear', text: rec.payload.text.clear })
        return
      }
      const gateJson = rec.payload.gate
      if (!gateJson) {
        setSt({ state: 'failed', reason: 'no gate' })
        return
      }
      const g = parseGateJson(gateJson)
      if (!g) {
        setSt({ state: 'failed', reason: 'unreadable gate' })
        return
      }
      if (g.version !== 3 || g.epoch === undefined) {
        setSt({ state: 'foreign', reason: `sealed with protocol v${g.version}` })
        return
      }
      if (!gate || !hasUnlocked(g.gate, g.epoch)) {
        setSt({ state: 'locked', epoch: g.epoch })
        return
      }
      setSt({ state: 'unlocking' })
      try {
        const text = await openSealedText(rec.payload)
        if (!cancelled) setSt({ state: 'open', text })
      } catch (e) {
        if (!cancelled) setSt({ state: 'failed', reason: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [rec?.key, rec?.payload, gate?.tokenAddress, version])
  return st
}
