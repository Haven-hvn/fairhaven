/**
 * Adapters from `@arkiv-network/sdk` entity rows to `RawEntity`. Kept here so
 * the web client and dsh-board normalize rows identically. No SDK import: the
 * shapes are structural (1.x tagged-map attributes, legacy array rows).
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
    // i32/u64 facts fit a number; u256 thresholds keep exact decimal-string form.
    return inner <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(inner) : inner.toString()
  }
  return inner
}

/** SDK tagged-map attributes (0.8/1.x `Record<name, {type, value}>`), 0.7 `[{key, value}]`, or already-plain record. */
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
  // 1.x u64 system fields arrive as { type: "u64", value: bigint }.
  if (v && typeof v === 'object' && 'type' in v && 'value' in v) {
    const inner = (v as { value: unknown }).value
    if (typeof inner === 'bigint') return Number(inner)
    if (typeof inner === 'number') return inner
  }
  return undefined
}

/** Normalize one SDK row. Accepts 1.x flat rows (`$key`/`$owner`/`$attributes`/`payload`), 0.8 nested rows, and 0.7 rows. Payload may be absent when not selected. */
export function toRawEntity(row: {
  key?: unknown
  $key?: unknown
  owner?: unknown
  $owner?: unknown
  creator?: unknown
  $creator?: unknown
  createdAt?: unknown
  $createdAt?: unknown
  createdAtBlock?: unknown
  expiresAt?: unknown
  $expiresAt?: unknown
  attributes?: unknown
  $attributes?: unknown
  payload?: unknown
}): RawEntity | undefined {
  // 1.x system fields can arrive tagged ({type, value}) — unwrap defensively.
  const sys = (v: unknown): unknown => (isTagged(v) ? v.value : v)
  const keyRaw = sys(row.$key ?? row.key)
  const key = typeof keyRaw === 'string' ? keyRaw.toLowerCase() : undefined
  const ownerRaw = sys(row.$owner ?? row.owner ?? row.$creator ?? row.creator)
  const owner = typeof ownerRaw === 'string' ? ownerRaw.toLowerCase() : undefined
  const createdAt = toNumber(row.$createdAt ?? row.createdAt ?? row.createdAtBlock)
  if (!key || !owner || createdAt === undefined) return undefined
  const expiresAt = toNumber(row.$expiresAt ?? row.expiresAt)
  let payload: Uint8Array | undefined
  const payloadRaw = row.payload
  if (payloadRaw instanceof Uint8Array) payload = payloadRaw
  else if (typeof payloadRaw === 'string' && payloadRaw.length > 0) {
    // 1.x bytes values arrive as lowercase 0x hex; 0.8/0.7 payloads may be base64.
    if (/^0x[0-9a-fA-F]*$/.test(payloadRaw) && payloadRaw.length % 2 === 0) {
      try {
        const hex = payloadRaw.slice(2)
        payload = Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16))
      } catch { payload = undefined }
    } else {
      try {
        const bin = atob(payloadRaw)
        payload = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      } catch {
        payload = new TextEncoder().encode(payloadRaw)
      }
    }
  } else if (payloadRaw && typeof payloadRaw === 'object' && 'type' in payloadRaw && 'value' in payloadRaw) {
    // 1.x `{ type: "bytes", value: "0x…" }` when payload is selected as an attribute.
    const v = (payloadRaw as { value?: unknown }).value
    if (typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v) && v.length % 2 === 0) {
      const hex = v.slice(2)
      payload = Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16))
    }
  }
  return {
    key,
    owner,
    createdAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    attributes: toAttributeRecord(row.$attributes ?? row.attributes),
    ...(payload ? { payload } : {}),
  }
}
