/**
 * Adapters from `@arkiv-network/sdk` entity rows to `RawEntity`. Kept here so
 * the web client and dsh-board normalize rows identically. No SDK import: the
 * shapes are structural (0.8 tagged-map attributes, 0.7 legacy array).
 */

import type { RawEntity } from './types.ts'

const ATTR_TAGS = new Set(['bool', 'i32', 'u64', 'u256', 'dec', 'bytes32', 'str', 'addr', 'key', 'bytes'])

interface Tagged {
  type: string
  value: unknown
}

function isTagged(x: unknown): x is Tagged {
  return typeof x === 'object' && x !== null && 'type' in x && 'value' in x && ATTR_TAGS.has(String((x as Tagged).type))
}

function unwrap(v: unknown): unknown {
  const inner = isTagged(v) ? v.value : v
  if (typeof inner === 'bigint') {
    // i32/u64 facts fit a number; u256 thresholds in boards are ≤ i32 by spec.
    return inner <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(inner) : inner.toString()
  }
  return inner
}

/** SDK 0.8 `Record<name, {type, value}>`, 0.7 `[{key, value}]`, or already-plain record. */
export function toAttributeRecord(attrs: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!attrs) return out
  if (Array.isArray(attrs)) {
    for (const entry of attrs) {
      if (entry && typeof entry === 'object' && 'key' in entry) {
        const e = entry as { key: unknown; value: unknown }
        out[String(e.key)] = unwrap(e.value)
      }
    }
    return out
  }
  if (typeof attrs === 'object') {
    for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) out[k] = unwrap(v)
  }
  return out
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return undefined
}

/** Normalize one SDK row. Payload may be absent when not selected. */
export function toRawEntity(row: {
  key?: unknown
  owner?: unknown
  creator?: unknown
  createdAt?: unknown
  createdAtBlock?: unknown
  expiresAt?: unknown
  attributes?: unknown
  payload?: unknown
}): RawEntity | undefined {
  const key = typeof row.key === 'string' ? row.key.toLowerCase() : undefined
  const ownerRaw = (row.owner ?? row.creator) as unknown
  const owner = typeof ownerRaw === 'string' ? ownerRaw.toLowerCase() : undefined
  const createdAt = toNumber(row.createdAt ?? row.createdAtBlock)
  if (!key || !owner || createdAt === undefined) return undefined
  const expiresAt = toNumber(row.expiresAt)
  let payload: Uint8Array | undefined
  if (row.payload instanceof Uint8Array) payload = row.payload
  else if (typeof row.payload === 'string' && row.payload.length > 0) {
    try {
      const bin = atob(row.payload)
      payload = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    } catch {
      payload = new TextEncoder().encode(row.payload)
    }
  }
  return {
    key,
    owner,
    createdAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    attributes: toAttributeRecord(row.attributes),
    ...(payload ? { payload } : {}),
  }
}
