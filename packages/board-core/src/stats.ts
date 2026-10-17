/**
 * Simple statistics, computed client-side from the same records the index
 * uses. Haven records no read events anywhere, so every number here is a
 * WRITE-side fact that is already public on Arkiv: counts, times, sealing,
 * media types. Nothing is sent anywhere; nothing is stored.
 *
 * Deliberately absent: per-address leaderboards of other people. Post counts
 * per address are computable by anyone, but ranking strangers by volume is a
 * surveillance affordance the board does not need. "You" is the only
 * per-address view.
 */

import { ENUM_TO_MIME, SEALED_MEDIA, SEALED_TEXT } from './constants.ts'
import { blockToUnix, type BlockClock } from './time.ts'
import type { BoardGate, PostRecord, ThreadRecord } from './types.ts'

export interface DayBucket {
  /** YYYY-MM-DD (UTC). */
  day: string
  threads: number
  replies: number
}

export interface BoardStats {
  threads: number
  replies: number
  posts: number
  /** Distinct owner addresses that wrote anything. */
  posters: number
  /** Thread roots published by other Haven apps. */
  havenRoots: number
  /** Posts with sealed text / total posts (0..1). */
  sealedTextShare: number
  /** Threads with sealed media / threads with media (0..1), NaN-safe → 0. */
  sealedMediaShare: number
  threadsWithMedia: number
  /** mime label → count across thread roots. */
  mediaMix: Array<{ mime: string; count: number }>
  repliesPerThread: { median: number; max: number; silent: number }
  /** Posts in the last 24 h and 7 d (by block clock). */
  last24h: number
  last7d: number
  /** Threads expiring within 24 h. */
  expiringSoon: number
  /** Oldest live thread age in seconds. */
  oldestThreadAgeS: number
  byDay: DayBucket[]
}

export interface MyStats {
  address: string
  threads: number
  replies: number
  sealedTextShare: number
  noBumpReplies: number
  firstPostUnix?: number
  lastPostUnix?: number
  /** Threads you started that got at least one reply from someone else. */
  threadsWithOthersReplies: number
  /** Replies others made in threads you started. */
  repliesReceived: number
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2
}

function dayOf(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10)
}

export function computeBoardStats(roots: readonly ThreadRecord[], replies: readonly PostRecord[], clock: BlockClock, opts: { days?: number } = {}): BoardStats {
  const days = opts.days ?? 14
  const nowUnix = clock.observedAtUnix
  const t = (block: number) => blockToUnix(block, clock)
  const posters = new Set<string>()
  const repliesByRoot = new Map<string, number>()
  let sealedText = 0
  let threadsWithMedia = 0
  let sealedMedia = 0
  let last24h = 0
  let last7d = 0
  let expiringSoon = 0
  let oldest = nowUnix
  const mix = new Map<string, number>()
  const buckets = new Map<string, DayBucket>()
  for (let i = days - 1; i >= 0; i--) {
    const d = dayOf(nowUnix - i * 86400)
    buckets.set(d, { day: d, threads: 0, replies: 0 })
  }
  const bump = (unix: number, kind: 'threads' | 'replies') => {
    const b = buckets.get(dayOf(unix))
    if (b) b[kind] += 1
    const age = nowUnix - unix
    if (age <= 86400) last24h++
    if (age <= 7 * 86400) last7d++
  }

  for (const r of roots) {
    posters.add(r.owner)
    repliesByRoot.set(r.key, 0)
    if (r.sealed & SEALED_TEXT) sealedText++
    if (r.mime !== 0 || r.payload?.media) {
      threadsWithMedia++
      if (r.sealed & SEALED_MEDIA) sealedMedia++
      const label = ENUM_TO_MIME[r.mime] ?? (r.mime === 0 ? 'unknown' : `mime ${r.mime}`)
      mix.set(label, (mix.get(label) ?? 0) + 1)
    }
    const created = t(r.createdAt)
    if (created < oldest) oldest = created
    bump(created, 'threads')
    if (r.expiresAt !== undefined && (r.expiresAt - clock.currentBlock) * (clock.blockTimeS ?? 2) <= 86400) expiringSoon++
  }
  for (const p of replies) {
    posters.add(p.owner)
    if (p.sealed & SEALED_TEXT) sealedText++
    repliesByRoot.set(p.rootRef, (repliesByRoot.get(p.rootRef) ?? 0) + 1)
    bump(t(p.createdAt), 'replies')
  }
  const perThread = roots.map((r) => repliesByRoot.get(r.key) ?? 0)
  const posts = roots.length + replies.length
  return {
    threads: roots.length,
    replies: replies.length,
    posts,
    posters: posters.size,
    havenRoots: roots.filter((r) => r.source === 'haven').length,
    sealedTextShare: posts ? sealedText / posts : 0,
    sealedMediaShare: threadsWithMedia ? sealedMedia / threadsWithMedia : 0,
    threadsWithMedia,
    mediaMix: [...mix.entries()].map(([mime, count]) => ({ mime, count })).sort((a, b) => b.count - a.count),
    repliesPerThread: { median: median(perThread), max: Math.max(0, ...perThread), silent: perThread.filter((n) => n === 0).length },
    last24h,
    last7d,
    expiringSoon,
    oldestThreadAgeS: roots.length ? Math.max(0, nowUnix - oldest) : 0,
    byDay: [...buckets.values()],
  }
}

export function computeMyStats(address: string, roots: readonly ThreadRecord[], replies: readonly PostRecord[], clock: BlockClock): MyStats {
  const me = address.toLowerCase()
  const t = (block: number) => blockToUnix(block, clock)
  const mine = [...roots.filter((r) => r.owner === me), ...replies.filter((p) => p.owner === me)]
  const myRoots = new Set(roots.filter((r) => r.owner === me).map((r) => r.key))
  const received = replies.filter((p) => myRoots.has(p.rootRef) && p.owner !== me)
  const times = mine.map((m) => t(m.createdAt))
  const sealed = mine.filter((m) => m.sealed & SEALED_TEXT).length
  return {
    address: me,
    threads: myRoots.size,
    replies: mine.length - myRoots.size,
    sealedTextShare: mine.length ? sealed / mine.length : 0,
    noBumpReplies: replies.filter((p) => p.owner === me && p.noBump).length,
    ...(times.length ? { firstPostUnix: Math.min(...times), lastPostUnix: Math.max(...times) } : {}),
    threadsWithOthersReplies: new Set(received.map((p) => p.rootRef)).size,
    repliesReceived: received.length,
  }
}

/** Membership summary for the "boards you can read" list. */
export interface BoardMembership {
  slug: string
  title: string
  gate: BoardGate
  balance: bigint
  member: boolean
}

/** Text bar for terminals and dense UIs: `▇▇▇▇▁▁` scaled to `width`. */
export function sparkline(values: readonly number[], width = 8): string {
  const max = Math.max(1, ...values)
  const glyphs = '▁▂▃▄▅▆▇█'
  return values.map((v) => glyphs[Math.min(glyphs.length - 1, Math.round((v / max) * (glyphs.length - 1)))]).join('').slice(-width * 4)
}
