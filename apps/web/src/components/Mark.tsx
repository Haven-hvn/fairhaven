/**
 * The Fairhaven mark, inline so it takes `currentColor`. Used only where an
 * image slot would otherwise be empty (gate card without a collection icon,
 * expiry page) and as the favicon. Never in the navbar: the UI is text.
 */
export function Mark({ size = 32, title = 'Fairhaven' }: { size?: number; title?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width={size} height={size} fill="currentColor" role="img" aria-label={title}>
      <path fillRule="evenodd" d="M6 60 V12 H10 V16 H18 V12 H22 V26 H26 V22 H30 V26 H34 V22 H38 V26 H42 V12 H46 V16 H54 V12 H58 V60 Z M26 60 V38 A6 6 0 0 1 38 38 V60 Z" />
      <path d="M31.5 26 V4 H32.5 V26 Z M32.5 4 L41 7.5 L32.5 11 Z" />
    </svg>
  )
}
