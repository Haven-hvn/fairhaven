/**
 * Small inline glyphs for the frost system, drawn like the Mark: currentColor,
 * no emoji presentation. The lock says "sealed"; the cross says "failed to
 * open"; the arrow says "handled elsewhere" (another Haven app).
 */
export function Lock({ size = 12, title = 'Sealed' }: { size?: number; title?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" role="img" aria-label={title} style={{ verticalAlign: '-0.15em' }}>
      <rect x="3" y="7" width="10" height="7" fill="currentColor" stroke="none" />
      <path d="M5 7 V5 a3 3 0 0 1 6 0 V7" />
    </svg>
  )
}

export function XMark({ size = 12 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" role="img" aria-label="Failed" style={{ verticalAlign: '-0.15em' }}>
      <path d="M4 4 L12 12 M12 4 L4 12" />
    </svg>
  )
}

export function ArrowUpRight({ size = 12 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" role="img" aria-label="Opens elsewhere" style={{ verticalAlign: '-0.15em' }}>
      <path d="M5 11 L11 5 M6 5 h5 v5" />
    </svg>
  )
}
