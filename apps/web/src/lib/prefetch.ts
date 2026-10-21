'use client'

/**
 * Media prefetch + open pipeline. Near-viewport (or hovered) media is
 * fetched and pre-opened in the background so entitled views render the real
 * thing straight away; results land in the open cache (`lib/open-cache`).
 * Explicit clicks reuse the same task machinery with progress + cancel.
 */

import { openAny, type MediaField, type ThreadRecord } from '@fairhaven/board-core'
import { hasUnlocked, parseGateJson } from './aol'
import { fetchResumable, withRetry } from './retrieve'
import { setOpened, getOpened } from './open-cache'
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

async function fetchSealedBytes(media: MediaField, signal: AbortSignal, onPhase: (p: Phase) => void): Promise<Uint8Array> {
  if (!media.piece) throw new Error('no piece reference')
  const { Synapse } = await import('@filoz/synapse-sdk')
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
  const synapse = Synapse.create({ account: privateKeyToAccount(generatePrivateKey()), source: 'fairhaven-web', withCDN: env.synapseEnableCdn })
  onPhase({ s: 'fetching', received: 0, ...(media.size ? { total: media.size } : {}) })
  if (signal.aborted) throw new DOMException('Fetch cancelled', 'AbortError')
  // One retry with backoff: piece providers drop connections on large files.
  const piece = media.piece
  const bytes = await withRetry(() => synapse.storage.download({ pieceCid: piece, withCDN: env.synapseEnableCdn }), { signal, attempts: 2 })
  onPhase({ s: 'fetching', received: bytes.length, ...(media.size ? { total: media.size } : { total: bytes.length }) })
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer)
}

async function openMediaBytes(thread: ThreadRecord, media: MediaField, stored: Uint8Array, onPhase: (p: Phase) => void, signal: AbortSignal): Promise<Uint8Array> {
  if (media.piece === undefined) return stored
  const gateJson = thread.payload?.gate
  if (!gateJson) throw new Error('sealed media without a gate')
  // Text and media share one AES key per post: unwrap via the post's gate
  // record, then open the framed media bytes with progress.
  const { aesKeyForGate } = await import('./aol')
  const aesKey = await aesKeyForGate(gateJson)
  if (signal.aborted) throw new DOMException('Open cancelled', 'AbortError')
  return openAny(stored, aesKey, (p) => onPhase({ s: 'opening', chunk: p.chunk, chunks: p.chunks }), signal)
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
        const stored = media.piece !== undefined
          ? await fetchSealedBytes(media, ctrl.signal, emit)
          : await fetchClearBytes(media, ctrl.signal, emit)
        const opened = await openMediaBytes(thread, media, stored, emit, ctrl.signal)
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
