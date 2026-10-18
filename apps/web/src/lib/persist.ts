'use client'

/**
 * Persist whitelisted React Query entries to localStorage so a repeat
 * visit renders instantly. Validity is governed by the free entity-count
 * probe: `useChangeProbe` invalidates when the count moves, so a stale
 * persisted fold is replaced, never trusted blindly. Maps and BigInts
 * (gate thresholds) are revived on load.
 */

import type { QueryClient } from '@tanstack/react-query'

const KEY = 'fh:rq:v1'
export const COUNT_KEY = 'fh:entity-count'
const SAVE_KEYS = new Set(['boards', 'global', 'index', 'board', 'entity-count'])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function encode(v: any): any {
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, val]) => [k, encode(val)]) }
  if (v instanceof Uint8Array) return { __u8: [...v] }
  if (typeof v === 'bigint') return { __bigint: v.toString() }
  if (Array.isArray(v)) return v.map(encode)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, encode(val)]))
  return v
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decode(v: any): any {
  if (Array.isArray(v)) return v.map(decode)
  if (v && typeof v === 'object') {
    if ('__map' in v) return new Map((v.__map as Array<[string, unknown]>).map(([k, val]) => [k, decode(val)]))
    if ('__bigint' in v) return BigInt(v.__bigint as string)
    if ('__u8' in v) return new Uint8Array(v.__u8 as number[])
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, decode(val)]))
  }
  return v
}

export function loadPersisted(qc: QueryClient): void {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return
    const entries = JSON.parse(raw) as Array<{ key: unknown[]; data: unknown }>
    for (const e of entries) qc.setQueryData(e.key, decode(e.data))
  } catch { /* cold start */ }
}

export function persistQueryCache(qc: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    try {
      const entries = qc.getQueryCache().getAll()
        .filter((q) => q.state.status === 'success' && SAVE_KEYS.has(String(q.queryKey[0])))
        .map((q) => ({ key: q.queryKey, data: encode(q.state.data) }))
      localStorage.setItem(KEY, JSON.stringify(entries))
      const count = qc.getQueryData(['entity-count'])
      if (typeof count === 'number') localStorage.setItem(COUNT_KEY, String(count))
    } catch { /* quota / private mode */ }
  }
  const unsub = qc.getQueryCache().subscribe(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 1000)
  })
  return () => { if (timer) clearTimeout(timer); unsub() }
}

export function persistedCount(): number | undefined {
  try {
    const v = Number(localStorage.getItem(COUNT_KEY))
    return Number.isFinite(v) && v > 0 ? v : undefined
  } catch { return undefined }
}
