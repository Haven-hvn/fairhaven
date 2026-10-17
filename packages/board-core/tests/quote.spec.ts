import { describe, expect, it } from 'vitest'
import { backlinks, isGreentext, parseQuotes, resolveShort, segmentLine, shortAddress, shortKey } from '../src/quote.ts'
import { MembershipCache } from '../src/membership.ts'
import { clampPostTtl, epochOf } from '../src/time.ts'

const K1 = `0x8f3a2c1d${'0'.repeat(56)}`
const K2 = `0x8f3a2c1e${'0'.repeat(56)}`
const K3 = `0x77a1${'f'.repeat(60)}`

describe('quotes', () => {
  it('short keys and parsing', () => {
    expect(shortKey(K1)).toBe('8f3a2c1d')
    expect(parseQuotes('see >>8f3a2c1d and >>77A1 and >>8f3a2c1d')).toEqual(['8f3a2c1d', '77a1'])
  })
  it('resolves unambiguous prefixes only', () => {
    expect(resolveShort('8f3a2c1d', [K1, K2, K3])).toBe(K1)
    expect(resolveShort('8f3a2c1', [K1, K2, K3])).toBeUndefined()
    expect(resolveShort('77a1', [K1, K2, K3])).toBe(K3)
  })
  it('greentext', () => {
    expect(isGreentext('>implying')).toBe(true)
    expect(isGreentext('>>8f3a2c1d')).toBe(false)
    expect(isGreentext('plain')).toBe(false)
  })
  it('segments a line', () => {
    const segs = segmentLine('re >>8f3a2c1d see https://example.org/x ok', [K1, K2, K3])
    expect(segs).toEqual([
      { kind: 'text', text: 're ' },
      { kind: 'quote', short: '8f3a2c1d', key: K1 },
      { kind: 'text', text: ' see ' },
      { kind: 'url', href: 'https://example.org/x' },
      { kind: 'text', text: ' ok' },
    ])
  })
  it('backlinks from quotes and parentRef', () => {
    const map = backlinks([
      { key: K1, text: 'root' },
      { key: K2, text: '>>8f3a2c1d yes', parentRef: K1 },
      { key: K3, text: 'no quote', parentRef: K2 },
    ])
    expect(map.get(K1)).toEqual([K2])
    expect(map.get(K2)).toEqual([K3])
  })
  it('short address', () => {
    expect(shortAddress('0xABCDEF0123456789ABCDEF0123456789ABCDEF01')).toBe('0xabcd…ef01')
  })
})

describe('membership cache', () => {
  it('caches, dedups in-flight, fails closed', async () => {
    let calls = 0
    const cache = new MembershipCache({
      balanceOf: async (_c, _t, owner) => {
        calls++
        if (owner.endsWith('dead')) throw new Error('rpc down')
        return owner.endsWith('1') ? 5n : 0n
      },
    })
    const gate = { chain: 'BaseMainnet' as const, tokenAddress: `0x${'a'.repeat(40)}`, threshold: 1n }
    const o1 = `0x${'0'.repeat(39)}1`
    const o0 = `0x${'0'.repeat(40)}`
    const bad = `0x${'0'.repeat(36)}dead`
    const [a, b] = await Promise.all([cache.isMember(gate, o1), cache.isMember(gate, o1)])
    expect(a && b).toBe(true)
    expect(calls).toBe(1)
    expect(await cache.isMember(gate, o0)).toBe(false)
    expect(await cache.isMember(gate, bad)).toBe(false)
    const kept = await cache.filterMembers(gate, [{ owner: o1, id: 1 }, { owner: o0, id: 2 }, { owner: o1, id: 3 }])
    expect(kept.map((k) => k.id)).toEqual([1, 3])
  })
})

describe('time', () => {
  it('epochs and ttl clamp', () => {
    expect(epochOf(2_592_000 * 741 + 5)).toBe(741)
    expect(clampPostTtl(604800, 1000)).toBe(1000)
    expect(clampPostTtl(604800, 1001)).toBe(1000)
    expect(clampPostTtl(604800, undefined)).toBe(604800)
    expect(clampPostTtl(3, 100)).toBe(2)
  })
})
