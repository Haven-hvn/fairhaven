import { describe, expect, it } from 'vitest'
import { fmtTokenAmount } from '../src/lib/format'

/** Gate-token display: raw wei in, human amount out, never a lie. */
describe('fmtTokenAmount', () => {
  it('formats whole tokens', () => {
    expect(fmtTokenAmount(1_000_000_000_000_000_000n, 18)).toBe('1')
    expect(fmtTokenAmount(2_500_000_000n, 9)).toBe('2.5')
  })

  it('formats fractional amounts exactly, trailing zeros trimmed', () => {
    expect(fmtTokenAmount(1_500_000_000_000_000_000n, 18)).toBe('1.5')
    expect(fmtTokenAmount(1_000_100_000_000_000_000n, 18)).toBe('1.0001')
    expect(fmtTokenAmount(1_999_999_999_999_999_999n, 18)).toBe('1.999999999999999999')
  })

  it('expresses sub-precision amounts in token units, never as whole tokens', () => {
    // One wei of an 18-decimal token is not 1 token; a gate label appends the
    // symbol, so the fraction must carry the exact value.
    expect(fmtTokenAmount(1n, 18)).toBe('0.000000000000000001')
    expect(fmtTokenAmount(123n, 18)).toBe('0.000000000000000123')
    expect(fmtTokenAmount(1_000_000_000_000_000_001n, 18)).toBe('1.000000000000000001')
  })

  it('handles zero, decimals-0 tokens and unknown decimals', () => {
    expect(fmtTokenAmount(0n, 18)).toBe('0')
    expect(fmtTokenAmount(300n, 0)).toBe('300')
    expect(fmtTokenAmount(1_000_000_000_000_000_000n, undefined)).toBe('1000000000000000000')
    expect(fmtTokenAmount(1n, -1)).toBe('1')
    expect(fmtTokenAmount(1n, 2.5)).toBe('1')
  })

  it('accepts the full ERC-20 uint8 decimals range, not just 36', () => {
    // The metadata reader passes contract decimals through unvalidated; a
    // 40-decimal token's one wei must still render in token units.
    expect(fmtTokenAmount(1n, 40)).toBe('0.' + '0'.repeat(39) + '1')
    expect(fmtTokenAmount(1n, 255)).toBe('0.' + '0'.repeat(254) + '1')
    expect(fmtTokenAmount(1n, 256)).toBe('1') // beyond uint8: raw units
  })
})
