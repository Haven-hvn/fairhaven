'use client'

/**
 * In-memory open cache for media bytes. Prefetch and explicit opens land
 * here; views render straight from it. Object URLs are minted on store and
 * revoked on clear. Session-scoped by design: sealed bytes must not survive
 * longer than the tab, and disconnect clears them (see `Navbar`).
 */

export interface OpenedMedia {
  url: string
  bytes: Uint8Array
}

const cache = new Map<string, OpenedMedia>()

export function getOpened(locator: string): OpenedMedia | undefined {
  if (!locator) return undefined
  return cache.get(locator)
}

export function setOpened(locator: string, bytes: Uint8Array, mime?: string): OpenedMedia {
  const prev = cache.get(locator)
  if (prev) URL.revokeObjectURL(prev.url)
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], ...(mime ? [{ type: mime }] : [])))
  const entry = { url, bytes }
  cache.set(locator, entry)
  return entry
}

export function clearOpened(): void {
  for (const entry of cache.values()) {
    try {
      URL.revokeObjectURL(entry.url)
    } catch {
      /* ignore */
    }
  }
  cache.clear()
}
