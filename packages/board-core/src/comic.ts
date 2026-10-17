/**
 * Comic archive helpers (CBZ). Pure: page ordering and type sniffing only.
 * Decompression lives in the client (`fflate`), so this module stays
 * dependency-free and testable.
 */

const PAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i
const IGNORED = /(^|\/)(__macosx|\.ds_store|thumbs\.db)/i

/** True for entries that are comic pages (images, not metadata or folders). */
export function isComicPage(name: string): boolean {
  if (name.endsWith('/')) return false
  if (IGNORED.test(name)) return false
  const base = name.split('/').pop() ?? ''
  if (base.startsWith('.')) return false
  return PAGE_EXT.test(base)
}

/**
 * Natural sort: "page2.jpg" < "page10.jpg", folders before their contents by
 * path, case-insensitive. Mirrors how every desktop reader orders a CBZ.
 */
export function naturalCompare(a: string, b: string): number {
  const ax = a.toLowerCase().match(/(\d+|\D+)/g) ?? []
  const bx = b.toLowerCase().match(/(\d+|\D+)/g) ?? []
  const n = Math.min(ax.length, bx.length)
  for (let i = 0; i < n; i++) {
    const p = ax[i] as string
    const q = bx[i] as string
    const pn = /^\d/.test(p)
    const qn = /^\d/.test(q)
    if (pn && qn) {
      const d = parseInt(p, 10) - parseInt(q, 10)
      if (d !== 0) return d
      if (p.length !== q.length) return p.length - q.length
    } else if (p !== q) {
      return p < q ? -1 : 1
    }
  }
  return ax.length - bx.length
}

/** Filter + order archive entry names into reading order. */
export function orderComicPages(names: readonly string[]): string[] {
  return names.filter(isComicPage).sort(naturalCompare)
}

/** Sniff an archive's container from its first bytes. */
export function sniffArchive(bytes: Uint8Array): 'zip' | 'rar' | 'unknown' {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) return 'zip'
  if (bytes.length >= 7 && bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21 && bytes[4] === 0x1a && bytes[5] === 0x07) return 'rar'
  return 'unknown'
}

/** MIME for a page by extension (for object URLs). */
export function pageMime(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : ext === 'avif' ? 'image/avif' : 'image/jpeg'
}
