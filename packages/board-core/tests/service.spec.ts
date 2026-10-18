import { describe, expect, it } from 'vitest'
import { buildDefWrite, buildPostWrite, buildThreadWrite } from '../src/codec.ts'
import { RateLimitError, applyEntityToGlobalIndex, boardOf, globalPage, hydratePosts, hydrateThreads, indexPage, loadBoards, loadGlobalIndex, loadGlobalMore, loadIndex, loadThread, parseGateSpec, removeEntityFromGlobalIndex, resolveBoard, type EntityStore, type WhereClause } from '../src/service.ts'
import type { BoardGate, RawEntity } from '../src/types.ts'
import { toRawEntity } from '../src/sdk.ts'

const gate: BoardGate = { chain: 'BaseMainnet', tokenAddress: `0x${'ab'.repeat(20)}`, threshold: 1n }
const OWNER = `0x${'1'.repeat(40)}`

/** In-memory store with the SDK's query semantics (all clauses ANDed, equality). */
class MemStore implements EntityStore {
  rows: RawEntity[] = []
  getCalls = 0
  getManyCalls: string[][] = []
  queryCalls = 0
  add(key: string, attributes: Record<string, unknown>, payload: Uint8Array, createdAt: number, expiresAt?: number): string {
    this.rows.push({ key, owner: OWNER, createdAt, ...(expiresAt !== undefined ? { expiresAt } : {}), attributes, payload })
    return key
  }
  async query(where: WhereClause, opts: { payload?: boolean; limit?: number; cursor?: string } = {}) {
    this.queryCalls++
    const hits = this.rows.filter((r) => where.every(([k, v]) => (Array.isArray(v) ? v.map(String).includes(String(r.attributes[k])) : String(r.attributes[k]) === String(v))))
    const off = opts.cursor ? Number(opts.cursor) : 0
    const lim = opts.limit ?? hits.length
    const page = hits.slice(off, off + lim)
    return { entities: page.map((r) => (opts.payload ? r : { ...r, payload: undefined })) as RawEntity[], ...(off + lim < hits.length ? { cursor: String(off + lim) } : {}) }
  }
  async get(key: string) {
    this.getCalls++
    return this.rows.find((r) => r.key === key.toLowerCase())
  }
  async getMany(keys: string[]) {
    this.getManyCalls.push(keys)
    return this.rows.filter((r) => keys.includes(r.key.toLowerCase()))
  }
}

const K = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

function seed(): MemStore {
  const s = new MemStore()
  const def = buildDefWrite({ board: 'conf.back', title: 'Backchannel', about: '', gate, bumpLimit: 2, capacity: 10, pageSize: 2 })
  s.add(K(1), def.attributes, def.payload, 10)
  const t1 = buildThreadWrite({ board: 'conf.back', subject: 'first', gate, payload: { v: 1, text: { clear: 'a' } }, sha256Ct: '1'.repeat(64) })
  s.add(K(2), t1.attributes, t1.payload, 100, 10_000)
  const t2 = buildThreadWrite({ board: 'conf.back', subject: 'second', gate, payload: { v: 1, text: { clear: 'b' } }, sha256Ct: '2'.repeat(64) })
  s.add(K(3), t2.attributes, t2.payload, 101, 10_000)
  // A haven-cli video under the same gate (no `board` attribute, Haven payload shape).
  s.add(
    K(4),
    { grp: 'haven.video.full', title: 'keynote', gate_type: 3, gate_token: gate.tokenAddress, gate_chain: 8453, gate_threshold: 1, mime: 1, sha256_ct: '4'.repeat(64) },
    new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibx', gate: '{"version":3,"cid":"bafkzcibx","chain":"BaseMainnet","tokenAddress":"0x","threshold":"1","epoch":1,"encryptedAesKey":"QQ=="}', size: 9 })),
    99,
    10_000,
  )
  // A haven record under a DIFFERENT threshold: foreign.
  s.add(K(5), { grp: 'haven.video.full', title: 'other', gate_type: 3, gate_token: gate.tokenAddress, gate_chain: 8453, gate_threshold: 7, mime: 1, sha256_ct: '5'.repeat(64) }, new Uint8Array(), 99)
  // Replies: bump the keynote above everything; third reply to t1 is past bumpLimit 2.
  const mk = (root: string, text: string, noBump = false) =>
    buildPostWrite({ board: 'conf.back', rootRef: root, noBump, gate, payload: { v: 1, text: { clear: text } }, sha256Ct: '9'.repeat(64) })
  let r = mk(K(2), 'r1')
  s.add(K(10), r.attributes, r.payload, 200)
  r = mk(K(2), 'r2')
  s.add(K(11), r.attributes, r.payload, 201)
  r = mk(K(4), 'on the keynote')
  s.add(K(12), r.attributes, r.payload, 202)
  r = mk(K(2), 'r3 past limit')
  s.add(K(13), r.attributes, r.payload, 203)
  r = mk(K(3), 'quiet', true)
  s.add(K(14), r.attributes, r.payload, 204)
  // An expired reply (expiresAt below current block).
  r = mk(K(3), 'gone')
  s.add(K(15), r.attributes, r.payload, 205, 150)
  return s
}

describe('service', () => {
  it('lists boards and resolves by slug and by gate spec', async () => {
    const s = seed()
    const boards = await loadBoards(s)
    expect(boards.map((b) => b.board)).toEqual(['conf.back'])
    const bySlug = await resolveBoard(s, 'conf.back')
    expect(bySlug?.def?.title).toBe('Backchannel')
    expect(bySlug?.pageSize).toBe(2)
    const byGate = await resolveBoard(s, `gate:8453:${gate.tokenAddress}:1`)
    expect(byGate?.ref.slug).toBe('conf.back')
    const unknownGate = await resolveBoard(s, `gate:8453:${'0xcd'.padEnd(42, 'c')}:3`)
    expect(unknownGate?.ref.slug).toBe(`g.8453.cd${'c'.repeat(10)}`)
    expect((await resolveBoard(s, 'g.8453.abababababab'))?.ref.slug).toBe('conf.back') // implicit slug of a defined gate
    expect(await resolveBoard(s, 'no.such')).toBeUndefined()
    expect(parseGateSpec('gate:999:0x00:1')).toBeUndefined()
  })

  it('folds Fairhaven threads and Haven media together, honours bump limit, no_bump, expiry', async () => {
    const s = seed()
    const board = (await resolveBoard(s, 'conf.back'))!
    const index = await loadIndex(s, board, 1000)
    // keynote (K4) bumped at 202 → top; t1 (K2) last qualifying bump at 201 (r3 past limit); t2 (K3) only no_bump + expired reply → stays at 101.
    expect(index.folded.map((f) => f.key)).toEqual([K(4), K(2), K(3)])
    expect(index.threads.get(K(4))?.source).toBe('haven')
    expect(index.threads.get(K(4))?.subject).toBe('keynote')
    expect(index.threads.has(K(5))).toBe(false)
    expect(index.folded[1]?.replyCount).toBe(3)
    expect(index.posts.has(K(15))).toBe(false)

    const p1 = indexPage(index, 1, 3)
    expect(p1.pages).toBe(2)
    expect(p1.items.map((i) => i.thread.key)).toEqual([K(4), K(2)])
    expect(p1.items[1]?.tail.map((t) => t.key)).toEqual([K(10), K(11), K(13)])
    expect(p1.items[1]?.omitted).toBe(0)
    const p2 = indexPage(index, 2, 3)
    expect(p2.items.map((i) => i.thread.key)).toEqual([K(3)])
  })

  it('loads a thread rooted at a Haven media record', async () => {
    const s = seed()
    const board = (await resolveBoard(s, 'conf.back'))!
    const t = await loadThread(s, board, K(4), 1000)
    expect(t?.root.source).toBe('haven')
    expect(t?.root.payload?.media?.piece).toBe('bafkzcibx')
    expect(t?.replies.map((r) => r.key)).toEqual([K(12)])
    expect(await loadThread(s, board, K(5), 1000)).toBeUndefined()
  })

  it('global feed merges every gate into one fold, with per-gate boards', async () => {
    const s = seed()
    // A second community: a haven video under a different token, with no definition.
    const otherToken = `0x${'cd'.repeat(20)}`
    s.add(K(20), { grp: 'haven.video.full', title: 'elsewhere', gate_type: 3, gate_token: otherToken, gate_chain: 8453, gate_threshold: 1, mime: 1, sha256_ct: '6'.repeat(64) }, new Uint8Array(), 300, 10_000)
    // A reply on it, carrying its gate.
    const r = buildPostWrite({ board: 'g.8453.cdcdcdcdcdcd', rootRef: K(20), noBump: false, gate: { chain: 'BaseMainnet', tokenAddress: otherToken, threshold: 1n }, payload: { v: 1, text: { clear: 'hi' } }, sha256Ct: '9'.repeat(64) })
    s.add(K(21), r.attributes, r.payload, 400)
    // A reply whose gate does not match its root: foreign, dropped.
    const bad = buildPostWrite({ board: 'conf.back', rootRef: K(20), noBump: false, gate, payload: { v: 1, text: { clear: 'x' } }, sha256Ct: '9'.repeat(64) })
    s.add(K(22), bad.attributes, bad.payload, 401)

    const g = await loadGlobalIndex(s, { currentBlock: 1000, pageSize: 10 })
    // Global fold uses the default bump limit (300), so `first` (K2) bumps on its third reply (203),
    // above keynote (202). elsewhere (400) tops; second (K3) has only a no-bump + expired reply → 101;
    // K5 (threshold 7) is its own gate and appears at its createdAt 99.
    expect(g.folded.map((f) => f.key)).toEqual([K(20), K(2), K(4), K(3), K(5)])
    expect(g.posts.has(K(21))).toBe(true)
    expect(g.posts.has(K(22))).toBe(false)
    expect(g.boards.size).toBe(3)
    expect(boardOf(g, g.threads.get(K(2))!).ref.slug).toBe('conf.back')
    expect(boardOf(g, g.threads.get(K(20))!).ref.slug).toBe('g.8453.cdcdcdcdcdcd')
    expect(boardOf(g, g.threads.get(K(5))!).ref.gate.threshold).toBe(7n)
    const p = globalPage(g, 1)
    expect(p.items.map((i) => i.thread.subject)).toEqual(['elsewhere', 'first', 'keynote', 'second', 'other'])
    expect(p.items[0]?.tail.map((t) => t.key)).toEqual([K(21)])
  })

  it('hydrates a page in batched $key chunks, never per-row get', async () => {
    const s = seed()
    const board = (await resolveBoard(s, 'conf.back'))!
    const index = await loadIndex(s, board, 1000)
    const bare = index.folded.map((f) => ({ ...index.threads.get(f.key)!, payload: undefined }))
    s.getCalls = 0
    s.getManyCalls = []
    const hydrated = await hydrateThreads(s, bare, board.ref)
    expect(s.getCalls).toBe(0)
    expect(s.getManyCalls.flat()).toHaveLength(bare.length)
    expect(hydrated.every((t) => t.payload !== undefined)).toBe(true)
    const tails = await hydratePosts(s, [...index.posts.values()].map((p) => ({ ...p, payload: undefined })), board.ref)
    expect(s.getCalls).toBe(0)
    expect(tails.every((t) => t.payload !== undefined)).toBe(true)
  })

  it('propagates RateLimitError from batched hydration instead of swallowing it', async () => {
    const s = seed()
    const board = (await resolveBoard(s, 'conf.back'))!
    s.getMany = async () => { throw new RateLimitError('limited', { retryAfterS: 42 }) }
    const bare = [{ ...([...s.rows][1] ? (await loadIndex(s, board, 1000)).threads.get(K(2))! : undefined)!, payload: undefined }]
    await expect(hydrateThreads(s, bare, board.ref)).rejects.toBeInstanceOf(RateLimitError)
  })

  it('bounds the global scan to one page per group and flags truncation', async () => {
    const s = new MemStore()
    for (let n = 0; n < 150; n++) {
      const t = buildThreadWrite({ board: 'conf.back', subject: `t${n}`, gate, payload: { v: 1, text: { clear: 'x' } }, sha256Ct: '9'.repeat(64) })
      s.add(K(1000 + n), t.attributes, t.payload, 100 + n, 10_000)
    }
    const g = await loadGlobalIndex(s, { currentBlock: 1000 })
    expect(s.queryCalls).toBe(3) // defs + one OR roots query + posts
    expect(g.truncated).toBe(true)
    expect(g.threads.size).toBeLessThanOrEqual(100)
    const more = await loadGlobalMore(s, g)
    expect(more.threads.size).toBe(150)
    expect(more.truncated).toBeFalsy()
  })

  it('applies subscription upserts and removals to a global index without a reload', async () => {
    const s = seed()
    const g = await loadGlobalIndex(s, { currentBlock: 1000, pageSize: 10 })
    const raw = s.rows.find((r) => r.key === K(3))!
    const g2 = applyEntityToGlobalIndex(g, { ...raw, attributes: { ...raw.attributes, subject: 'renamed' } })
    expect(g2.threads.get(K(3))?.subject).toBe('renamed')
    expect(removeEntityFromGlobalIndex(g2, K(3)).threads.has(K(3))).toBe(false)
    expect(removeEntityFromGlobalIndex(g2, K(999))).toBe(g2)
  })

  it('toRawEntity normalizes SDK rows', () => {
    const e = toRawEntity({
      key: '0xABC',
      owner: '0xDEF',
      createdAt: 42n,
      expiresAt: '99',
      attributes: { grp: { type: 'str', value: 'haven.board.post' }, no_bump: { type: 'i32', value: 1n } },
      payload: new Uint8Array([1, 2]),
    })
    expect(e).toEqual({ key: '0xabc', owner: '0xdef', createdAt: 42, expiresAt: 99, attributes: { grp: 'haven.board.post', no_bump: 1 }, payload: new Uint8Array([1, 2]) })
  })
})
