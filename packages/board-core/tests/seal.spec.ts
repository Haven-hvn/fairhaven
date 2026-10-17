import { describe, expect, it } from 'vitest'
import {
  decodeTextPlain,
  deriveChunkIv,
  encodeTextPlain,
  freshAesKey,
  frostLinesFor,
  gateCidForText,
  isFramed,
  openAny,
  openText,
  padBucket,
  sealFramed,
  sealText,
} from '../src/seal.ts'
import { concat, randomBytes, toArrayBuffer } from '../src/bytes.ts'
import { FRAME_CHUNK_PLAINTEXT_BYTES } from '../src/constants.ts'

describe('text plaintext padding', () => {
  it('buckets lengths', () => {
    expect(padBucket(1)).toBe(256)
    expect(padBucket(256)).toBe(256)
    expect(padBucket(257)).toBe(1024)
    expect(padBucket(1025)).toBe(4096)
    expect(padBucket(4097)).toBe(8192)
  })
  it('round-trips and hides exact length', () => {
    const a = encodeTextPlain('hi')
    const b = encodeTextPlain('a much longer message that still fits the first bucket')
    expect(a.length).toBe(256)
    expect(b.length).toBe(256)
    expect(decodeTextPlain(a)).toBe('hi')
    expect(decodeTextPlain(b)).toBe('a much longer message that still fits the first bucket')
  })
  it('keeps unicode and NUL-free JSON intact', () => {
    const s = 'héllo 🌊 >>deadbeef\n>greentext'
    expect(decodeTextPlain(encodeTextPlain(s))).toBe(s)
  })
  it('rejects oversize', () => {
    expect(() => encodeTextPlain('x'.repeat(5000))).toThrow(/over the 4096/)
  })
})

describe('framed AES-GCM', () => {
  it('derives per-chunk IVs by XOR of BE64 index into bytes 4..12', () => {
    const base = new Uint8Array(12)
    const iv1 = deriveChunkIv(base, 1)
    expect([...iv1]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    const iv256 = deriveChunkIv(base, 256)
    expect([...iv256]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0])
  })

  it('seals and opens a small text', async () => {
    const key = freshAesKey()
    const sealed = await sealText('secret', key)
    expect(isFramed(sealed)).toBe(true)
    expect(sealed.length).toBe(12 + 8 + 256 + 16)
    expect(await openText(sealed, key)).toBe('secret')
  })

  it('fails under the wrong key', async () => {
    const sealed = await sealText('secret', freshAesKey())
    await expect(openText(sealed, freshAesKey())).rejects.toThrow()
  })

  it('multi-chunk round trip reports progress and honours abort', async () => {
    const key = freshAesKey()
    const plain = randomBytes(FRAME_CHUNK_PLAINTEXT_BYTES * 2 + 17)
    const sealed = await sealFramed(plain, key)
    expect(isFramed(sealed)).toBe(true)
    const seen: number[] = []
    const out = await openAny(sealed, key, (p) => seen.push(p.chunk))
    expect(seen).toEqual([1, 2, 3])
    expect(out.length).toBe(plain.length)
    expect(out.subarray(0, 64)).toEqual(plain.subarray(0, 64))
    expect(out.subarray(-64)).toEqual(plain.subarray(-64))
    const ac = new AbortController()
    ac.abort()
    await expect(openAny(sealed, key, undefined, ac.signal)).rejects.toThrow(/cancelled/)
  })

  it('opens the legacy single-shot layout', async () => {
    const raw = freshAesKey()
    const key = await crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt'])
    const iv = randomBytes(12)
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(encodeTextPlain('old'))))
    const legacy = concat([iv, ct])
    expect(isFramed(legacy)).toBe(false)
    expect(decodeTextPlain(await openAny(legacy, raw))).toBe('old')
  })

  it('gate cid and frost lines', () => {
    expect(gateCidForText('0xABCD')).toBe('sha256:abcd')
    expect(frostLinesFor(12 + 8 + 256 + 16)).toBe(2)
    expect(frostLinesFor(12 + 8 + 4096 + 16)).toBe(12)
  })
})
