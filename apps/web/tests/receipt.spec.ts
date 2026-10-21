import { describe, expect, it } from 'vitest'
import { hasAttn, receiptExempt, verifyAuthors } from '../src/lib/receipt'

/**
 * Missing attestation is the fallback (post shows unverified), not a
 * failure: legacy records, other Haven apps, and agents without
 * attestHolding publish without one. Only a present attestation is
 * verified — and can be rejected.
 */
describe('hasAttn', () => {
  it('is false when a record carries no attestation', () => {
    expect(hasAttn({})).toBe(false)
    expect(hasAttn({ payload: {} })).toBe(false)
    expect(hasAttn({ payload: { attn: undefined } })).toBe(false)
  })
  it('is true when an attestation rides in the payload, valid or not', () => {
    expect(hasAttn({ payload: { attn: { epoch: 1, at: 1, bal: '1', sig: 'ab' } } })).toBe(true)
    expect(hasAttn({ payload: { attn: 'garbage' } })).toBe(true)
  })
})

describe('receiptExempt', () => {
  const gate = { chain: 'BaseMainnet', tokenAddress: '0x0000000000000000000000000000000000000001', threshold: 1n } as const
  const base = { key: '0xabc', owner: '0xOWNER', gate, sha256Ct: '0'.repeat(64), createdAt: 1 }

  it('exempts haven-source records: their gate was matched at parse time', () => {
    expect(receiptExempt({ owner: base.owner, source: 'haven' })).toBe(true)
    expect(receiptExempt({ owner: base.owner, source: 'board' })).toBe(false)
    expect(receiptExempt({ owner: base.owner })).toBe(false)
  })

  it('exempts the connected viewer\u2019s own records', () => {
    expect(receiptExempt({ owner: '0xAbC', source: 'board' }, '0xaBc')).toBe(true)
    expect(receiptExempt({ owner: '0xAbC', source: 'board' }, '0xdef')).toBe(false)
  })

  it('keeps a haven-source thread with an unverifiable attn instead of dropping it', async () => {
    const haven = { ...base, source: 'haven' as const, payload: { attn: 'garbage' } }
    const { ok, rejected } = await verifyAuthors([haven], undefined)
    expect(ok.map((r) => r.key)).toEqual([base.key])
    expect(rejected.size).toBe(0)
  })
})
