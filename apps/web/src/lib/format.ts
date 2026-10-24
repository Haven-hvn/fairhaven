/**
 * Token amounts for display: the gate stores raw wei, the contract knows its
 * decimals, and no reader should ever see `1000000000000000000`. Falls back to
 * the raw integer when decimals are unknown (non-ERC-20 gates).
 *
 * Fractional parts keep at most 4 digits (trailing zeros trimmed). An amount
 * too small for that precision (below 1/10,000 of a token) is shown as the raw
 * integer instead: `0.0000` would claim a value the number does not have.
 */
export function fmtTokenAmount(raw: bigint, decimals: number | undefined): string {
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return raw.toString()
  const s = raw.toString()
  if (decimals === 0) return s
  const neg = s.startsWith('-')
  const digits = neg ? s.slice(1) : s
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const frac = padded.slice(-decimals).replace(/0+$/, '')
  let fracOut = frac
  if (frac.length > 4) {
    if (frac.slice(0, 4) === '0000') return s
    fracOut = frac.slice(0, 4)
  }
  return `${neg ? '-' : ''}${whole || '0'}${fracOut ? `.${fracOut}` : ''}`
}
