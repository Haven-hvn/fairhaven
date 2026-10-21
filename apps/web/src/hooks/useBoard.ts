'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount, useWalletClient } from 'wagmi'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyEntityToBoardIndex,
  applyEntityToGlobalIndex,
  boardOf,
  currentEpoch,
  globalPage,
  gateOfRaw,
  gateSpecOf,
  hydratePosts,
  hydrateThreads,
  implicitSlug,
  indexPage,
  loadBoards,
  loadGlobalIndex,
  loadGlobalMore,
  loadIndex,
  loadIndexMore,
  loadThread,
  parseGateSpec,
  removeEntityFromBoardIndex,
  removeEntityFromGlobalIndex,
  resolveBoard,
  resolveFrom,
  sameGate,
  type BoardDef,
  type BoardGate,
  type BoardIndex,
  type GlobalIndex,
  type IndexPageItem,
  type PostRecord,
  type RawEntity,
  type ResolvedBoard,
  type ThreadRecord,
} from '@fairhaven/board-core'
import { arkivStore, watchEntities } from '@/lib/arkiv'
import { isBoardRow, keyTouchesThread, openThreadOf, rowsIncludeDef, rowsTouchThread, type OpenThread } from '@/lib/watch'
import { persistedCount } from '@/lib/persist'
import { membership } from '@/lib/evm'
import { hasUnlocked, openSealedText, parseGateJson, unlock, type WalletClientLike } from '@/lib/aol'
import { clockNow, verifyAuthors } from '@/lib/receipt'
import { useSession } from '@/store/session'

/**
 * Idle freshness without charged polling: `arkiv_getEntityCount` is a
 * free call (cost 0). Probe it once a minute; only when the count moves
 * do the charged index/thread/global queries refetch. An idle tab thus
 * costs 0 charged calls/min, and a busy one at most one reload/min.
 */
const PROBE_MS = 60_000

export function useChangeProbe(prefixes: string[]) {
  const qc = useQueryClient()
  const probe = useQuery({ queryKey: ['entity-count'], queryFn: () => arkivStore.entityCount(), refetchInterval: () => (typeof document !== 'undefined' && document.hidden ? false : PROBE_MS), staleTime: PROBE_MS })
  const seen = useRef<number | undefined>(undefined)
  if (seen.current === undefined) { try { seen.current = persistedCount() } catch { /* none */ } }
  const prefixesKey = prefixes.join(',')
  useEffect(() => {
    if (probe.data === undefined || (typeof document !== 'undefined' && document.hidden)) return
    if (seen.current !== undefined && seen.current !== probe.data) {
      for (const p of prefixesKey.split(',')) void qc.invalidateQueries({ queryKey: [p] })
    }
    seen.current = probe.data
  }, [probe.data, qc, prefixesKey])
}

// ── Live entity watch (WebSocket, free after handshake) ──────────────
// One shared subscription; deletions are applied to cached folds with no
// query at all, creations/patches are fetched as one batched $key read
// and folded in. Reloads are relevance-gated (lib/watch): the watch is
// chain-wide, so a foreign burst costs no charged query. The entity-count
// probe remains as fallback.
const watchSubs = new Set<(e: { type: string; entityKey: string }) => void>()
let watchStop: (() => void) | undefined
let watchStarting = false

export function useEntityWatch() {
  const qc = useQueryClient()
  useEffect(() => {
    const pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const openThreads = (): OpenThread[] =>
      qc
        .getQueriesData<{ root: ThreadRecord; replies: PostRecord[] }>({ queryKey: ['thread'] })
        .map(([, d]) => openThreadOf(d))
        .filter((o): o is OpenThread => o !== undefined)
    const flush = async () => {
      const keys = [...pending]
      pending.clear()
      if (keys.length === 0) return
      let rows: RawEntity[] = []
      try {
        rows = (await arkivStore.getMany?.(keys)) ?? []
        for (const raw of rows) {
          if (!isBoardRow(raw)) continue
          qc.setQueriesData<GlobalIndex>({ queryKey: ['global'] }, (old) => (old ? applyEntityToGlobalIndex(old, raw) : old))
          qc.setQueriesData<BoardIndex>({ queryKey: ['index'] }, (old) => (old ? applyEntityToBoardIndex(old, raw) : old))
        }
      } catch { /* probe fallback will invalidate */ }
      if (rowsIncludeDef(rows)) void qc.invalidateQueries({ queryKey: ['boards'] })
      if (rowsTouchThread(rows, openThreads())) void qc.invalidateQueries({ queryKey: ['thread'] })
    }
    const sub = (e: { type: string; entityKey: string }) => {
      if (typeof document !== 'undefined' && document.hidden) return
      if (e.type === 'EntityDeleted') {
        qc.setQueriesData<GlobalIndex>({ queryKey: ['global'] }, (old) => (old ? removeEntityFromGlobalIndex(old, e.entityKey) : old))
        qc.setQueriesData<BoardIndex>({ queryKey: ['index'] }, (old) => (old ? removeEntityFromBoardIndex(old, e.entityKey) : old))
        if (keyTouchesThread(e.entityKey, openThreads())) void qc.invalidateQueries({ queryKey: ['thread'] })
        return
      }
      pending.add(e.entityKey)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void flush(), 2000)
    }
    watchSubs.add(sub)
    if (!watchStop && !watchStarting) {
      watchStarting = true
      void watchEntities((e) => { for (const s of [...watchSubs]) s(e) }).then((stop) => { watchStarting = false; if (stop && watchSubs.size > 0) watchStop = stop; else stop?.() })
    }
    return () => {
      watchSubs.delete(sub)
      if (timer) clearTimeout(timer)
      if (watchSubs.size === 0) { watchStop?.(); watchStop = undefined }
    }
  }, [qc])
}

export function useBoards() {
  return useQuery({ queryKey: ['boards'], queryFn: () => loadBoards(arkivStore), staleTime: 30_000 })
}

export function useResolvedBoard(slugOrGate: string | null) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: ['board', slugOrGate],
    queryFn: async () => {
      if (!slugOrGate) return null
      // One shared boards fetch for the whole app (persisted across reloads).
      const boards = await qc.fetchQuery({ queryKey: ['boards'], queryFn: () => loadBoards(arkivStore), staleTime: 60_000 })
      const gate = parseGateSpec(slugOrGate)
      const def = gate ? boards.find((b) => sameGate(b.gate, gate)) : (boards.find((b) => b.board === slugOrGate) ?? boards.find((b) => implicitSlug(b.gate) === slugOrGate))
      if (def) return resolveFrom(def, def.gate)
      if (gate) return resolveFrom(undefined, gate)
      return null
    },
    enabled: !!slugOrGate,
    staleTime: 60_000,
  })
}

/** Legacy implicit slugs carry no threshold/token suffix, so a def-less board cannot be resolved from the slug alone. Read the root once, recover its gate, and share that raw root with `loadThread` (no second read). Defs come from the shared `['boards']` fetch. */
export function useBoardFromRoot(rootKey: string | null, enabled: boolean) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: ['board-from-root', rootKey],
    queryFn: async (): Promise<{ board: ResolvedBoard; raw: RawEntity } | null> => {
      if (!rootKey) return null
      const raw = (await arkivStore.getMany?.([rootKey]))?.[0]
      const gate = raw ? gateOfRaw(raw) : undefined
      if (!raw || !gate) return null
      const boards = await qc.fetchQuery({ queryKey: ['boards'], queryFn: () => loadBoards(arkivStore), staleTime: 60_000 }).catch(() => [] as BoardDef[])
      const def = boards.find((b) => sameGate(b.gate, gate))
      return { board: resolveFrom(def, gate), raw }
    },
    enabled: enabled && !!rootKey,
    staleTime: 60_000,
  })
}

export function useCurrentBlock() {
  return useQuery({ queryKey: ['block'], queryFn: () => arkivStore.currentBlock(), refetchInterval: 60_000 })
}

/** Index page: OP + tail payload hydration, then offline receipt verification of every author. */
export function useIndex(board: ResolvedBoard | null | undefined, page: number) {
  const block = useCurrentBlock()
  const qc = useQueryClient()
  useChangeProbe(['index', 'index-page'])
  useEntityWatch()
  const q = useQuery({
    // Block height is deliberately NOT in the key: blocks are 2s, so a
    // block-keyed query re-ran the whole loader 30x/min (paste E3).
    queryKey: ['index', board?.ref.slug, board?.ref.gate.tokenAddress],
    queryFn: async () => {
      if (!board) return null
      const idx = await loadIndex(arkivStore, board, block.data ?? undefined)
      return idx
    },
    enabled: !!board,
    staleTime: 30_000,
  })
  const pageQ = useQuery({
    queryKey: ['index-page', board?.ref.slug, page, q.data?.folded.map((f) => `${f.key}:${f.bumpKey}`).join(',') ?? ''],
    queryFn: async () => {
      if (!board || !q.data) return null
      const pg = indexPage(q.data, page)
      // Payloads first (one batched $key query for OPs, one for tails): the
      // membership receipt lives in the payload and is verified offline.
      const hydrated = await hydrateThreads(arkivStore, pg.items.map((i) => i.thread), board.ref)
      const withPayload = pg.items.map((i, n) => ({ ...i, thread: hydrated[n] ?? i.thread }))
      const flatTail = withPayload.flatMap((i) => i.tail)
      const hydratedTail = await hydratePosts(arkivStore, flatTail, board.ref)
      const tailByKey = new Map(hydratedTail.map((t) => [t.key, t]))
      const clock = clockNow(q.data.currentBlock ?? block.data ?? undefined)
      const okThreads = new Set((await verifyAuthors(withPayload.map((i) => i.thread), clock)).ok.map((t) => t.key))
      const okTails = new Set((await verifyAuthors(hydratedTail, clock)).ok.map((t) => t.key))
      const items: IndexPageItem[] = withPayload
        .filter((i) => okThreads.has(i.thread.key))
        .map((i) => ({ ...i, tail: i.tail.map((t) => tailByKey.get(t.key) ?? t).filter((t) => okTails.has(t.key)) }))
      return { items, page: pg.page, pages: pg.pages, total: q.data.folded.length, ...(q.data.truncated ? { truncated: true } : {}) }
    },
    enabled: !!board && !!q.data,
  })
  const loadMore = useCallback(async () => {
    if (!board || !q.data?.truncated) return
    const more = await loadIndexMore(arkivStore, q.data)
    qc.setQueryData(['index', board.ref.slug, board.ref.gate.tokenAddress], more)
    void qc.invalidateQueries({ queryKey: ['index-page'] })
  }, [board, q.data, qc])
  return { index: q, page: pageQ, currentBlock: block.data ?? undefined, loadMore }
}

// ── Global feed ─────────────────────────────────────────────────────────

/** Every gate at once. Each record's receipt is verified against that record's own gate. */
export function useGlobalFeed(page: number) {
  const block = useCurrentBlock()
  const qc2 = useQueryClient()
  useChangeProbe(['global', 'global-page'])
  useEntityWatch()
  const q = useQuery({
    queryKey: ['global'],
    queryFn: () => loadGlobalIndex(arkivStore, { ...(block.data !== undefined ? { currentBlock: block.data } : {}) }),
    staleTime: 30_000,
  })
  const pageQ = useQuery({
    queryKey: ['global-page', page, q.data?.folded.map((f) => `${f.key}:${f.bumpKey}`).join(',') ?? ''],
    queryFn: async () => {
      if (!q.data) return null
      const pg = globalPage(q.data, page)
      // Batched hydration grouped by board: one $key query per chunk for all OPs, one for all tails.
      const byBoard = new Map<string, { board: ReturnType<typeof boardOf>; items: IndexPageItem[] }>()
      for (const i of pg.items) {
        const board = boardOf(q.data!, i.thread)
        const g = byBoard.get(board.ref.slug) ?? { board, items: [] }
        g.items.push(i)
        byBoard.set(board.ref.slug, g)
      }
      const threadByKey = new Map<string, IndexPageItem['thread']>()
      const tailByKey = new Map<string, IndexPageItem['tail'][number]>()
      await Promise.all(
        [...byBoard.values()].map(async ({ board, items: group }) => {
          for (const t of await hydrateThreads(arkivStore, group.map((i) => i.thread), board.ref)) threadByKey.set(t.key, t)
          for (const t of await hydratePosts(arkivStore, group.flatMap((i) => i.tail), board.ref)) tailByKey.set(t.key, t)
        }),
      )
      // Every record carries its own gate, so one offline pass verifies the whole page.
      const clock = clockNow(q.data.currentBlock ?? block.data ?? undefined)
      const okThreads = new Set((await verifyAuthors([...threadByKey.values()], clock)).ok.map((t) => t.key))
      const okTails = new Set((await verifyAuthors([...tailByKey.values()], clock)).ok.map((t) => t.key))
      const hydrated: IndexPageItem[] = pg.items
        .map((i) => ({ ...i, thread: threadByKey.get(i.thread.key) ?? i.thread, tail: i.tail.map((t) => tailByKey.get(t.key) ?? t) }))
        .filter((i) => okThreads.has(i.thread.key))
        .map((i) => ({ ...i, tail: i.tail.filter((t) => okTails.has(t.key)) }))
      return { items: hydrated, page: pg.page, pages: pg.pages, total: q.data.folded.length, ...(q.data.truncated ? { truncated: true } : {}) }
    },
    enabled: !!q.data,
  })
  const loadMore = useCallback(async () => {
    if (!q.data?.truncated) return
    const more = await loadGlobalMore(arkivStore, q.data)
    qc2.setQueryData(['global'], more)
    void qc2.invalidateQueries({ queryKey: ['global-page'] })
  }, [q.data, qc2])
  return { index: q, page: pageQ, currentBlock: block.data ?? undefined, boards: q.data?.boards ?? new Map<string, ResolvedBoard>(), loadMore }
}

export function useThread(board: ResolvedBoard | null | undefined, rootKey: string | null, rootRaw?: RawEntity) {
  const block = useCurrentBlock()
  useChangeProbe(['thread'])
  useEntityWatch()
  return useQuery({
    queryKey: ['thread', board?.ref.slug, rootKey],
    queryFn: async () => {
      if (!board || !rootKey) return null
      const t = await loadThread(arkivStore, board, rootKey, block.data ?? undefined, ...(rootRaw ? [{ rootRaw }] as const : []))
      if (!t) return null
      // Root and replies arrive with payloads; verify each author's receipt offline.
      const clock = clockNow(block.data ?? undefined)
      const root = await verifyAuthors([t.root], clock)
      if (root.ok.length === 0) return { ...t, rootHidden: true as const, replies: [] as PostRecord[] }
      const replies = await verifyAuthors(t.replies, clock)
      return { ...t, rootHidden: false as const, replies: replies.ok }
    },
    enabled: !!board && !!rootKey,
    staleTime: 30_000,
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
