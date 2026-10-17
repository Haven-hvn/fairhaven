/**
 * Membership = `balanceOf(owner) >= threshold` on the gate chain. The reader is
 * injected (viem in the web app and in dsh-board; a stub in tests) so this
 * module stays network-free.
 */

import type { BoardGate } from './types.ts'
import { VARIANT_TO_EIP155 } from './constants.ts'

export interface BalanceReader {
  /** Raw `balanceOf(owner)` on `chainId` for ERC-20 or ERC-721 `token`. */
  balanceOf(chainId: number, token: string, owner: string): Promise<bigint>
}

export interface MembershipOptions {
  /** Cache lifetime in ms. Default 5 minutes. */
  ttlMs?: number
  now?: () => number
}

interface Entry {
  balance: bigint
  at: number
}

export class MembershipCache {
  private readonly cache = new Map<string, Entry>()
  private readonly inflight = new Map<string, Promise<bigint>>()
  private readonly ttl: number
  private readonly now: () => number

  constructor(private readonly reader: BalanceReader, opts: MembershipOptions = {}) {
    this.ttl = opts.ttlMs ?? 5 * 60_000
    this.now = opts.now ?? (() => Date.now())
  }

  private keyFor(gate: BoardGate, owner: string): string {
    return `${VARIANT_TO_EIP155[gate.chain]}:${gate.tokenAddress}:${owner.toLowerCase()}`
  }

  async balance(gate: BoardGate, owner: string): Promise<bigint> {
    const k = this.keyFor(gate, owner)
    const hit = this.cache.get(k)
    if (hit && this.now() - hit.at < this.ttl) return hit.balance
    const pending = this.inflight.get(k)
    if (pending) return pending
    const task = this.reader
      .balanceOf(VARIANT_TO_EIP155[gate.chain], gate.tokenAddress, owner.toLowerCase())
      .then((b) => {
        this.cache.set(k, { balance: b, at: this.now() })
        return b
      })
      .finally(() => this.inflight.delete(k))
    this.inflight.set(k, task)
    return task
  }

  async isMember(gate: BoardGate, owner: string): Promise<boolean> {
    try {
      return (await this.balance(gate, owner)) >= gate.threshold
    } catch {
      // Fail closed: an unreachable RPC hides the post rather than showing an
      // unverified one. Callers may surface "could not verify" separately.
      return false
    }
  }

  /** Keep only records whose owner is a member. Preserves order. */
  async filterMembers<T extends { owner: string }>(gate: BoardGate, records: readonly T[]): Promise<T[]> {
    const owners = [...new Set(records.map((r) => r.owner.toLowerCase()))]
    const results = await Promise.all(owners.map((o) => this.isMember(gate, o)))
    const ok = new Set(owners.filter((_, i) => results[i]))
    return records.filter((r) => ok.has(r.owner.toLowerCase()))
  }

  invalidate(gate?: BoardGate, owner?: string): void {
    if (!gate || !owner) {
      this.cache.clear()
      return
    }
    this.cache.delete(this.keyFor(gate, owner))
  }
}

/** Minimal ERC-20/721 ABI fragment for `balanceOf`. */
export const BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const
