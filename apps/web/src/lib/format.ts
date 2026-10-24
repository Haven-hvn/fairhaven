/**
 * Token amounts for display: the gate stores raw wei, the contract knows its
 * decimals, and no reader should ever see `1000000000000000000`. Falls back to
 * the raw integer when decimals are unknown (non-ERC-20 gates).
 *
 * With known decimals the amount is always expressed in token units, exactly:
 * the full fraction with trailing zeros trimmed, never rounded or truncated —
 * `0.0000` or `1` for one wei of an 18-decimal token would overstate a gate.
 */
export function fmtTokenAmount(raw: bigint, decimals: number | undefined): string {
  // ERC-20 `decimals` is uint8 (0–255); the metadata reader passes it through
  // unvalidated, so accept the whole range rather than silently falling back
  // to raw units (which would read as whole tokens next to the symbol).
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return raw.toString()
  const s = raw.toString()
  if (decimals === 0) return s
  const neg = s.startsWith('-')
  const digits = neg ? s.slice(1) : s
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const frac = padded.slice(-decimals).replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole || '0'}${frac ? `.${frac}` : ''}`
}
