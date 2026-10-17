/**
 * Imageboard text conventions, computed client-side from headers and bodies.
 * `>>8f3a2c1d` quotes a post by its short id; lines starting with `>` are
 * greentext. Short id = first SHORT_KEY_HEX hex chars after `0x`.
 */

import { SHORT_KEY_HEX } from './constants.ts'

export function shortKey(key: string): string {
  const h = key.toLowerCase().replace(/^0x/, '')
  return h.slice(0, SHORT_KEY_HEX)
}

const QUOTE_RE = />>([0-9a-f]{4,64})/gi

export function parseQuotes(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(QUOTE_RE)) out.add((m[1] as string).toLowerCase())
  return [...out]
}

/** Resolve a short id against known keys. Ambiguous or unknown → undefined. */
export function resolveShort(short: string, keys: Iterable<string>): string | undefined {
  const s = short.toLowerCase()
  let found: string | undefined
  for (const k of keys) {
    const h = k.toLowerCase().replace(/^0x/, '')
    if (h.startsWith(s)) {
      if (found !== undefined) return undefined
      found = k.toLowerCase()
    }
  }
  return found
}

export function isGreentext(line: string): boolean {
  return line.startsWith('>') && !line.startsWith('>>')
}

export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'quote'; short: string; key?: string }
  | { kind: 'url'; href: string }

const URL_RE = /https?:\/\/[^\s<>"']+/gi

/** Split a line into renderable segments: quotes, URLs, plain text. */
export function segmentLine(line: string, keys: Iterable<string>): TextSegment[] {
  const keyList = [...keys]
  const segs: TextSegment[] = []
  const combined = new RegExp(`${QUOTE_RE.source}|${URL_RE.source}`, 'gi')
  let last = 0
  for (const m of line.matchAll(combined)) {
    const idx = m.index ?? 0
    if (idx > last) segs.push({ kind: 'text', text: line.slice(last, idx) })
    const tok = m[0]
    if (tok.startsWith('>>')) {
      const short = tok.slice(2).toLowerCase()
      const key = resolveShort(short, keyList)
      segs.push(key ? { kind: 'quote', short, key } : { kind: 'quote', short })
    } else {
      segs.push({ kind: 'url', href: tok })
    }
    last = idx + tok.length
  }
  if (last < line.length) segs.push({ kind: 'text', text: line.slice(last) })
  return segs
}

/** key → keys of posts that quoted it (for red backlink markers). */
export function backlinks(posts: ReadonlyArray<{ key: string; text?: string; parentRef?: string }>): Map<string, string[]> {
  const keys = posts.map((p) => p.key.toLowerCase())
  const out = new Map<string, string[]>()
  const add = (target: string, from: string) => {
    const list = out.get(target) ?? []
    if (!list.includes(from)) list.push(from)
    out.set(target, list)
  }
  for (const p of posts) {
    const from = p.key.toLowerCase()
    if (p.parentRef) add(p.parentRef.toLowerCase(), from)
    if (p.text) {
      for (const short of parseQuotes(p.text)) {
        const k = resolveShort(short, keys)
        if (k) add(k, from)
      }
    }
  }
  return out
}

export function shortAddress(addr: string): string {
  const a = addr.toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(a)) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
