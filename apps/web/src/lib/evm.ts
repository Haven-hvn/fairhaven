'use client'

/**
 * Membership = `balanceOf(owner) >= threshold` on the gate chain, read
 * through the per-chain RPCs in `env`. Backed by board-core's
 * `MembershipCache` (5-minute TTL, in-flight dedupe, fail-closed), which is
 * also what personal filters consume — so this instance is the one the app
 * passes around.
 */

import { BALANCE_OF_ABI, MembershipCache, type BoardGate } from '@fairhaven/board-core'
import { env } from './env'

async function balanceOf(chainId: number, token: string, owner: string): Promise<bigint> {
  const { createPublicClient, http } = await import('viem')
  const url = env.rpcUrls[chainId]
  if (!url) throw new Error(`fairhaven: no EVM RPC configured for chain ${chainId} (set NEXT_PUBLIC_RPC_${chainId})`)
  const client = createPublicClient({ transport: http(url) })
  const v = await client.readContract({ address: token as `0x${string}`, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [owner as `0x${string}`] })
  return BigInt(v as bigint)
}

export const membership = new MembershipCache({ balanceOf })

export interface TokenIdentity {
  symbol?: string
  name?: string
  /** Collection icon / avatar URL when the gate token publishes one. */
  image?: string
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
    ] as const
    const [symbol, name] = await Promise.all([
      client.readContract({ address, abi: erc20, functionName: 'symbol' }).catch(() => undefined),
      client.readContract({ address, abi: erc20, functionName: 'name' }).catch(() => undefined),
    ])
    return {
      ...(typeof symbol === 'string' && symbol ? { symbol } : {}),
      ...(typeof name === 'string' && name ? { name } : {}),
    }
  } catch {
    return {}
  }
}

export type { BoardGate }
