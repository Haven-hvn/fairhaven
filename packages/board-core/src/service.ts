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

/** Equality clauses, ANDed. An array value is an OR over that attribute (one charged call, not N). */
export type WhereClause = Array<[name: string, value: string | number | readonly string[]]>

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
  /** OR of AND-clause sets in one charged call. A `$key` clause matches the entity key. */
  queryOr?(clauses: WhereClause[], opts?: QueryOptions): Promise<QueryPage>
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

export const ROOT_GROUPS: readonly string[] = [GRP_THREAD, ...HAVEN_FULL_GROUPS]

async function queryAllCounted(store: EntityStore, where: WhereClause, opts: QueryOptions & { maxRows?: number; cursor?: string } = {}): Promise<{ rows: RawEntity[]; truncated: boolean; cursor?: string }> {
  const cap = opts.maxRows ?? MAX_ROWS
  const out: RawEntity[] = []
  let cursor: string | undefined = opts.cursor
  let truncated = false
  while (out.length < cap) {
    const page = await store.query(where, { ...opts, limit: Math.min(opts.limit ?? PAGE, cap - out.length), ...(cursor ? { cursor } : {}) })
    out.push(...page.entities)
    if (out.length > cap || (out.length >= cap && page.cursor)) truncated = true
    if (!page.cursor || page.entities.length === 0) { cursor = page.cursor; break }
    cursor = page.cursor
  }
  return { rows: out.slice(0, cap), truncated, ...(truncated && cursor ? { cursor } : {}) }
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
  // Implicit slugs (`g.<chainId>.<token prefix>`) name a defined board by its gate.
  else def = boards.find((b) => b.board === slugOrGate) ?? boards.find((b) => implicitSlug(b.gate) === slugOrGate)
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
  /** Continuation cursors for `loadIndexMore` (roots scan, replies scan). */
  cursor?: string
  postCursor?: string
  /** Current block if the store knows it (for expiry filtering). */
  currentBlock?: number
}

/** One OR-query over every root group; rows are filtered to the board's gate/slug client-side. */
async function queryRoots(store: EntityStore, opts: QueryOptions & { maxRows?: number; cursor?: string } = {}) {
  return queryAllCounted(store, [['grp', ROOT_GROUPS]], opts)
}

export async function loadRoots(store: EntityStore, board: BoardRef, opts: { payload?: boolean } = {}): Promise<ThreadRecord[]> {
  const { rows } = await queryRoots(store, { ...opts, maxRows: SCAN_ROWS })
  return parseRoots(rows, board)
}

export function parseRoots(rows: RawEntity[], board: BoardRef): ThreadRecord[] {
  const ctx = { board }
  const out: ThreadRecord[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const rec = parseEntity(r, ctx)
    if (rec?.kind !== 'thread' || seen.has(rec.key)) continue
    // Fairhaven threads must name this board; Haven records must carry its gate.
    if (rec.source === 'board' && rec.board !== board.slug) continue
    if (!sameGate(rec.gate, board.gate)) continue
    seen.add(rec.key)
    out.push(rec)
  }
  return out
}

export function parseReplies(rows: RawEntity[], board: BoardRef): PostRecord[] { return parseRepliesFor(rows, board) }
function parseRepliesFor(rows: RawEntity[], board: BoardRef): PostRecord[] {
  const out: PostRecord[] = []
  for (const r of rows) {
    const rec = parseEntity(r, { board })
    if (rec?.kind !== 'post') continue
    if (!sameGate(rec.gate, board.gate)) continue
    out.push(rec)
  }
  return out
}

export async function loadReplies(store: EntityStore, board: BoardRef, opts: { payload?: boolean } = {}): Promise<PostRecord[]> {
  const rows = await queryAll(store, [['grp', GRP_POST], ['board', board.slug]], { ...opts, maxRows: SCAN_ROWS })
  return parseRepliesFor(rows, board)
}

/** Drop records whose expiry block has passed, when the block height is known. */
export function dropExpired<T extends { expiresAt?: number }>(records: T[], currentBlock?: number): T[] {
  if (currentBlock === undefined) return records
  return records.filter((r) => r.expiresAt === undefined || r.expiresAt > currentBlock)
}

export async function loadIndex(store: EntityStore, board: ResolvedBoard, currentBlock?: number): Promise<BoardIndex> {
  const [rootsRes, repliesRes] = await Promise.all([
    queryRoots(store, { maxRows: SCAN_ROWS }),
    queryAllCounted(store, [['grp', GRP_POST], ['board', board.ref.slug]], { maxRows: SCAN_ROWS }),
  ])
  const roots = dropExpired(parseRoots(rootsRes.rows, board.ref), currentBlock)
  const replies = dropExpired(parseRepliesFor(repliesRes.rows, board.ref), currentBlock)
  const folded = bumpOrder(roots, replies, { bumpLimit: board.bumpLimit, capacity: board.capacity })
  const truncated = rootsRes.truncated || repliesRes.truncated
  return {
    board,
    folded,
    threads: new Map(roots.map((t) => [t.key, t])),
    posts: new Map(replies.map((p) => [p.key, p])),
    ...(truncated ? { truncated: true } : {}),
    ...(rootsRes.cursor ? { cursor: rootsRes.cursor } : {}),
    ...(repliesRes.cursor ? { postCursor: repliesRes.cursor } : {}),
    ...(currentBlock !== undefined ? { currentBlock } : {}),
  }
}

function refoldBoard(index: BoardIndex, threads: Map<string, ThreadRecord>, posts: Map<string, PostRecord>, extra: Partial<BoardIndex> = {}): BoardIndex {
  const liveThreads = dropExpired([...threads.values()], index.currentBlock)
  const liveSet = new Set(liveThreads.map((x) => x.key))
  const livePosts = dropExpired([...posts.values()], index.currentBlock).filter((x) => liveSet.has(x.rootRef))
  return { ...index, ...extra, threads: new Map(liveThreads.map((x) => [x.key, x])), posts: new Map(livePosts.map((x) => [x.key, x])), folded: bumpOrder(liveThreads, livePosts, { bumpLimit: index.board.bumpLimit, capacity: index.board.capacity }) }
}

/** Fetch the next scan window (roots + replies) and fold it in. No-op when not truncated. */
export async function loadIndexMore(store: EntityStore, index: BoardIndex): Promise<BoardIndex> {
  if (!index.truncated) return index
  const [rootsRes, repliesRes] = await Promise.all([
    index.cursor ? queryRoots(store, { maxRows: SCAN_ROWS, cursor: index.cursor }) : Promise.resolve(undefined),
    index.postCursor ? queryAllCounted(store, [['grp', GRP_POST], ['board', index.board.ref.slug]], { maxRows: SCAN_ROWS, cursor: index.postCursor }) : Promise.resolve(undefined),
  ])
  const threads = new Map(index.threads)
  for (const r of rootsRes ? parseRoots(rootsRes.rows, index.board.ref) : []) threads.set(r.key, r)
  const posts = new Map(index.posts)
  for (const r of repliesRes ? parseRepliesFor(repliesRes.rows, index.board.ref) : []) posts.set(r.key, r)
  const truncated = Boolean(rootsRes?.truncated || repliesRes?.truncated)
  const out = refoldBoard(index, threads, posts)
  delete out.truncated; delete out.cursor; delete out.postCursor
  if (truncated) out.truncated = true
  if (rootsRes?.cursor) out.cursor = rootsRes.cursor
  if (repliesRes?.cursor) out.postCursor = repliesRes.cursor
  return out
}

/** Incremental subscription update: insert/replace one raw entity, refold. Returns the same index when irrelevant. */
export function applyEntityToBoardIndex(index: BoardIndex, raw: RawEntity): BoardIndex {
  const rec = parseEntity(raw, { board: index.board.ref })
  if (!rec) return index
  const threads = new Map(index.threads)
  const posts = new Map(index.posts)
  if (rec.kind === 'thread') {
    if (rec.source === 'board' && rec.board !== index.board.ref.slug) return index
    if (!sameGate(rec.gate, index.board.ref.gate)) return index
    threads.set(rec.key, rec)
  } else if (rec.kind === 'post') {
    if (rec.board !== index.board.ref.slug || !sameGate(rec.gate, index.board.ref.gate)) return index
    posts.set(rec.key, rec)
  } else return index
  return refoldBoard(index, threads, posts)
}

export function removeEntityFromBoardIndex(index: BoardIndex, key: string): BoardIndex {
  const k = key.toLowerCase()
  if (!index.threads.has(k) && !index.posts.has(k)) return index
  const threads = new Map(index.threads); threads.delete(k)
  const posts = new Map(index.posts); posts.delete(k)
  return refoldBoard(index, threads, posts)
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

/** One missing-payload fetch shared across boards, parsed per board. */
async function fetchMissing(store: EntityStore, keys: string[]): Promise<Map<string, RawEntity>> {
  const rows = await getManyChunked(store, keys, true)
  return new Map(rows.map((r) => [r.key.toLowerCase(), r]))
}

/**
 * Hydrate threads spanning several boards (a global page) with ONE batched
 * `$key` fetch for every missing payload, instead of one fetch per board.
 * Returns hydrated records by lowercase entity key; inputs that stay
 * payload-less are omitted.
 */
export async function hydrateThreadsAcrossBoards(store: EntityStore, groups: ReadonlyArray<{ board: BoardRef; threads: readonly ThreadRecord[] }>): Promise<Map<string, ThreadRecord>> {
  const missing: string[] = []
  for (const g of groups) for (const t of g.threads) if (!t.payload) missing.push(t.key)
  const out = new Map<string, ThreadRecord>()
  if (missing.length === 0) return out
  const byKey = await fetchMissing(store, missing)
  for (const g of groups) {
    for (const t of g.threads) {
      if (t.payload) continue
      const raw = byKey.get(t.key.toLowerCase())
      if (!raw) continue
      const rec = parseEntity(raw, { board: g.board })
      if (rec?.kind === 'thread') out.set(t.key.toLowerCase(), rec)
    }
  }
  return out
}

/** Posts variant of `hydrateThreadsAcrossBoards` (comment tails on a global page). */
export async function hydratePostsAcrossBoards(store: EntityStore, groups: ReadonlyArray<{ board: BoardRef; posts: readonly PostRecord[] }>): Promise<Map<string, PostRecord>> {
  const missing: string[] = []
  for (const g of groups) for (const p of g.posts) if (!p.payload) missing.push(p.key)
  const out = new Map<string, PostRecord>()
  if (missing.length === 0) return out
  const byKey = await fetchMissing(store, missing)
  for (const g of groups) {
    for (const p of g.posts) {
      if (p.payload) continue
      const raw = byKey.get(p.key.toLowerCase())
      if (!raw) continue
      const rec = parseEntity(raw, { board: g.board })
      if (rec?.kind === 'post') out.set(p.key.toLowerCase(), rec)
    }
  }
  return out
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

export interface LoadThreadOptions {
  /** Root already fetched by the caller (shared, not re-read). */
  rootRaw?: RawEntity
}

export async function loadThread(store: EntityStore, board: ResolvedBoard, rootKey: string, currentBlock?: number, opts: LoadThreadOptions = {}): Promise<LoadedThread | undefined> {
  const rootK = rootKey.toLowerCase()
  let rootRaw = opts.rootRaw
  const replyRows: RawEntity[] = []
  if (rootRaw) {
    // Root shared by the caller: only the replies query remains.
    replyRows.push(...(await queryAll(store, [['grp', GRP_POST], ['root_ref', rootK]], { payload: true })))
  } else if (store.queryOr) {
    // Root + replies in ONE charged call, paged as a combined result.
    let cursor: string | undefined
    for (;;) {
      const page = await store.queryOr([[['$key', rootK]], [['grp', GRP_POST], ['root_ref', rootK]]], { payload: true, limit: PAGE, ...(cursor ? { cursor } : {}) })
      for (const r of page.entities) {
        if (r.key.toLowerCase() === rootK && !rootRaw) rootRaw = r
        else replyRows.push(r)
      }
      if (!page.cursor || page.entities.length === 0) break
      cursor = page.cursor
    }
  } else {
    rootRaw = await store.get(rootK, { payload: true })
    if (rootRaw) replyRows.push(...(await queryAll(store, [['grp', GRP_POST], ['root_ref', rootK]], { payload: true })))
  }
  if (!rootRaw) return undefined
  const root = parseEntity(rootRaw, { board: board.ref })
  if (root?.kind !== 'thread' || !sameGate(root.gate, board.ref.gate)) return undefined
  if (currentBlock !== undefined && root.expiresAt !== undefined && root.expiresAt <= currentBlock) return undefined
  const replies = dropExpired(
    replyRows
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
  cursor?: string
  postCursor?: string
  bumpLimit?: number
  capacity?: number
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

function globalBoardFor(index: { boards: Map<string, ResolvedBoard> }, g: BoardGate): ResolvedBoard {
  const k = gateKey(g)
  let b = index.boards.get(k)
  if (!b) { b = resolveFrom(undefined, g); index.boards.set(k, b) }
  return b
}

function refoldGlobal(index: GlobalIndex, threads: Map<string, ThreadRecord>, posts: Map<string, PostRecord>, extra: Partial<GlobalIndex> = {}): GlobalIndex {
  const liveThreads = dropExpired([...threads.values()], index.currentBlock)
  const liveSet = new Set(liveThreads.map((x) => x.key))
  const livePosts = dropExpired([...posts.values()], index.currentBlock).filter((x) => liveSet.has(x.rootRef))
  return { ...index, ...extra, threads: new Map(liveThreads.map((x) => [x.key, x])), posts: new Map(livePosts.map((x) => [x.key, x])), folded: bumpOrder(liveThreads, livePosts, { bumpLimit: index.bumpLimit ?? DEFAULT_BUMP_LIMIT, capacity: index.capacity ?? GLOBAL_CAPACITY }) }
}

function mergeGlobalRows(index: GlobalIndex, rootRows: RawEntity[], postRows: RawEntity[]): GlobalIndex {
  const threads = new Map(index.threads)
  const posts = new Map(index.posts)
  for (const r of rootRows) {
    const plain = parseEntity(r)
    if (plain?.kind === 'thread') {
      const b = globalBoardFor(index, plain.gate)
      threads.set(plain.key, plain.board === b.ref.slug ? plain : { ...plain, board: b.ref.slug })
      continue
    }
    const gate = gateFromAttributes(r.attributes)
    if (!gate) continue
    const b = globalBoardFor(index, gate)
    const rec = parseEntity(r, { board: b.ref })
    if (rec?.kind === 'thread' && !threads.has(rec.key)) threads.set(rec.key, rec)
  }
  for (const r of postRows) {
    const rec = parseEntity(r)
    if (rec?.kind !== 'post') continue
    const root = threads.get(rec.rootRef)
    if (!root || !sameGate(rec.gate, root.gate)) continue
    posts.set(rec.key, rec)
  }
  return refoldGlobal(index, threads, posts)
}

/**
 * Every thread on the network, in 3 charged calls: board defs, one OR-query
 * over every root group, one posts query. Bounded at `SCAN_ROWS` per scan.
 */
export async function loadGlobalIndex(store: EntityStore, opts: GlobalIndexOptions = {}): Promise<GlobalIndex> {
  const defs = await loadBoards(store)
  const boards = new Map<string, ResolvedBoard>()
  for (const d of defs) boards.set(gateKey(d.gate), resolveFrom(d, d.gate))
  const base: GlobalIndex = { folded: [], threads: new Map(), posts: new Map(), boards, pageSize: opts.pageSize ?? DEFAULT_PAGE_SIZE, ...(opts.bumpLimit !== undefined ? { bumpLimit: opts.bumpLimit } : {}), ...(opts.capacity !== undefined ? { capacity: opts.capacity } : {}), ...(opts.currentBlock !== undefined ? { currentBlock: opts.currentBlock } : {}) }
  const [rootsRes, postsRes] = await Promise.all([
    queryRoots(store, { maxRows: SCAN_ROWS }),
    queryAllCounted(store, [['grp', GRP_POST]], { maxRows: SCAN_ROWS }),
  ])
  const merged = mergeGlobalRows(base, rootsRes.rows, postsRes.rows)
  const truncated = rootsRes.truncated || postsRes.truncated
  return { ...merged, ...(truncated ? { truncated: true } : {}), ...(rootsRes.cursor ? { cursor: rootsRes.cursor } : {}), ...(postsRes.cursor ? { postCursor: postsRes.cursor } : {}) }
}

/** Fetch the next scan window and fold it in. No-op when not truncated. */
export async function loadGlobalMore(store: EntityStore, index: GlobalIndex): Promise<GlobalIndex> {
  if (!index.truncated) return index
  const [rootsRes, postsRes] = await Promise.all([
    index.cursor ? queryRoots(store, { maxRows: SCAN_ROWS, cursor: index.cursor }) : Promise.resolve(undefined),
    index.postCursor ? queryAllCounted(store, [['grp', GRP_POST]], { maxRows: SCAN_ROWS, cursor: index.postCursor }) : Promise.resolve(undefined),
  ])
  const merged = mergeGlobalRows(index, rootsRes?.rows ?? [], postsRes?.rows ?? [])
  const truncated = Boolean(rootsRes?.truncated || postsRes?.truncated)
  const out: GlobalIndex = { ...merged }
  delete out.truncated; delete out.cursor; delete out.postCursor
  if (truncated) out.truncated = true
  if (rootsRes?.cursor) out.cursor = rootsRes.cursor
  if (postsRes?.cursor) out.postCursor = postsRes.cursor
  return out
}

/** Incremental subscription update for the global feed. Same index when irrelevant. */
export function applyEntityToGlobalIndex(index: GlobalIndex, raw: RawEntity): GlobalIndex {
  const k = raw.key.toLowerCase()
  const had = index.threads.has(k) || index.posts.has(k)
  const merged = mergeGlobalRows({ ...index, boards: new Map(index.boards) }, [raw], [raw])
  // mergeGlobalRows treats the row as both root and post candidate; exactly one parses.
  // A row that folds nowhere (foreign group, reply to an unknown root, a def)
  // leaves the index untouched — return it as-is so callers can bail out on identity.
  if (!had && !merged.threads.has(k) && !merged.posts.has(k)) return index
  return merged
}

export function removeEntityFromGlobalIndex(index: GlobalIndex, key: string): GlobalIndex {
  const k = key.toLowerCase()
  if (!index.threads.has(k) && !index.posts.has(k)) return index
  const threads = new Map(index.threads); threads.delete(k)
  const posts = new Map(index.posts); posts.delete(k)
  return refoldGlobal(index, threads, posts)
}

export function globalPage(index: GlobalIndex, page: number, tailN: number = INDEX_TAIL_REPLIES): { items: IndexPageItem[]; page: number; pages: number } {
  return pageItems(index.folded, index.threads, index.posts, index.pageSize, page, tailN)
}

/** The effective board a thread belongs to within a global index. */
export function boardOf(index: GlobalIndex, thread: ThreadRecord): ResolvedBoard {
  return index.boards.get(gateKey(thread.gate)) ?? resolveFrom(undefined, thread.gate)
}
