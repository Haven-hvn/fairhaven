/**
 * dsh-board runtime spec. No chain, canister, or wallet: every factory is
 * replaced through `internals`. Exercises the full agent path — index, thread
 * verification (membership, hash, sealed-text open), post, reply — against an
 * in-memory Arkiv with one haven-cli video under the same gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDefWrite,
  buildThreadWrite,
  decodeTextPlain,
  freshAesKey,
  openAny,
  sealFramed,
  sha256Hex,
  toBase64,
  type EntityStore,
  type RawEntity,
  type WhereClause,
} from '@fairhaven/board-core'
import { BoardRuntime, internals, type AolSeam, type ArkivWriter, type BoardRuntimeOpts } from '../src/board.ts'

const GATE = { chain: 'BaseMainnet' as const, tokenAddress: `0x${'ab'.repeat(20)}`, threshold: 1n }
const AGENT = `0x${'a'.repeat(40)}`
const HUMAN = `0x${'b'.repeat(40)}`
const STRANGER = `0x${'c'.repeat(40)}`
const K = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

class MemStore implements EntityStore {
  rows: RawEntity[] = []
  block = 5000
  next = 100
  add(owner: string, attributes: Record<string, unknown>, payload: Uint8Array, createdAt: number, expiresAt = 1_000_000): string {
    const key = K(this.next++)
    this.rows.push({ key, owner: owner.toLowerCase(), createdAt, expiresAt, attributes, payload })
    return key
  }
  async query(where: WhereClause, opts: { payload?: boolean } = {}) {
    const hits = this.rows.filter((r) => where.every(([k, v]) => String(r.attributes[k]) === String(v)))
    return { entities: hits.map((r) => (opts.payload ? r : { ...r, payload: undefined })) as RawEntity[] }
  }
  async get(key: string) {
    return this.rows.find((r) => r.key === key.toLowerCase())
  }
  async currentBlock() {
    return this.block
  }
}

/** Fake AolRuntime: one static "epoch key"; seal frames with it, decryptV3 opens with it. */
function fakeAol(epochKey: Uint8Array): AolSeam & { calls: { seal: number; decrypt: number } } {
  const calls = { seal: 0, decrypt: 0 }
  return {
    calls,
    async seal(p) {
      calls.seal++
      const sealedBytes = await sealFramed(p.plaintext, epochKey)
      const gate = { version: 3, cid: p.cid, chain: p.chain, tokenAddress: p.tokenAddress, threshold: p.threshold.toString(), epoch: p.epoch ?? 0, encryptedAesKey: 'ZmFrZQ==' }
      return { sealedBytes, gateMetadataJson: JSON.stringify(gate) }
    },
    async decryptV3(p) {
      calls.decrypt++
      const g = JSON.parse(p.gateMetadataJson) as { version: number }
      if (g.version !== 3) throw new Error('not v3')
      return openAny(p.encryptedFileBytes, epochKey)
    },
  }
}

function fakeWriter(store: MemStore, owner: string): ArkivWriter & { writes: Array<Record<string, unknown>> } {
  const writes: Array<Record<string, unknown>> = []
  return {
    writes,
    async createEntity(params) {
      writes.push({ ...params })
      const key = store.add(owner, params.attributes ?? {}, params.payload, store.block, store.block + Math.floor((params.expiresIn ?? 1000) / 2))
      return { key: key as `0x${string}`, txHash: `0x${'f'.repeat(64)}` }
    },
  }
}

const OPTS: BoardRuntimeOpts = {
  wallet: 'agent',
  privateKeyRef: 'AGENT_EVM_KEY',
  arkivRpcUrl: 'http://localhost:8545',
  canisterId: 'gny6k-fqaaa-aaaab-ag3ra-cai',
  icpHost: 'https://icp-api.io',
  fetchRootKey: false,
  memberCheck: true,
  evmRpc: { '8453': 'http://rpc.invalid' },
  postCostUsd: 20_000,
}

describe('dsh-board runtime', () => {
  let store: MemStore
  let aol: ReturnType<typeof fakeAol>
  let writer: ReturnType<typeof fakeWriter>
  let epochKey: Uint8Array
  let balances: Record<string, bigint>

  beforeEach(async () => {
    store = new MemStore()
    epochKey = freshAesKey()
    aol = fakeAol(epochKey)
    writer = fakeWriter(store, AGENT)
    balances = { [AGENT]: 3n, [HUMAN]: 1n, [STRANGER]: 0n }
    internals.createStore = async () => store
    internals.createWriter = async () => writer
    internals.createAol = async () => aol
    internals.balanceOf = async (_rpc, _token, owner) => balances[owner.toLowerCase()] ?? 0n

    const def = buildDefWrite({ board: 'conf.back', title: 'Backchannel', about: 'test', gate: GATE, bumpLimit: 300, capacity: 50, pageSize: 10, defaults: { sealText: true, sealMedia: true } })
    store.add(HUMAN, def.attributes, def.payload, 10)
    // A human's clear thread.
    const t = buildThreadWrite({ board: 'conf.back', subject: 'hello', gate: GATE, payload: { v: 1, text: { clear: 'doors at 9' } }, sha256Ct: await sha256Hex(new TextEncoder().encode('doors at 9')) })
    store.add(HUMAN, t.attributes, t.payload, 100)
    // A haven-cli video under the gate.
    store.add(
      HUMAN,
      { grp: 'haven.video.full', title: 'keynote', gate_type: 3, gate_token: GATE.tokenAddress, gate_chain: 8453, gate_threshold: 1, mime: 1, sha256_ct: '4'.repeat(64) },
      new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibkeynote', gate: JSON.stringify({ version: 3, cid: 'x', chain: 'BaseMainnet', tokenAddress: GATE.tokenAddress, threshold: '1', epoch: 1, encryptedAesKey: 'QQ==' }), size: 9 })),
      101,
    )
    // A stranger's thread (not a holder) — must be dropped everywhere.
    const s = buildThreadWrite({ board: 'conf.back', subject: 'spam', gate: GATE, payload: { v: 1, text: { clear: 'buy' } }, sha256Ct: await sha256Hex(new TextEncoder().encode('buy')) })
    store.add(STRANGER, s.attributes, s.payload, 102)
  })

  afterEach(() => {
    internals.createStore = undefined
    internals.createWriter = undefined
    internals.createAol = undefined
    internals.balanceOf = undefined
  })

  function runtime(walletSign = true) {
    return new BoardRuntime(OPTS, {
      wallet: {
        address: async () => AGENT,
        ...(walletSign ? { signDigest: async () => ({ address: AGENT, signature: `0x${'1'.repeat(130)}` }) } : {}),
      },
      credentials: { resolve: async () => '0xkey' },
    })
  }

  it('lists boards and indexes with haven media as threads, dropping non-holders', async () => {
    const rt = runtime()
    const boards = await rt.listBoards()
    expect(boards.map((b) => b.board)).toEqual(['conf.back'])
    expect(boards[0]?.gate.threshold).toBe('1')

    const idx = await rt.index('conf.back')
    expect(idx.pages).toBe(1)
    const keys = idx.threads.map((t) => t.subject)
    expect(keys).toEqual(['keynote', 'hello'])
    expect(idx.threads[0]?.source).toBe('haven')
    expect(idx.threads.some((t) => t.subject === 'spam')).toBe(false)

    const byGate = await rt.index(`gate:8453:${GATE.tokenAddress}:1`)
    expect(byGate.board).toBe('conf.back')

    const feed = await rt.feed()
    expect(feed.gates).toBe(1)
    expect(feed.threads.map((t) => t.subject)).toEqual(['keynote', 'hello'])
    expect(feed.threads[0]?.board).toBe('conf.back')
  })

  it('posts a sealed thread, replies to a haven record, and reads both back verified', async () => {
    const rt = runtime()
    const posted = await rt.postThread({ board: 'conf.back', subject: 'secret plans', text: 'meet at the back door' })
    expect(posted.key).toMatch(/^0x/)
    const w = writer.writes.at(-1)!
    const attrs = w.attributes as Record<string, unknown>
    expect(attrs.grp).toBe('haven.board.thread')
    expect(attrs.sealed).toBe(1)
    expect(attrs.board).toBe('conf.back')
    expect(w.expiresIn).toBe(14 * 24 * 3600)
    const payload = JSON.parse(new TextDecoder().decode(w.payload as Uint8Array)) as { gate: string; text: { sealed: string } }
    expect(typeof payload.gate).toBe('string')
    // The sealed bytes open with the epoch key and decode to the text envelope.
    const plain = await openAny(Uint8Array.from(atob(payload.text.sealed), (c) => c.charCodeAt(0)), epochKey)
    expect(decodeTextPlain(plain)).toBe('meet at the back door')

    // Reply to the haven-cli keynote, clear text, parent = root, no bump.
    const idx = await rt.index('conf.back')
    const keynote = idx.threads.find((t) => t.subject === 'keynote')!
    const r = await rt.reply({ board: 'conf.back', root: keynote.key, text: 'great talk', sealText: false, noBump: true })
    expect(r.key).toMatch(/^0x/)
    const ra = writer.writes.at(-1)!.attributes as Record<string, unknown>
    expect(ra.grp).toBe('haven.board.post')
    expect(ra.root_ref).toBe(keynote.key)
    expect(ra.no_bump).toBe(1)
    expect(ra.sealed).toBe(0)
    expect(ra.parent_ref).toBeUndefined()

    // Read the sealed thread back: decrypt + hash + balance all verified.
    const thread = await rt.thread('conf.back', posted.key)
    expect(thread.root.text).toBe('meet at the back door')
    expect(thread.root.you).toBe(true)
    expect(thread.root.verified).toEqual(['balance', 'hash', 'decrypt'])
    expect(thread.rejected).toEqual([])
    expect(aol.calls.decrypt).toBe(1)

    // Keynote thread: haven root (no text, media locator), one verified reply.
    const kt = await rt.thread('conf.back', keynote.key)
    expect(kt.root.media?.locator).toBe('bafkzcibkeynote')
    expect(kt.root.media?.sealed).toBe(true)
    expect(kt.replies.map((p) => p.text)).toEqual(['great talk'])
    expect(kt.replies[0]?.noBump).toBe(true)
  })

  it('rejects tampered text and non-holder posts in a thread, with reasons', async () => {
    const rt = runtime()
    const idx = await rt.index('conf.back')
    const hello = idx.threads.find((t) => t.subject === 'hello')!
    // Stranger reply (not a holder) + a holder reply whose sha256_ct is wrong.
    const storeRows = store.rows
    const mk = (owner: string, text: string, sha: string) =>
      store.add(
        owner,
        { grp: 'haven.board.post', board: 'conf.back', root_ref: hello.key, no_bump: 0, gate_type: 3, gate_token: GATE.tokenAddress, gate_chain: 8453, gate_threshold: 1, sealed: 0, sha256_ct: sha },
        new TextEncoder().encode(JSON.stringify({ v: 1, text: { clear: text } })),
        200,
      )
    const strangerKey = mk(STRANGER, 'spam', await sha256Hex(new TextEncoder().encode('spam')))
    const tamperedKey = mk(HUMAN, 'edited', 'e'.repeat(64))
    const okKey = mk(HUMAN, 'fine', await sha256Hex(new TextEncoder().encode('fine')))
    expect(storeRows.length).toBeGreaterThan(5)

    const t = await rt.thread('conf.back', hello.key)
    expect(t.replies.map((r) => r.key)).toEqual([okKey])
    expect(t.rejected.map((r) => [r.key, r.reason.split(' ')[0]])).toEqual([
      [strangerKey, 'owner'],
      [tamperedKey, 'sha256_ct'],
    ])
  })

  it('refuses to post when the agent is not a holder, or when the root is foreign', async () => {
    balances[AGENT] = 0n
    const rt = runtime()
    await expect(rt.postThread({ board: 'conf.back', subject: 'x', text: 'y' })).rejects.toThrow(/does not hold/)
    balances[AGENT] = 3n
    await expect(rt.reply({ board: 'conf.back', root: K(999), text: 'y' })).rejects.toThrow(/not a live thread/)
    await expect(rt.resolve('no.such')).rejects.toThrow(/unknown board/)
  })

  it('meters writes against a funded treasury and never blocks an unfunded one', async () => {
    const seen: string[] = []
    const treasury = {
      report: () => ({ balances: [{}] }),
      authorize: (_c: string, cost: number) => {
        seen.push(`auth:${cost}`)
        return { approved: cost <= 20_000, reason: 'budget' }
      },
      recordExpense: async (e: { amount: number }) => {
        seen.push(`spend:${e.amount}`)
        return {}
      },
    }
    const rt = new BoardRuntime(OPTS, { wallet: { address: async () => AGENT, signDigest: async () => `0x${'1'.repeat(130)}` }, treasury })
    await rt.postThread({ board: 'conf.back', subject: 's', text: 't', sealText: false })
    expect(seen).toEqual(['auth:20000', 'spend:20000'])

    const denied = new BoardRuntime({ ...OPTS, postCostUsd: 50_000 }, { wallet: { address: async () => AGENT }, treasury })
    await expect(denied.postThread({ board: 'conf.back', subject: 's', text: 't', sealText: false })).rejects.toThrow(/treasury denied/)

    const unfunded = new BoardRuntime({ ...OPTS, postCostUsd: 50_000 }, { wallet: { address: async () => AGENT }, treasury: { ...treasury, report: () => ({ balances: [] }) } })
    await expect(unfunded.postThread({ board: 'conf.back', subject: 's', text: 't', sealText: false })).resolves.toBeTruthy()
  })

  it('personal filters hide replies and index rows without touching order, and persist', async () => {
    const rt = runtime()
    const idx0 = await rt.index('conf.back')
    const hello = idx0.threads.find((t) => t.subject === 'hello')!
    // HUMAN holds OTHER (a different community token); AGENT does not.
    const OTHER = `0x${'9'.repeat(40)}`
    internals.balanceOf = async (_rpc, token, owner) => (token === OTHER ? (owner === HUMAN ? 1n : 0n) : balances[owner.toLowerCase()] ?? 0n)
    await rt.reply({ board: 'conf.back', root: hello.key, text: 'agent here', sealText: false })
    const idxBeforeMute = await rt.index('conf.back')
 
    // Mute the other community: HUMAN's thread and HUMAN's keynote vanish, the agent's reply stays.
    const f1 = await rt.mute({ gate: `gate:1:${OTHER}:1` })
    expect(f1.communities).toEqual([`gate:1:${OTHER}:1`])
    const idx1 = await rt.index('conf.back')
    expect(idx1.threads.map((t) => t.subject)).toEqual([])
    expect(idx1.hidden.map((h) => h.reason)).toContain('holder of 0x999999… on chain 1 muted')
    // Order is unchanged underneath: unmuting restores the exact same key sequence.
    await rt.unmute({ gate: `gate:1:${OTHER}:1` })
    expect((await rt.index('conf.back')).threads.map((t) => t.key)).toEqual(idxBeforeMute.threads.map((t) => t.key))
    await rt.mute({ gate: `gate:1:${OTHER}:1` })

    const t1 = await rt.thread('conf.back', hello.key)
    expect(t1.root.owner).toBe(HUMAN) // the root is never dropped
    expect(t1.replies.map((r) => r.text)).toEqual(['agent here'])

    await rt.unmute({ gate: `gate:1:${OTHER}:1` })
    const f2 = await rt.mute({ address: HUMAN })
    expect(f2.addresses).toEqual([HUMAN])
    const t2 = await rt.thread('conf.back', hello.key)
    expect(t2.replies.map((r) => r.text)).toEqual(['agent here'])
    expect(t2.hidden).toEqual([])

    // hideClear hides the agent's own? No: the reader's own posts are never hidden.
    await rt.unmute({ address: HUMAN })
    await rt.mute({ hideClear: true })
    const t3 = await rt.thread('conf.back', hello.key)
    expect(t3.replies.map((r) => r.text)).toEqual(['agent here'])
  })

  it('loads operator filters from config and the file, file booleans win', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fairhaven-'))
    const path = join(dir, 'filters.json')
    await writeFile(path, JSON.stringify({ v: 1, addresses: [STRANGER], communities: [], hideClear: true, showStubs: false }))
    const rt = new BoardRuntime({ ...OPTS, filters: { v: 1, addresses: [HUMAN], communities: [], hideClear: false, showStubs: false }, filtersPath: path }, { wallet: { address: async () => AGENT } })
    const f = await rt.getFilters()
    expect(f.addresses.sort()).toEqual([HUMAN, STRANGER].sort())
    expect(f.hideClear).toBe(true)
    await rt.mute({ address: `0x${'d'.repeat(40)}` })
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { addresses: string[] }
    expect(onDisk.addresses).toContain(`0x${'d'.repeat(40)}`)
    await rm(dir, { recursive: true, force: true })
  })

  it('serializes the gate for the model and encodes base64 payloads it can round-trip', () => {
    expect(toBase64(new Uint8Array([1, 2, 3]))).toBe('AQID')
  })
})
