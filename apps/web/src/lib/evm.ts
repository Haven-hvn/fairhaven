'use client'

/**
 * Membership = `balanceOf(owner) >= threshold` on the gate chain, read
 * through the per-chain RPCs in `env`. Backed by board-core's
 * `MembershipCache` (30-minute TTL, localStorage-persisted, multicall-batched, fail-closed), which is
 * also what personal filters consume — so this instance is the one the app
 * passes around.
 */

import { BALANCE_OF_ABI, MembershipCache, type BoardGate } from '@fairhaven/board-core'
import { env } from './env'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function evmClient(chainId: number): Promise<any> {
  const { createPublicClient, http } = await import('viem')
  const url = env.rpcUrls[chainId]
  if (!url) throw new Error(`fairhaven: no EVM RPC configured for chain ${chainId} (set NEXT_PUBLIC_RPC_${chainId})`)
  return createPublicClient({ transport: http(url, { retryCount: 0 }) })
}

async function balanceOf(chainId: number, token: string, owner: string): Promise<bigint> {
  const client = await evmClient(chainId)
  const v = await client.readContract({ address: token as `0x${string}`, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [owner as `0x${string}`] })
  return BigInt(v as bigint)
}

/** One multicall for a whole page of owners (falls back to per-owner reads). */
async function balancesOf(chainId: number, token: string, owners: string[]): Promise<bigint[]> {
  const client = await evmClient(chainId)
  if (typeof client.multicall !== 'function') return Promise.all(owners.map((o) => balanceOf(chainId, token, o)))
  const results = await client.multicall({ contracts: owners.map((o) => ({ address: token as `0x${string}`, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [o as `0x${string}`] })) })
  return results.map((r: { status: string; result?: unknown }) => (r.status === 'success' ? BigInt(r.result as bigint) : 0n))
}

const memberStore = {
  read(key: string) {
    try {
      const raw = localStorage.getItem(`fh:member:${key}`)
      return raw ? (JSON.parse(raw) as { balance: string; at: number }) : undefined
    } catch { return undefined }
  },
  write(key: string, balance: string, at: number) {
    try { localStorage.setItem(`fh:member:${key}`, JSON.stringify({ balance, at })) } catch { /* private mode */ }
  },
}

export const membership = new MembershipCache({ balanceOf, balancesOf }, { store: memberStore })

export interface TokenIdentity {
  symbol?: string
  name?: string
  /** Collection icon / avatar URL when the gate token publishes one. */
  image?: string
  /** ERC-20 decimals, when the contract publishes them. */
  decimals?: number
}

/** Best-effort ERC-20/721 identity for display. Never throws. */
export async function tokenIdentity(chainId: number, token: string): Promise<TokenIdentity> {
  try {
    const { createPublicClient, http } = await import('viem')
    const url = env.rpcUrls[chainId]
    if (!url) return {}
    const client = createPublicClient({ transport: http(url) })
    const address = token as `0x${string}`
    const erc20 = [
      { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
      { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
      { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
    ] as const
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({ address, abi: erc20, functionName: 'symbol' }).catch(() => undefined),
      client.readContract({ address, abi: erc20, functionName: 'name' }).catch(() => undefined),
      client.readContract({ address, abi: erc20, functionName: 'decimals' }).catch(() => undefined),
    ])
    return {
      ...(typeof symbol === 'string' && symbol ? { symbol } : {}),
      ...(typeof name === 'string' && name ? { name } : {}),
      ...(typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 ? { decimals } : {}),
    }
  } catch {
    return {}
  }
}

export type { BoardGate }
