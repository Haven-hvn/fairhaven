'use client'

/**
 * Browser `EntityStore` over the Arkiv SDK: index/thread reads plus the
 * current block height (for expiry filtering). Rows are normalized with
 * board-core's `toRawEntity`, identically to dsh-board.
 *
 * Anonymous-tier budgeter (paste P1/P5-E4): the public RPC bills a flat
 * 100 units per charged call, ~100 calls/hour/IP. So: `retryCount: 0`
 * (never sleep on `Retry-After`), in-flight dedupe, a concurrency cap,
 * and a cooldown honouring `Retry-After` / quota headers. A 429 becomes
 * a `RateLimitError`, never a silent empty result.
 */

import { RateLimitError, isRateLimitError, toRawEntity, type EntityStore, type QueryOptions, type QueryPage, type RawEntity, type WhereClause } from '@fairhaven/board-core'
import { env } from './env'

export { RateLimitError, isRateLimitError }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ArkivClient = any

let clientP: Promise<ArkivClient> | undefined

// ── Budgeter state ──────────────────────────────────────────────────────
const MAX_CONCURRENT = 2
const QUOTA_BLOCK_PERCENT = 95
let active = 0
const waiters: Array<() => void> = []
let cooldownUntil = 0
let lastQuotaPercent: number | undefined
const inflight = new Map<string, Promise<unknown>>()

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve() }
  return new Promise((res) => waiters.push(() => { active++; res() }))
}
function release(): void {
  active--
  waiters.shift()?.()
}

function rateLimited(): RateLimitError | undefined {
  const now = Date.now()
  if (now < cooldownUntil) return new RateLimitError('Arkiv rate limit reached (anonymous tier)', { retryAfterS: Math.ceil((cooldownUntil - now) / 1000), resetsAt: cooldownUntil, ...(lastQuotaPercent !== undefined ? { quotaUsedPercent: lastQuotaPercent } : {}) })
  return undefined
}

function noteResponse(status: number, headers: Headers): void {
  const quota = Number(headers.get('arkiv-quota-used-percent') ?? headers.get('x-quota-used-percent'))
  if (Number.isFinite(quota) && quota > 0) lastQuotaPercent = quota
  const retryAfter = Number(headers.get('retry-after'))
  if (status === 429) {
    const waitS = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60
    cooldownUntil = Math.max(cooldownUntil, Date.now() + waitS * 1000)
  } else if (lastQuotaPercent !== undefined && lastQuotaPercent >= QUOTA_BLOCK_PERCENT) {
    cooldownUntil = Math.max(cooldownUntil, Date.now() + 60_000)
  }
}

/** Wrap fetch so 429 headers survive viem's non-JSON-RPC error handling. */
const budgetingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init)
  try { noteResponse(res.status, res.headers) } catch { /* headers are best-effort */ }
  if (res.status === 429) {
    const waitS = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000))
    throw new RateLimitError('Arkiv rate limit reached (anonymous tier)', { retryAfterS: waitS || 60, resetsAt: cooldownUntil || Date.now() + 60_000, ...(lastQuotaPercent !== undefined ? { quotaUsedPercent: lastQuotaPercent } : {}) })
  }
  return res
}

async function budgeted<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const limited = rateLimited()
  if (limited) throw limited
  const existing = inflight.get(key) as Promise<T> | undefined
  if (existing) return existing
  const p = (async () => {
    await acquire()
    try {
      const again = rateLimited()
      if (again) throw again
      return await fn()
    } catch (e) {
      if (isRateLimitError(e)) {
        if (e instanceof RateLimitError && e.resetsAt) cooldownUntil = Math.max(cooldownUntil, e.resetsAt)
        throw e instanceof RateLimitError ? e : new RateLimitError('Arkiv rate limit reached (anonymous tier)', { retryAfterS: 60, resetsAt: Date.now() + 60_000 })
      }
      // viem may surface the 429 as a generic HTTP error after our fetch throw is wrapped.
      const msg = e instanceof Error ? e.message : String(e)
      if (/\b429\b|ANON_COST_LIMITED/.test(msg)) throw new RateLimitError('Arkiv rate limit reached (anonymous tier)', { retryAfterS: Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000)) || 60, resetsAt: cooldownUntil || Date.now() + 60_000 })
      throw e
    } finally {
      release()
      inflight.delete(key)
    }
  })()
  inflight.set(key, p as Promise<unknown>)
  return p
}

function client(): Promise<ArkivClient> {
  return (clientP ??= (async () => {
    const { createPublicClient } = await import('@arkiv-network/sdk')
    const chains = await import('@arkiv-network/sdk/chains')
    const { http } = await import('viem')
    const local = env.arkivRpcUrl.includes('localhost') || env.arkivRpcUrl.includes('127.0.0.1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain = ((local ? (chains as any).localhost : (chains as any).tiramisu) ?? (chains as any).tiramisu) as never
    // retryCount: 0 — fail in ~0.6s on 429 instead of sleeping Retry-After (up to ~45 min).
    return createPublicClient({ chain, transport: http(env.arkivRpcUrl, { retryCount: 0, fetchFn: budgetingFetch }) } as never)
  })())
}

async function query(where: WhereClause, opts: QueryOptions = {}): Promise<QueryPage> {
  const key = `q:${JSON.stringify(where)}:${opts.payload ? 1 : 0}:${opts.limit ?? ''}:${opts.cursor ?? ''}`
  return budgeted(key, async () => {
    const c: ArkivClient = await client()
    const { and, eq } = await import('@arkiv-network/sdk/query')
    const selection = (payload: boolean) => ({ key: true, owner: true, createdAt: true, expiresAt: true, attributes: true, ...(payload ? { payload: true } : {}) })
    let b = c.select(selection(opts.payload === true))
    const clauses = where.map(([k, v]) => eq(k, v as never))
    b = b.where(clauses.length === 1 ? clauses[0] : and(clauses))
    b = b.limit(opts.limit ?? 100)
    if (opts.cursor) b = b.cursor(opts.cursor)
    const res = await b.fetch()
    const entities = ((res.entities ?? []) as unknown[]).map((r) => toRawEntity(r as Record<string, unknown>)).filter((e): e is RawEntity => e !== undefined)
    return { entities, ...(res.cursor ? { cursor: String(res.cursor) } : {}) }
  })
}

/** One `$key` OR-query per chunk of keys (chunking lives in board-core). */
async function getMany(keys: string[], opts: { payload?: boolean } = {}): Promise<RawEntity[]> {
  if (keys.length === 0) return []
  const key = `m:${keys.join(',')}:${opts.payload === false ? 0 : 1}`
  return budgeted(key, async () => {
    const c: ArkivClient = await client()
    const { or, eq } = await import('@arkiv-network/sdk/query')
    const { key: keyVal } = await import('@arkiv-network/sdk')
    const selection = { key: true, owner: true, createdAt: true, expiresAt: true, attributes: true, payload: true }
    let b = c.select(selection)
    b = b.where(or(keys.map((k) => eq('$key', keyVal(k as `0x${string}`)))))
    b = b.limit(Math.max(keys.length, 1))
    const res = await b.fetch()
    return ((res.entities ?? []) as unknown[]).map((r) => toRawEntity(r as Record<string, unknown>)).filter((e): e is RawEntity => e !== undefined)
  })
}

async function get(key: string): Promise<RawEntity | undefined> {
  try {
    const [row] = await getMany([key])
    return row
  } catch (e) {
    if (isRateLimitError(e)) throw e
    // getEntity-style "not found" / malformed key: missing, not an error state.
    return undefined
  }
}

async function currentBlock(): Promise<number | undefined> {
  try {
    const t = await (await client()).getBlockTiming()
    return Number(t.currentBlock)
  } catch (e) {
    if (isRateLimitError(e)) throw e
    return undefined
  }
}

/** Free (`arkiv_getEntityCount`, cost 0) change probe for idle tabs. */
async function entityCount(): Promise<number | undefined> {
  try {
    return Number(await (await client()).getEntityCount())
  } catch {
    return undefined
  }
}

export const arkivStore: EntityStore & { currentBlock(): Promise<number | undefined>; entityCount(): Promise<number | undefined> } = { query, get, getMany, currentBlock, entityCount }
