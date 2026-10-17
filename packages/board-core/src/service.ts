/**
 * Store-agnostic board reads. Clients supply an `EntityStore` over the Arkiv
 * SDK (web: browser http transport; dsh-board: node http transport) and get
 * identical index/thread results.
 */

import { bumpOrder, pageOf, tailOf, type FoldedThread } from './fold.ts'
import { gateFromAttributes, implicitSlug, parseEntity, sameGate } from './codec.ts'
import {
  DEFAULT_BUMP_LIMIT,
  DEFAULT_CAPACITY,
  DEFAULT_PAGE_SIZE,
  DEFAULT_POST_TTL_S,
  DEFAULT_THREAD_TTL_S,
  EIP155_TO_VARIANT,
  GRP_DEF,
  GRP_POST,
  GRP_THREAD,
  HAVEN_FULL_GROUPS,
  INDEX_TAIL_REPLIES,
  VARIANT_TO_EIP155,
} from './constants.ts'
import type { BoardDef, BoardGate, BoardRef, PostRecord, RawEntity, ThreadRecord } from './types.ts'

export type WhereClause = Array<[name: string, value: string | number]>

export interface QueryOptions {
  limit?: number
  /** Select payload bytes (index rows should not). */
  payload?: boolean
  cursor?: string
}

export interface QueryPage {
  entities: RawEntity[]
  cursor?: string
}

export interface EntityStore {
  query(where: WhereClause, opts?: QueryOptions): Promise<QueryPage>
  get(key: string, opts?: { payload?: boolean }): Promise<RawEntity | undefined>
  /**
   * Batch read by entity key (one `$key` OR-query per chunk on real stores).
   * Optional for legacy stores; hydration falls back to `get` only then.
   */
  getMany?(keys: string[], opts?: { payload?: boolean }): Promise<RawEntity[]>
}

/** HTTP 429 from the anonymous Arkiv RPC tier. Never swallowed as "missing". */
export class RateLimitError extends Error {
  readonly retryAfterS?: number
  readonly quotaUsedPercent?: number
  readonly resetsAt?: number
  constructor(message = 'Arkiv rate limit reached (anonymous tier)', opts: { retryAfterS?: number; quotaUsedPercent?: number; resetsAt?: number } = {}) {
    super(message)
    this.name = 'RateLimitError'
    if (opts.retryAfterS !== undefined) this.retryAfterS = opts.retryAfterS
    if (opts.quotaUsedPercent !== undefined) this.quotaUsedPercent = opts.quotaUsedPercent
    if (opts.resetsAt !== undefined) this.resetsAt = opts.resetsAt
  }
}

export function isRateLimitError(e: unknown): e is RateLimitError {
  if (e instanceof RateLimitError) return true
  if (typeof e !== 'object' || e === null) return false
  const o = e as { name?: unknown; status?: unknown; code?: unknown; message?: unknown }
  if (o.name === 'RateLimitError') return true
  if (o.status === 429 || o.code === 429) return true
  return typeof o.message === 'string' && (o.message.includes('ANON_COST_LIMITED') || /\b429\b/.test(o.message))
}

const PAGE = 100
/** Hard ceiling for any legacy unbounded scan. */
const MAX_ROWS = 2000
/** Keys per batched `$key` query: each extra chunk is another charged call. */
export const HYDRATE_CHUNK = 50
/** Rows scanned per query on index/global loads (1 charged call per query). */
export const SCAN_ROWS = 100

async function queryAll(store: EntityStore, where: WhereClause, opts: QueryOptions & { maxRows?: number } = {}): Promise<RawEntity[]> {
  return (await queryAllCounted(store, where, opts)).rows
}

async function queryAllCounted(store: EntityStore, where: WhereClause, opts: QueryOptions & { maxRows?: number } = {}): Promise<{ rows: RawEntity[]; truncated: boolean }> {
  const cap = opts.maxRows ?? MAX_ROWS
  const out: RawEntity[] = []
  let cursor: string | undefined
  let truncated = false
  while (out.length < cap) {
    const page = await store.query(where, { ...opts, limit: Math.min(opts.limit ?? PAGE, cap - out.length), ...(cursor ? { cursor } : {}) })
    out.push(...page.entities)
    if (out.length > cap || (out.length >= cap && page.cursor)) truncated = true
    if (!page.cursor || page.entities.length === 0) break
    cursor = page.cursor
  }
  return { rows: out.slice(0, cap), truncated }
}

async function getManyChunked(store: EntityStore, keys: string[], payload: boolean): Promise<RawEntity[]> {
  const uniq = [...new Set(keys.map((k) => k.toLowerCase()))]
  if (uniq.length === 0) return []
  if (store.getMany) {
    const out: RawEntity[] = []
    for (let i = 0; i < uniq.length; i += HYDRATE_CHUNK) {
      out.push(...(await store.getMany(uniq.slice(i, i + HYDRATE_CHUNK), { payload })))
    }
    return out
  }
  const rows = await Promise.all(uniq.map((k) => store.get(k, { payload })))
  return rows.filter((r): r is RawEntity => r !== undefined)
}

// ── Boards ──────────────────────────────────────────────────────────────

export async function loadBoards(store: EntityStore): Promise<BoardDef[]> {
  const rows = await queryAll(store, [['grp', GRP_DEF]], { payload: true, maxRows: SCAN_ROWS })
  const defs = rows.map((r) => parseEntity(r)).filter((r): r is BoardDef => r?.kind === 'def')
  // First writer wins per slug.
  const bySlug = new Map<string, BoardDef>()
  for (const d of defs.sort((a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : 1))) {
    if (!bySlug.has(d.board)) bySlug.set(d.board, d)
  }
  return [...bySlug.values()]
}

/** `gate:<chainId>:<token>:<threshold>` → BoardGate. */
export function parseGateSpec(spec: string): BoardGate | undefined {
  const m = /^gate:(\d+):(0x[0-9a-fA-F]{40}):(\d+)$/.exec(spec.trim())
  if (!m) return undefined
  const chain = EIP155_TO_VARIANT[Number(m[1])]
  if (!chain) return undefined
  const threshold = BigInt(m[3] as string)
  if (threshold <= 0n) return undefined
  return { chain, tokenAddress: (m[2] as string).toLowerCase(), threshold }
}

export function gateSpecOf(gate: BoardGate): string {
  return `gate:${VARIANT_TO_EIP155[gate.chain]}:${gate.tokenAddress}:${gate.threshold.toString()}`
}

export interface ResolvedBoard {
  ref: BoardRef
  def?: BoardDef
  bumpLimit: number
  capacity: number
  pageSize: number
  threadTtlS: number
  postTtlS: number
  defaults: { sealText: boolean; sealMedia: boolean }
  title: string
}

/** Resolve a slug or a `gate:` spec into a board with effective constants. */
export async function resolveBoard(store: EntityStore, slugOrGate: string): Promise<ResolvedBoard | undefined> {
  const boards = await loadBoards(store)
  const gate = parseGateSpec(slugOrGate)
  let def: BoardDef | undefined
  if (gate) def = boards.find((b) => sameGate(b.gate, gate))
  else def = boards.find((b) => b.board === slugOrGate)
  if (!def && !gate) return undefined
  return resolveFrom(def, def?.gate ?? (gate as BoardGate))
}

/** Effective board for a (definition?, gate) pair. Defaults apply when there is no definition. */
export function resolveFrom(def: BoardDef | undefined, gate: BoardGate): ResolvedBoard {
  const slug = def?.board ?? implicitSlug(gate)
  return {
    ref: { slug, gate },
    ...(def ? { def } : {}),
    bumpLimit: def?.bumpLimit ?? DEFAULT_BUMP_LIMIT,
    capacity: def?.capacity ?? DEFAULT_CAPACITY,
    pageSize: def?.pageSize ?? DEFAULT_PAGE_SIZE,
    threadTtlS: def?.ttl.thread_s ?? DEFAULT_THREAD_TTL_S,
    postTtlS: def?.ttl.post_s ?? DEFAULT_POST_TTL_S,
    defaults: def?.defaults ?? { sealText: true, sealMedia: true },
    title: def?.title ?? slug,
  }
}

// ── Index ───────────────────────────────────────────────────────────────

export interface BoardIndex {
  board: ResolvedBoard
  /** Folded, in bump order, capacity applied. */
  folded: FoldedThread[]
  threads: Map<string, ThreadRecord>
  posts: Map<string, PostRecord>
  /** True when a scan hit `SCAN_ROWS` and older rows were not read. */
  truncated?: boolean
  /** Current block if the store knows it (for expiry filtering). */
  currentBlock?: number
}

export async function loadRoots(store: EntityStore, board: BoardRef, opts: { payload?: boolean } = {}): Promise<ThreadRecord[]> {
  const ctx = { board }
  const own = await queryAll(store, [['grp', GRP_THREAD], ['board', board.slug]], { ...opts, maxRows: SCAN_ROWS })
  const havenRows = await Promise.all(
    HAVEN_FULL_GROUPS.map((g) =>
      queryAll(
        store,
        [
          ['grp', g],
          ['gate_token', board.gate.tokenAddress],
          ['gate_chain', VARIANT_TO_EIP155[board.gate.chain]],
        ],
        { ...opts, maxRows: SCAN_ROWS },
      ),
    ),
  )
  const rows = [...own, ...havenRows.flat()]
  const out: ThreadRecord[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const rec = parseEntity(r, ctx)
    if (rec?.kind !== 'thread' || seen.has(rec.key)) continue
    // Fairhaven threads must carry this board's gate too.
    if (!sameGate(rec.gate, board.gate)) continue
    seen.add(rec.key)
    out.push(rec)
  }
  return out
}

export async function loadReplies(store: EntityStore, board: BoardRef, opts: { payload?: boolean } = {}): Promise<PostRecord[]> {
  const rows = await queryAll(store, [['grp', GRP_POST], ['board', board.slug]], { ...opts, maxRows: SCAN_ROWS })
  const out: PostRecord[] = []
  for (const r of rows) {
    const rec = parseEntity(r, { board })
    if (rec?.kind !== 'post') continue
    if (!sameGate(rec.gate, board.gate)) continue
    out.push(rec)
  }
  return out
}

/** Drop records whose expiry block has passed, when the block height is known. */
export function dropExpired<T extends { expiresAt?: number }>(records: T[], currentBlock?: number): T[] {
  if (currentBlock === undefined) return records
  return records.filter((r) => r.expiresAt === undefined || r.expiresAt > currentBlock)
}

export async function loadIndex(store: EntityStore, board: ResolvedBoard, currentBlock?: number): Promise<BoardIndex> {
  const [rootsRaw, repliesRaw] = await Promise.all([loadRoots(store, board.ref), loadReplies(store, board.ref)])
  const roots = dropExpired(rootsRaw, currentBlock)
  const replies = dropExpired(repliesRaw, currentBlock)
  const folded = bumpOrder(roots, replies, { bumpLimit: board.bumpLimit, capacity: board.capacity })
  return {
    board,
    folded,
    threads: new Map(roots.map((t) => [t.key, t])),
    posts: new Map(replies.map((p) => [p.key, p])),
    ...(roots.length >= SCAN_ROWS || replies.length >= SCAN_ROWS ? { truncated: true } : {}),
    ...(currentBlock !== undefined ? { currentBlock } : {}),
  }
}

export interface IndexPageItem {
  thread: ThreadRecord
  folded: FoldedThread
  tail: PostRecord[]
  omitted: number
}

function pageItems(folded: readonly FoldedThread[], threads: Map<string, ThreadRecord>, posts: Map<string, PostRecord>, pageSize: number, page: number, tailN: number): { items: IndexPageItem[]; page: number; pages: number } {
  const { items, page: p, pages } = pageOf(folded, pageSize, page)
  const out: IndexPageItem[] = []
  for (const f of items) {
    const thread = threads.get(f.key)
    if (!thread) continue
    const tailKeys = tailOf(f, tailN)
    const tail = tailKeys.map((k) => posts.get(k)).filter((x): x is PostRecord => x !== undefined)
    out.push({ thread, folded: f, tail, omitted: Math.max(0, f.replyCount - tail.length) })
  }
  return { items: out, page: p, pages }
}

export function indexPage(index: BoardIndex, page: number, tailN: number = INDEX_TAIL_REPLIES): { items: IndexPageItem[]; page: number; pages: number } {
  return pageItems(index.folded, index.threads, index.posts, index.board.pageSize, page, tailN)
}

/** Fetch payloads for the OPs on a page (index rows are attributes-only). One batched `$key` query per `HYDRATE_CHUNK` keys, never one `getEntity` per row. */
export async function hydrateThreads(store: EntityStore, threads: ThreadRecord[], board: BoardRef): Promise<ThreadRecord[]> {
  const missing = threads.filter((t) => !t.payload)
  if (missing.length === 0) return threads
  const rows = await getManyChunked(store, missing.map((t) => t.key), true)
  const byKey = new Map(rows.map((r) => [r.key.toLowerCase(), r]))
  return threads.map((t) => {
    if (t.payload) return t
    const raw = byKey.get(t.key.toLowerCase())
    if (!raw) return t
    const rec = parseEntity(raw, { board })
    return rec?.kind === 'thread' ? rec : t
  })
}

/** Fetch payloads for tail posts on a page, batched like `hydrateThreads`. */
export async function hydratePosts(store: EntityStore, posts: PostRecord[], board: BoardRef): Promise<PostRecord[]> {
  const missing = posts.filter((p) => !p.payload)
  if (missing.length === 0) return posts
  const rows = await getManyChunked(store, missing.map((p) => p.key), true)
  const byKey = new Map(rows.map((r) => [r.key.toLowerCase(), r]))
  return posts.map((p) => {
    if (p.payload) return p
    const raw = byKey.get(p.key.toLowerCase())
    if (!raw) return p
    const rec = parseEntity(raw, { board })
    return rec?.kind === 'post' ? rec : p
  })
}

// ── Thread ──────────────────────────────────────────────────────────────

export interface LoadedThread {
  root: ThreadRecord
  replies: PostRecord[]
}

export async function loadThread(store: EntityStore, board: ResolvedBoard, rootKey: string, currentBlock?: number): Promise<LoadedThread | undefined> {
  const raw = await store.get(rootKey.toLowerCase(), { payload: true })
  if (!raw) return undefined
  const root = parseEntity(raw, { board: board.ref })
  if (root?.kind !== 'thread' || !sameGate(root.gate, board.ref.gate)) return undefined
  if (currentBlock !== undefined && root.expiresAt !== undefined && root.expiresAt <= currentBlock) return undefined
  const rows = await queryAll(store, [['grp', GRP_POST], ['root_ref', root.key]], { payload: true })
  const replies = dropExpired(
    rows
      .map((r) => parseEntity(r, { board: board.ref }))
      .filter((r): r is PostRecord => r?.kind === 'post' && r.board === board.ref.slug && sameGate(r.gate, board.ref.gate)),
    currentBlock,
  ).sort((a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : 1))
  return { root, replies }
}

/** Gate of any entity under the board, used to validate `root` arguments. */
export function gateOfRaw(e: RawEntity): BoardGate | undefined {
  return gateFromAttributes(e.attributes)
}

// ── Global feed ─────────────────────────────────────────────────────────

export function gateKey(g: BoardGate): string {
  return `${VARIANT_TO_EIP155[g.chain]}:${g.tokenAddress}:${g.threshold.toString()}`
}

export interface GlobalIndex {
  /** Bump order across every gate; one fold, so order is identical for every client. */
  folded: FoldedThread[]
  threads: Map<string, ThreadRecord>
  posts: Map<string, PostRecord>
  /** Effective board for each gate seen (definition or defaults), keyed by `gateKey`. */
  boards: Map<string, ResolvedBoard>
  pageSize: number
  /** True when a scan hit `SCAN_ROWS` and older rows were not read. */
  truncated?: boolean
  currentBlock?: number
}

export interface GlobalIndexOptions {
  currentBlock?: number
  /** Fold constants for the merged stream (boards keep their own on their own pages). */
  bumpLimit?: number
  capacity?: number
  pageSize?: number
}

export const GLOBAL_CAPACITY = 300

/**
 * Every thread on the network: Fairhaven threads on any board plus every
 * Haven media record that carries a gate, with replies attached to their
 * roots. A reader who holds nothing sees a frosted network; a reader who
 * holds some gates sees those threads open. Posting still happens on a
 * board, never "globally".
 */
export async function loadGlobalIndex(store: EntityStore, opts: GlobalIndexOptions = {}): Promise<GlobalIndex> {
  const defs = await loadBoards(store)
  const defByGate = new Map(defs.map((d) => [gateKey(d.gate), d]))
  const boards = new Map<string, ResolvedBoard>()
  const boardFor = (g: BoardGate): ResolvedBoard => {
    const k = gateKey(g)
    let b = boards.get(k)
    if (!b) {
      b = resolveFrom(defByGate.get(k), g)
      boards.set(k, b)
    }
    return b
  }

  // Bounded scan: 1 charged call per group (SCAN_ROWS), O(page) not O(network).
  // Older rows beyond the cap are not folded; `truncated` surfaces that in UI.
  const [ownRows, postRows, ...havenRows] = await Promise.all([
    queryAll(store, [['grp', GRP_THREAD]], { maxRows: SCAN_ROWS }),
    queryAll(store, [['grp', GRP_POST]], { maxRows: SCAN_ROWS }),
    ...HAVEN_FULL_GROUPS.map((g) => queryAll(store, [['grp', g]], { maxRows: SCAN_ROWS })),
  ])
  const truncated = ownRows.length >= SCAN_ROWS || postRows.length >= SCAN_ROWS || havenRows.some((r) => r.length >= SCAN_ROWS)

  const threads = new Map<string, ThreadRecord>()
  for (const r of ownRows) {
    const rec = parseEntity(r)
    if (rec?.kind !== 'thread') continue
    // Re-home onto the effective board for its gate (a thread may name a slug with no definition).
    const b = boardFor(rec.gate)
    threads.set(rec.key, rec.board === b.ref.slug ? rec : { ...rec, board: b.ref.slug })
  }
  for (const r of havenRows.flat()) {
    const gate = gateFromAttributes(r.attributes)
    if (!gate) continue
    const b = boardFor(gate)
    const rec = parseEntity(r, { board: b.ref })
    if (rec?.kind === 'thread' && !threads.has(rec.key)) threads.set(rec.key, rec)
  }

  const posts = new Map<string, PostRecord>()
  for (const r of postRows) {
    const rec = parseEntity(r)
    if (rec?.kind !== 'post') continue
    const root = threads.get(rec.rootRef)
    if (!root || !sameGate(rec.gate, root.gate)) continue
    posts.set(rec.key, rec)
  }

  const liveThreads = dropExpired([...threads.values()], opts.currentBlock)
  const liveSet = new Set(liveThreads.map((t) => t.key))
  const livePosts = dropExpired([...posts.values()], opts.currentBlock).filter((p) => liveSet.has(p.rootRef))
  const folded = bumpOrder(liveThreads, livePosts, { bumpLimit: opts.bumpLimit ?? DEFAULT_BUMP_LIMIT, capacity: opts.capacity ?? GLOBAL_CAPACITY })
  return {
    folded,
    threads: new Map(liveThreads.map((t) => [t.key, t])),
    posts: new Map(livePosts.map((p) => [p.key, p])),
    boards,
    pageSize: opts.pageSize ?? DEFAULT_PAGE_SIZE,
    ...(truncated ? { truncated: true } : {}),
    ...(opts.currentBlock !== undefined ? { currentBlock: opts.currentBlock } : {}),
  }
}

export function globalPage(index: GlobalIndex, page: number, tailN: number = INDEX_TAIL_REPLIES): { items: IndexPageItem[]; page: number; pages: number } {
  return pageItems(index.folded, index.threads, index.posts, index.pageSize, page, tailN)
}

/** The effective board a thread belongs to within a global index. */
export function boardOf(index: GlobalIndex, thread: ThreadRecord): ResolvedBoard {
  return index.boards.get(gateKey(thread.gate)) ?? resolveFrom(undefined, thread.gate)
}
