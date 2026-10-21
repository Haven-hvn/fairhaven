/**
 * Relevance checks for the shared entity watch. The watch is chain-wide (the
 * SDK offers no server-side filter), so most events are foreign: these pure
 * checks decide whether a fetched row or a deletion may reload a view, so a
 * burst elsewhere on chain costs no charged query here.
 */

import type { RawEntity } from '@fairhaven/board-core'

/** `haven.board.def` (a declared board). Mirrors board-core `GRP_DEF`. */
const DEF_GRP = 'haven.board.def'

/** Groups that can fold into a board/global index. Mirrors board-core BOARD_GROUPS + HAVEN_FULL_GROUPS. */
const BOARD_GRPS: ReadonlySet<string> = new Set([DEF_GRP, 'haven.board.thread', 'haven.board.post', 'haven.video.full', 'haven.audio.full', 'haven.image.full', 'haven.text.full', 'haven.file.full'])

function grpOf(raw: RawEntity): string | undefined {
  const g: unknown = raw.attributes?.grp
  return typeof g === 'string' ? g : undefined
}

/** Whether a fetched row can fold into a cached index at all. */
export function isBoardRow(raw: RawEntity): boolean {
  const g = grpOf(raw)
  return g !== undefined && BOARD_GRPS.has(g)
}

/** Whether any fetched row is a board definition (the `['boards']` reload trigger). */
export function rowsIncludeDef(rows: readonly RawEntity[]): boolean {
  return rows.some((r) => grpOf(r) === DEF_GRP)
}

/** The open thread a watch event must touch before it may reload `['thread']`. */
export interface OpenThread {
  rootKey: string
  keys: ReadonlySet<string>
}

export function openThreadOf(data: { root: { key: string }; replies: readonly { key: string }[] } | undefined | null): OpenThread | undefined {
  if (!data) return undefined
  const rootKey = data.root.key.toLowerCase()
  return { rootKey, keys: new Set([rootKey, ...data.replies.map((r) => r.key.toLowerCase())]) }
}

/** Whether one entity key is the open root or one of its cached replies. */
export function keyTouchesThread(key: string, open: readonly OpenThread[]): boolean {
  const k = key.toLowerCase()
  return open.some((o) => o.keys.has(k))
}

/** Whether any fetched row is the open root, a cached reply, or a new reply to the open root. */
export function rowsTouchThread(rows: readonly RawEntity[], open: readonly OpenThread[]): boolean {
  if (open.length === 0) return false
  return rows.some((raw) => {
    if (keyTouchesThread(raw.key, open)) return true
    const rootRef: unknown = raw.attributes?.root_ref
    return typeof rootRef === 'string' && open.some((o) => o.rootKey === rootRef.toLowerCase())
  })
}
