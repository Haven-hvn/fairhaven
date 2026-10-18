import { describe, expect, it } from 'vitest'
import { MembershipCache } from '../src/membership.ts'
import { bumpOrder } from '../src/fold.ts'
import {
  EMPTY_FILTERS,
  applyFilters,
  describeHidden,
  filtersFromJson,
  filtersToJson,
  isCommunityMuted,
  muteAddress,
  muteCommunity,
  unmuteAddress,
  unmuteCommunity,
  visibleOnly,
} from '../src/filters.ts'
import type { BoardGate } from '../src/types.ts'

const A = `0x${'a'.repeat(40)}`
const B = `0x${'b'.repeat(40)}`
const C = `0x${'c'.repeat(40)}`
const ME = `0x${'e'.repeat(40)}`
const OTHER: BoardGate = { chain: 'EthMainnet', tokenAddress: `0x${'1'.repeat(40)}`, threshold: 1n }

// B and ME hold OTHER; A and C do not.
const members = new MembershipCache({ balanceOf: async (_c, _t, owner) => (owner === B || owner === ME ? 5n : 0n) })

const posts = [
  { key: '1', owner: A, sealed: 1 },
  { key: '2', owner: B, sealed: 1 },
  { key: '3', owner: C, sealed: 0 },
  { key: '4', owner: ME, sealed: 0 },
  { key: '5', owner: B, sealed: 0 },
]

describe('personal filters', () => {
  it('empty filters hide nothing', async () => {
    const out = await applyFilters(posts, EMPTY_FILTERS, { members, me: ME })
    expect(out.every((i) => i.hidden === undefined)).toBe(true)
  })

  it('mutes an address but never the reader', async () => {
    const f = muteAddress(muteAddress(EMPTY_FILTERS, A.toUpperCase()), ME)
    const out = await applyFilters(posts, f, { members, me: ME })
    expect(out.map((i) => i.hidden?.kind)).toEqual(['address', undefined, undefined, undefined, undefined])
    expect(visibleOnly(out).map((p) => p.key)).toEqual(['2', '3', '4', '5'])
    expect(unmuteAddress(f, A).addresses).toEqual([ME])
  })

  it('mutes a community by balance on another gate', async () => {
    const f = muteCommunity(EMPTY_FILTERS, OTHER)
    expect(isCommunityMuted(f, OTHER)).toBe(true)
    const out = await applyFilters(posts, f, { members, me: ME })
    expect(out.map((i) => i.hidden?.kind)).toEqual([undefined, 'community', undefined, undefined, 'community'])
    expect(describeHidden(out[1]!.hidden!)).toMatch(/holder of 0x111111/)
    expect(unmuteCommunity(f, OTHER).communities).toEqual([])
  })

  it('hides public-text posts when asked', async () => {
    const out = await applyFilters(posts, { ...EMPTY_FILTERS, hideClear: true }, { members, me: ME })
    expect(out.map((i) => i.hidden?.kind)).toEqual([undefined, undefined, 'clear', undefined, 'clear'])
  })

  it('round-trips through JSON', () => {
    const f = muteCommunity(muteAddress({ ...EMPTY_FILTERS, hideClear: true, showStubs: false }, A), OTHER)
    const j = filtersToJson(f)
    expect(j.communities).toEqual([`gate:1:${OTHER.tokenAddress}:1`])
    expect(filtersFromJson(JSON.parse(JSON.stringify(j)))).toEqual(f)
    expect(filtersFromJson({ addresses: ['nope', A], communities: ['gate:999:0x00:1'] })).toEqual({ ...EMPTY_FILTERS, addresses: [A] })
    expect(filtersFromJson(null)).toEqual(EMPTY_FILTERS)
  })

  it('does not change ordering: the fold runs on the full set', async () => {
    const threads = [{ key: '0xaa', createdAt: 1 }, { key: '0xbb', createdAt: 2 }]
    const replies = [{ key: '0x01', rootRef: '0xaa', noBump: false, createdAt: 10 }]
    const unfiltered = bumpOrder(threads, replies, { bumpLimit: 300, capacity: 10 }).map((t) => t.key)
    // A reader who muted the replier still computes the same order; the reply is merely stubbed.
    const f = muteAddress(EMPTY_FILTERS, A)
    const annotated = await applyFilters([{ key: '0x01', owner: A, sealed: 0 }], f, { members })
    expect(annotated[0]!.hidden?.kind).toBe('address')
    expect(bumpOrder(threads, replies, { bumpLimit: 300, capacity: 10 }).map((t) => t.key)).toEqual(unfiltered)
    expect(unfiltered).toEqual(['0xaa', '0xbb'])
  })
})

describe('MembershipCache batching and persistence', () => {
  it('memberMap uses one batched read for misses and serves repeats from the persisted store', async () => {
    let batchCalls = 0
    const backing = new Map<string, { balance: string; at: number }>()
    const store = { read: (k: string) => backing.get(k), write: (k: string, balance: string, at: number) => { backing.set(k, { balance, at }) } }
    const reader = {
      balanceOf: async () => { throw new Error('should batch') },
      balancesOf: async (_c: number, _t: string, owners: string[]) => { batchCalls++; return owners.map((o) => (o === B ? 5n : 0n)) },
    }
    const c1 = new MembershipCache(reader, { store })
    const m = await c1.memberMap(OTHER, [A, B, C])
    expect(batchCalls).toBe(1)
    expect([m.get(A), m.get(B), m.get(C)]).toEqual([false, true, false])
    const c2 = new MembershipCache(reader, { store })
    const m2 = await c2.memberMap(OTHER, [A, B])
    expect(batchCalls).toBe(1) // persisted store hit, no new RPC
    expect(m2.get(B)).toBe(true)
  })
})
