import { describe, expect, it } from 'vitest'
import { hasAttn } from '../src/lib/receipt'

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
