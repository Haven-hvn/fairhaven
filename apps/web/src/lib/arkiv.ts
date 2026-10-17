'use client'

/**
 * Browser `EntityStore` over the Arkiv SDK: index/thread reads plus the
 * current block height (for expiry filtering). Rows are normalized with
 * board-core's `toRawEntity`, identically to dsh-board.
 */

import { toRawEntity, type EntityStore, type QueryOptions, type QueryPage, type RawEntity, type WhereClause } from '@fairhaven/board-core'
import { env } from './env'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ArkivClient = any

let clientP: Promise<ArkivClient> | undefined

function client(): Promise<ArkivClient> {
  return (clientP ??= (async () => {
    const { createPublicClient } = await import('@arkiv-network/sdk')
    const chains = await import('@arkiv-network/sdk/chains')
    const { http } = await import('viem')
    const local = env.arkivRpcUrl.includes('localhost') || env.arkivRpcUrl.includes('127.0.0.1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain = ((local ? (chains as any).localhost : (chains as any).tiramisu) ?? (chains as any).tiramisu) as never
    return createPublicClient({ chain, transport: http(env.arkivRpcUrl) } as never)
  })())
}

async function query(where: WhereClause, opts: QueryOptions = {}): Promise<QueryPage> {
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
}

async function get(key: string): Promise<RawEntity | undefined> {
  try {
    const row = await (await client()).getEntity(key as `0x${string}`)
    return row ? toRawEntity(row as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

async function currentBlock(): Promise<number | undefined> {
  try {
    const t = await (await client()).getBlockTiming()
    return Number(t.currentBlock)
  } catch {
    return undefined
  }
}

export const arkivStore: EntityStore & { currentBlock(): Promise<number | undefined> } = { query, get, currentBlock }
