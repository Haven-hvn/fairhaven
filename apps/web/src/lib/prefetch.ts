'use client'

/**
 * Media prefetch + open pipeline. Near-viewport (or hovered) media is
 * fetched and pre-opened in the background so entitled views render the real
 * thing straight away; results land in the open cache (`lib/open-cache`).
 * Explicit clicks reuse the same task machinery with progress + cancel.
 */

import { openAny, type MediaField, type ThreadRecord } from '@fairhaven/board-core'
import { hasUnlocked, parseGateJson } from './aol'
import { fetchResumable } from './retrieve'
import { fetchSealedBytes as fetchSealed } from './sealed-fetch'
import { setOpened, getOpened, getSealed, setSealed, deleteSealed } from './open-cache'
import { env } from './env'

export type Phase = { s: 'fetching'; received: number; total?: number } | { s: 'opening'; chunk: number; chunks: number }

export interface OpenTask {
  phase: Phase
  promise: Promise<Uint8Array>
  subscribe: (cb: (p: Phase) => void) => () => void
  cancel: () => void
}

function locatorOf(media: MediaField): string {
  return media.piece ?? media.fcid ?? ''
}

const tasks = new Map<string, OpenTask>()

/** Sealed media at or below this size may prefetch; larger files wait for a click. */
export const PREFETCH_MAX_BYTES = 8 * 1024 * 1024
const MAX_IDLE_PREFETCHES = 2
const idle = new Set<string>()

/** True when the viewer can open this media right now (clear, or unlocked). */
export function canOpenNow(thread: ThreadRecord, media: MediaField): boolean {
  if (media.piece === undefined) return true
  const gateJson = thread.payload?.gate
  if (!gateJson) return false
  const g = parseGateJson(gateJson)
  if (!g || g.version !== 3 || g.epoch === undefined) return false
  return hasUnlocked(g.gate, g.epoch)
}

/** The live task for this media, if one is running. */
export function inFlight(media: MediaField): OpenTask | undefined {
  return tasks.get(locatorOf(media))
}

async function fetchClearBytes(media: MediaField, signal: AbortSignal, onPhase: (p: Phase) => void): Promise<Uint8Array> {
  if (!media.fcid) throw new Error('no content reference')
  if (!env.ipfsGateway) throw new Error('clear media lives on IPFS — open it in haven-dapp')
  // Resumable: a dropped gateway connection resumes mid-file, not from zero.
  return fetchResumable(`${env.ipfsGateway}/ipfs/${encodeURIComponent(media.fcid)}`, {
    signal,
    onProgress: (received, total) => onPhase({ s: 'fetching', received, ...(total !== undefined ? { total } : {}) }),
  })
}

async function fetchSealedBytes(media: MediaField, thread: ThreadRecord, signal: AbortSignal, onPhase: (p: Phase) => void, forceStorage = false): Promise<Uint8Array> {
  if (!media.piece) throw new Error('no piece reference')
  onPhase({ s: 'fetching', received: 0, ...(media.size ? { total: media.size } : {}) })
  if (signal.aborted) throw new DOMException('Fetch cancelled', 'AbortError')
  const gateChain = thread.payload?.gate ? parseGateJson(thread.payload.gate)?.gate.chain : undefined
  const bytes = await fetchSealed({
    piece: media.piece,
    owner: thread.owner,
    ...(gateChain ? { gateChain } : {}),
    source: 'fairhaven-web',
    withCdn: env.synapseEnableCdn,
    ...(forceStorage ? { forceStorage: true } : {}),
    signal,
    onProgress: (received, total) => onPhase({ s: 'fetching', received, total: media.size ?? total }),
  })
  onPhase({ s: 'fetching', received: bytes.length, ...(media.size ? { total: media.size } : { total: bytes.length }) })
  return bytes
}

export function describeError(e: unknown): string {
  if (e instanceof DOMException) return e.message ? `${e.name}: ${e.message}` : e.name
  if (e instanceof Error) return e.message || e.name
  return String(e)
}

async function openMediaBytes(thread: ThreadRecord, media: MediaField, stored: Uint8Array, onPhase: (p: Phase) => void, signal: AbortSignal): Promise<Uint8Array> {
  if (media.piece === undefined) return stored
  const gateJson = thread.payload?.gate
  if (!gateJson) throw new Error('sealed media without a gate')
  // Text and media share one AES key per post: unwrap via the post's gate
  // record, then open the framed media bytes with progress.
  const { aesKeyForGate } = await import('./aol')
  onPhase({ s: 'opening', chunk: 0, chunks: 0 })
  const aesKey = await aesKeyForGate(gateJson)
  if (signal.aborted) throw new DOMException('Open cancelled', 'AbortError')
  try {
    return await openAny(stored, aesKey, (p) => onPhase({ s: 'opening', chunk: p.chunk, chunks: p.chunks }), signal)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new Error(`opening failed: ${describeError(e)}`)
  }
}

/** Explicit open with progress + cancel. Dedicated to one (thread, media). */
export function openNow(thread: ThreadRecord, media: MediaField): OpenTask {
  const locator = locatorOf(media)
  const existing = tasks.get(locator)
  if (existing) return existing
  const ctrl = new AbortController()
  const subs = new Set<(p: Phase) => void>()
  let phase: Phase = { s: 'fetching', received: 0 }
  const emit = (p: Phase) => {
    phase = p
    for (const cb of subs) cb(p)
  }
  const task: OpenTask = {
    get phase() {
      return phase
    },
    promise: (async () => {
      try {
        let stored = media.piece !== undefined ? getSealed(locator) : undefined
        if (!stored) {
          stored = media.piece !== undefined
            ? await fetchSealedBytes(media, thread, ctrl.signal, emit)
            : await fetchClearBytes(media, ctrl.signal, emit)
          if (media.piece !== undefined) setSealed(locator, stored)
        } else {
          emit({ s: 'fetching', received: stored.length, total: stored.length })
        }
        let opened: Uint8Array
        try {
          opened = await openMediaBytes(thread, media, stored, emit, ctrl.signal)
        } catch (e) {
          // A resolved-URL fetch can return bytes the GCM open rejects
          // (bad Range resume, CDN artifact). One retry through the
          // StorageManager's validating download, then give up.
          if (media.piece === undefined || (e instanceof DOMException && e.name === 'AbortError')) throw e
          deleteSealed(locator)
          const fresh = await fetchSealedBytes(media, thread, ctrl.signal, emit, true)
          setSealed(locator, fresh)
          opened = await openMediaBytes(thread, media, fresh, emit, ctrl.signal)
        }
        setOpened(locator, opened)
        return opened
      } finally {
        tasks.delete(locator)
        idle.delete(locator)
      }
    })(),
    subscribe: (cb) => {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
    cancel: () => ctrl.abort(),
  }
  tasks.set(locator, task)
  return task
}

/** Background prefetch: open when entitled, swallow failures, stay cached. */
export function prefetch(thread: ThreadRecord, media: MediaField): void {
  const locator = locatorOf(media)
  if (!locator || getOpened(locator) || tasks.has(locator)) return
  if (!canOpenNow(thread, media)) return
  if (media.piece !== undefined && (media.size ?? 0) > PREFETCH_MAX_BYTES) return
  if (idle.size >= MAX_IDLE_PREFETCHES) return
  idle.add(locator)
  const task = openNow(thread, media)
  task.promise.catch(() => undefined)
}

/** Cancel a background (idle/hover) open; explicit opens are left alone. */
export function cancelIdle(media: MediaField): void {
  const locator = locatorOf(media)
  if (!idle.has(locator)) return
  tasks.get(locator)?.cancel()
}
