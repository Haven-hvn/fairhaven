import { describe, expect, it } from 'vitest'
import { fmtTokenAmount } from '../src/lib/format'

/** Gate-token display: raw wei in, human amount out, never a lie. */
describe('fmtTokenAmount', () => {
  it('formats whole tokens', () => {
    expect(fmtTokenAmount(1_000_000_000_000_000_000n, 18)).toBe('1')
    expect(fmtTokenAmount(2_500_000_000n, 9)).toBe('2.5')
  })

  it('formats fractional amounts within 4 digits', () => {
    expect(fmtTokenAmount(1_500_000_000_000_000_000n, 18)).toBe('1.5')
    expect(fmtTokenAmount(1_000_100_000_000_000_000n, 18)).toBe('1.0001')
    expect(fmtTokenAmount(1_999_999_999_999_999_999n, 18)).toBe('1.9999')
  })

  it('returns the raw integer below 4-digit precision instead of 0.0000', () => {
    // 1 wei of an 18-decimal token: "0.0000" would overstate the precision.
    expect(fmtTokenAmount(1n, 18)).toBe('1')
    expect(fmtTokenAmount(123n, 18)).toBe('123')
  })

  it('handles zero, decimals-0 tokens and unknown decimals', () => {
    expect(fmtTokenAmount(0n, 18)).toBe('0')
    expect(fmtTokenAmount(300n, 0)).toBe('300')
    expect(fmtTokenAmount(1_000_000_000_000_000_000n, undefined)).toBe('1000000000000000000')
    expect(fmtTokenAmount(1n, -1)).toBe('1')
    expect(fmtTokenAmount(1n, 2.5)).toBe('1')
  })
})
