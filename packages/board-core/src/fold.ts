/**
 * Bump-order fold. Normative definition lives in docs/SPEC.md §4 and is
 * pinned by tests/fixtures/board-order-vectors.json.
 *
 * Position = (createdAt, key) of the most recent qualifying reply, else of the
 * root. Qualifying = not `noBump` and within the first `bumpLimit` replies.
 * No wall clock, no engagement signal. Ties inside a block break on key.
 */

export interface FoldThread {
  key: string
  createdAt: number
}

export interface FoldPost {
  key: string
  rootRef: string
  noBump: boolean
  createdAt: number
}

export interface FoldParams {
  bumpLimit: number
  capacity: number
}

export interface FoldedThread {
  key: string
  /** Block height of the bump position. */
  bumpAt: number
  /** Key that set the bump position (root or reply). */
  bumpKey: string
  replyCount: number
  /** All reply keys in (createdAt, key) order. */
  replies: string[]
}

export function compareEvents(a: { createdAt: number; key: string }, b: { createdAt: number; key: string }): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

export function bumpOrder(threads: readonly FoldThread[], posts: readonly FoldPost[], params: FoldParams): FoldedThread[] {
  const byKey = new Map<string, FoldedThread>()
  for (const t of threads) {
    const key = t.key.toLowerCase()
    if (byKey.has(key)) continue
    byKey.set(key, { key, bumpAt: t.createdAt, bumpKey: key, replyCount: 0, replies: [] })
  }

  const sorted = [...posts].map((p) => ({ ...p, key: p.key.toLowerCase(), rootRef: p.rootRef.toLowerCase() })).sort(compareEvents)
  const seen = new Set<string>()
  for (const p of sorted) {
    if (seen.has(p.key)) continue
    seen.add(p.key)
    const t = byKey.get(p.rootRef)
    if (!t) continue
    t.replyCount += 1
    t.replies.push(p.key)
    if (p.noBump || t.replyCount > params.bumpLimit) continue
    t.bumpAt = p.createdAt
    t.bumpKey = p.key
  }

  const ordered = [...byKey.values()].sort((a, b) => -compareEvents({ createdAt: a.bumpAt, key: a.bumpKey }, { createdAt: b.bumpAt, key: b.bumpKey }))
  return ordered.slice(0, Math.max(0, params.capacity))
}

export function pageOf<T>(items: readonly T[], pageSize: number, page: number): { items: T[]; page: number; pages: number } {
  const size = Math.max(1, pageSize)
  const pages = Math.max(1, Math.ceil(items.length / size))
  const p = Math.min(Math.max(1, page), pages)
  return { items: items.slice((p - 1) * size, p * size), page: p, pages }
}

/** Head-and-tail digest: the last `n` reply keys of a folded thread. */
export function tailOf(t: FoldedThread, n: number): string[] {
  return n <= 0 ? [] : t.replies.slice(-n)
}
