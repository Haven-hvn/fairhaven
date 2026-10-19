import { describe, expect, it } from 'vitest'
import { buildDefWrite, buildPostWrite, buildThreadWrite, decodePayload, gateFromAttributes, gateVersionOf, implicitSlug, parseEntity, sealedMaskOf } from '../src/codec.ts'
import { utf8Decode } from '../src/bytes.ts'
import type { BoardGate, BoardPayload } from '../src/types.ts'
import vectors from './fixtures/board-payload-vectors.json'

const gate: BoardGate = {
  chain: vectors.gate.chain as BoardGate['chain'],
  // Writers lowercase addresses; readers return them lowercase. Keep the test gate canonical.
  tokenAddress: vectors.gate.tokenAddress.toLowerCase(),
  threshold: BigInt(vectors.gate.threshold),
}

describe('writers (fixture-pinned)', () => {
  for (const v of vectors.vectors) {
    it(v.name, () => {
      const input = v.input as Record<string, unknown>
      let write
      if (v.kind === 'thread') {
        write = buildThreadWrite({
          board: input.board as string,
          subject: input.subject as string,
          gate,
          payload: input.payload as BoardPayload,
          sha256Ct: input.sha256Ct as string,
          ...(input.expiresIn !== undefined ? { expiresIn: input.expiresIn as number } : {}),
        })
      } else if (v.kind === 'post') {
        write = buildPostWrite({
          board: input.board as string,
          rootRef: input.rootRef as string,
          ...(input.parentRef !== undefined ? { parentRef: input.parentRef as string } : {}),
          noBump: input.noBump as boolean,
          gate,
          payload: input.payload as BoardPayload,
          sha256Ct: input.sha256Ct as string,
          ...(input.expiresIn !== undefined ? { expiresIn: input.expiresIn as number } : {}),
        })
      } else {
        write = buildDefWrite({
          board: input.board as string,
          title: input.title as string,
          about: input.about as string,
          gate,
          bumpLimit: input.bumpLimit as number,
          capacity: input.capacity as number,
          pageSize: input.pageSize as number,
          defaults: input.defaults as { sealText: boolean; sealMedia: boolean },
          ttl: input.ttl as { thread_s: number; post_s: number },
          expiresIn: input.expiresIn as number,
        })
      }
      // gate_threshold is a u256 (bigint); the fixture pins its numeric value.
      expect(Object.fromEntries(Object.entries(write.attributes).map(([k, val]) => [k, typeof val === 'bigint' ? Number(val) : val]))).toEqual(v.attributes)
      expect(write.expiresIn).toBe(v.expiresIn)
      expect(write.contentType).toBe('application/json')
      const payload = JSON.parse(utf8Decode(write.payload))
      expect(payload).toEqual(v.kind === 'def' ? v.payload : input.payload)
      expect(Object.keys(write.attributes).length).toBeLessThanOrEqual(11)    })
  }

  it('writes a real 18-decimal gate threshold (1e18) as u256, and reads u256 thresholds exactly', () => {
    const big: BoardGate = { chain: 'EthSepolia', tokenAddress: `0x${'f2'.repeat(20)}`, threshold: 1000000000000000000n }
    const w = buildPostWrite({ board: 'a.b', rootRef: `0x${'1'.repeat(64)}`, noBump: false, gate: big, payload: { v: 1, text: { clear: 'hi' } }, sha256Ct: '0'.repeat(64) })
    expect(w.attributes.gate_threshold).toBe(1000000000000000000n)
    // Beyond float precision: exact decimal string round-trips.
    const huge = 123456789012345678901234567890n
    expect(gateFromAttributes({ gate_token: big.tokenAddress, gate_chain: 11155111, gate_threshold: huge.toString() })?.threshold).toBe(huge)
    expect(gateFromAttributes({ gate_token: big.tokenAddress, gate_chain: 11155111, gate_threshold: huge })?.threshold).toBe(huge)
  })

  it('rejects gate/sealed mismatch', () => {
    expect(() =>
      buildThreadWrite({
        board: 'a.b',
        subject: 's',
        gate,
        payload: { v: 1, text: { sealed: 'AA==' } },
        sha256Ct: '0'.repeat(64),
      }),
    ).toThrow(/gate must be present/)
  })

  it('rejects media on replies and odd expiries', () => {
    expect(() =>
      buildPostWrite({
        board: 'a.b',
        rootRef: `0x${'1'.repeat(64)}`,
        noBump: false,
        gate,
        payload: { v: 1, text: { clear: 'x' }, media: { fcid: 'bafy', mime: 8, size: 1 } },
        sha256Ct: '0'.repeat(64),
      }),
    ).toThrow(/no media/)
    expect(() =>
      buildPostWrite({
        board: 'a.b',
        rootRef: `0x${'1'.repeat(64)}`,
        noBump: false,
        gate,
        payload: { v: 1, text: { clear: 'x' } },
        sha256Ct: '0'.repeat(64),
        expiresIn: 3601,
      }),
    ).toThrow(/multiple of 2s/)
  })

  it('rejects bad slugs and thresholds', () => {
    expect(() => buildDefWrite({ board: 'Nope', title: 't', about: '', gate })).toThrow(/slug/)
    expect(() => buildDefWrite({ board: 'a.b', title: 't', about: '', gate: { ...gate, threshold: 0n } })).toThrow(/threshold/)
  })
})

describe('readers', () => {
  it('round-trips a thread through parseEntity', () => {
    const payload: BoardPayload = {
      v: 1,
      gate: '{"version":3}',
      text: { sealed: 'AAEC' },
      media: { piece: 'bafkzcib', mime: 8, size: 10, hint: 'LEHV6nWB' },
    }
    const w = buildThreadWrite({ board: 'x.y', subject: 'hi', gate, payload, sha256Ct: 'a'.repeat(64) })
    const rec = parseEntity({
      key: `0x${'ab'.repeat(32)}`,
      owner: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
      createdAt: 500,
      expiresAt: 900,
      attributes: w.attributes,
      payload: w.payload,
    })
    expect(rec?.kind).toBe('thread')
    if (rec?.kind !== 'thread') return
    expect(rec.owner).toBe('0xabcdef0123456789abcdef0123456789abcdef01')
    expect(rec.sealed).toBe(3)
    expect(sealedMaskOf(rec.payload!)).toBe(3)
    expect(rec.gate).toEqual(gate)
    expect(rec.payload?.media?.hint).toBe('LEHV6nWB')
    expect(rec.expiresAt).toBe(900)
  })

  it('round-trips a reply and a def', () => {
    const root = `0x${'1'.repeat(64)}`
    const w = buildPostWrite({ board: 'x.y', rootRef: root, noBump: true, gate, payload: { v: 1, text: { clear: 'yo' } }, sha256Ct: 'b'.repeat(64) })
    const rec = parseEntity({ key: `0x${'cd'.repeat(32)}`, owner: `0x${'1'.repeat(40)}`, createdAt: 1, attributes: w.attributes, payload: w.payload })
    expect(rec?.kind).toBe('post')
    if (rec?.kind === 'post') {
      expect(rec.rootRef).toBe(root)
      expect(rec.noBump).toBe(true)
      expect(rec.payload?.text).toEqual({ clear: 'yo' })
    }
    const d = buildDefWrite({ board: 'x.y', title: 'T', about: 'A', gate, ttl: { thread_s: 100, post_s: 50 } })
    const def = parseEntity({ key: `0x${'ef'.repeat(32)}`, owner: `0x${'2'.repeat(40)}`, createdAt: 1, attributes: d.attributes, payload: d.payload })
    expect(def?.kind).toBe('def')
    if (def?.kind === 'def') {
      expect(def.ttl).toEqual({ thread_s: 100, post_s: 50 })
      expect(def.bumpLimit).toBe(300)
    }
  })

  it('tolerates SDK-style numeric strings and rejects foreign groups', () => {
    const w = buildThreadWrite({ board: 'x.y', subject: 'hi', gate, payload: { v: 1, text: { clear: 'c' } }, sha256Ct: 'a'.repeat(64) })
    const attrs = { ...w.attributes, gate_chain: '8453', mime: '0', sealed: '0' }
    expect(parseEntity({ key: `0x${'ab'.repeat(32)}`, owner: `0x${'1'.repeat(40)}`, createdAt: 1, attributes: attrs })?.kind).toBe('thread')
    expect(parseEntity({ key: '0x1', owner: '0x2', createdAt: 1, attributes: { grp: 'haven.video.full', board: 'x.y' } })).toBeUndefined()
  })

  it('decodePayload rejects malformed shapes', () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
    expect(decodePayload(enc({ v: 2, text: { clear: 'x' } }))).toBeUndefined()
    expect(decodePayload(enc({ v: 1, text: {} }))).toBeUndefined()
    expect(decodePayload(enc({ v: 1, text: { clear: 'x' }, media: { fcid: 'a', piece: 'b', mime: 1, size: 1 } }))).toBeUndefined()
    expect(decodePayload(enc({ v: 1, text: { clear: 'x' }, media: { fcid: 'a', mime: 1, size: 1 } }))?.media?.fcid).toBe('a')
  })
})

describe('haven media records as thread roots', () => {
  const board = { slug: 'conference.backchannel', gate }
  const havenAttrs = {
    grp: 'haven.video.full',
    title: 'keynote recording',
    gate_type: 3,
    gate_token: gate.tokenAddress.toLowerCase(),
    gate_chain: 8453,
    gate_threshold: 1,
    sha256_ct: 'c'.repeat(64),
    mime: 1,
    dur_s: 1800,
  }
  const havenPayload = new TextEncoder().encode(
    JSON.stringify({
      piece: 'bafkzcibkeynote',
      gate: JSON.stringify({ version: 3, cid: 'bafkzcibkeynote', chain: 'BaseMainnet', tokenAddress: gate.tokenAddress.toLowerCase(), threshold: '1', epoch: 741, encryptedAesKey: 'QUJD' }),
      size: 123,
      creator: 'cli',
    }),
  )

  it('surfaces a haven-cli record under the same gate as a thread', () => {
    const rec = parseEntity({ key: `0x${'77'.repeat(32)}`, owner: `0x${'9'.repeat(40)}`, createdAt: 10, attributes: havenAttrs, payload: havenPayload }, { board })
    expect(rec?.kind).toBe('thread')
    if (rec?.kind !== 'thread') return
    expect(rec.source).toBe('haven')
    expect(rec.grp).toBe('haven.video.full')
    expect(rec.subject).toBe('keynote recording')
    expect(rec.board).toBe('conference.backchannel')
    expect(rec.mime).toBe(1)
    expect(rec.sealed).toBe(2)
    expect(rec.gateVersion).toBe(3)
    expect(rec.payload?.media?.piece).toBe('bafkzcibkeynote')
    expect(rec.payload?.text).toEqual({ clear: '' })
    expect(gateVersionOf(rec.payload?.gate)).toBe(3)
  })

  it('attribute-only rows infer sealing from gate_type', () => {
    const rec = parseEntity({ key: `0x${'77'.repeat(32)}`, owner: `0x${'9'.repeat(40)}`, createdAt: 10, attributes: { ...havenAttrs, gate_type: 1 } }, { board })
    expect(rec?.kind).toBe('thread')
    if (rec?.kind === 'thread') {
      expect(rec.sealed).toBe(2)
      expect(rec.gateVersion).toBe(1)
      expect(rec.payload).toBeUndefined()
    }
  })

  it('ignores haven records under a different gate, or without a board context', () => {
    const other = { ...havenAttrs, gate_threshold: 5 }
    expect(parseEntity({ key: '0x1', owner: '0x2', createdAt: 1, attributes: other }, { board })).toBeUndefined()
    expect(parseEntity({ key: '0x1', owner: '0x2', createdAt: 1, attributes: havenAttrs })).toBeUndefined()
  })

  it('implicit slug is a valid board slug', () => {
    expect(implicitSlug(gate)).toBe('g.8453.abcdef012345')
  })
})

describe('membership receipts in payloads', () => {
  const receipt = { epoch: 679, at: 1760000000, bal: '5', sig: 'ab'.repeat(64) }

  it('a board post carries its member receipt through encode → parseEntity', () => {
    const payload: BoardPayload = { v: 1, text: { clear: 'hello' }, attn: receipt }
    const w = buildThreadWrite({ board: 'x.y', subject: 'hi', gate, payload, sha256Ct: 'a'.repeat(64) })
    const rec = parseEntity({ key: `0x${'ab'.repeat(32)}`, owner: `0x${'1'.repeat(40)}`, createdAt: 500, attributes: w.attributes, payload: w.payload })
    expect(rec?.kind).toBe('thread')
    if (rec?.kind !== 'thread') return
    expect(rec.payload?.attn).toEqual(receipt)
  })

  it('unknown or malformed attn is dropped, not fatal', () => {
    expect(decodePayload(new TextEncoder().encode(JSON.stringify({ v: 1, text: { clear: 'x' }, attn: { epoch: 'no' } })))?.attn).toBeUndefined()
    expect(decodePayload(new TextEncoder().encode(JSON.stringify({ v: 1, text: { clear: 'x' }, attn: { ...receipt, junk: true } })))?.attn).toEqual(receipt)
  })

  it('a haven media record keeps the dapp attestation bound to sha256_ct', () => {
    const attn = { evmAddress: `0x${'9'.repeat(40)}`, chain: 'BaseMainnet', tokenAddress: gate.tokenAddress, threshold: 1, balanceAtCheck: 2, cidHash: 'c'.repeat(64), timestamp: 1760000000, signature: 'cd'.repeat(64) }
    const attrs = { grp: 'haven.video.full', title: 't', gate_type: 3, gate_token: gate.tokenAddress, gate_chain: 8453, gate_threshold: 1, sha256_ct: 'c'.repeat(64), mime: 1 }
    const payload = new TextEncoder().encode(JSON.stringify({ fcid: 'bafy', size: 1, attn }))
    const rec = parseEntity({ key: `0x${'77'.repeat(32)}`, owner: `0x${'9'.repeat(40)}`, createdAt: 10, attributes: attrs, payload }, { board: { slug: 'x.y', gate } })
    expect(rec?.kind).toBe('thread')
    if (rec?.kind !== 'thread') return
    expect(rec.payload?.attn).toEqual(attn)
  })
})
