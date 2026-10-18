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
  /** Optional batched read (e.g. multicall). Same order as `owners`. */
  balancesOf?(chainId: number, token: string, owners: string[]): Promise<bigint[]>
}

/** Optional durable cache backing (web: localStorage; balances as decimal strings). */
export interface MembershipStore {
  read(key: string): { balance: string; at: number } | undefined
  write(key: string, balance: string, at: number): void
}

export interface MembershipOptions {
  /** Cache lifetime in ms. Default 30 minutes. */
  ttlMs?: number
  now?: () => number
  store?: MembershipStore
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

  private readonly store?: MembershipStore
  constructor(private readonly reader: BalanceReader, opts: MembershipOptions = {}) {
    this.ttl = opts.ttlMs ?? 30 * 60_000
    this.now = opts.now ?? (() => Date.now())
    if (opts.store) this.store = opts.store
  }

  private keyFor(gate: BoardGate, owner: string): string {
    return `${VARIANT_TO_EIP155[gate.chain]}:${gate.tokenAddress}:${owner.toLowerCase()}`
  }

  async balance(gate: BoardGate, owner: string): Promise<bigint> {
    const k = this.keyFor(gate, owner)
    const hit = this.cache.get(k)
    if (hit && this.now() - hit.at < this.ttl) return hit.balance
    if (!hit && this.store) {
      try {
        const s = this.store.read(k)
        if (s && this.now() - s.at < this.ttl) { const b = BigInt(s.balance); this.cache.set(k, { balance: b, at: s.at }); return b }
      } catch { /* unpersisted */ }
    }
    const pending = this.inflight.get(k)
    if (pending) return pending
    const task = this.reader
      .balanceOf(VARIANT_TO_EIP155[gate.chain], gate.tokenAddress, owner.toLowerCase())
      .then((b) => {
        const at = this.now()
        this.cache.set(k, { balance: b, at })
        try { this.store?.write(k, b.toString(), at) } catch { /* in-memory only */ }
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

  /** Balances for many owners: one batched reader call for cache misses when supported. */
  async balances(gate: BoardGate, owners: string[]): Promise<Map<string, bigint>> {
    const uniq = [...new Set(owners.map((o) => o.toLowerCase()))]
    const out = new Map<string, bigint>()
    const missing: string[] = []
    for (const o of uniq) {
      const hit = this.cache.get(this.keyFor(gate, o))
      if (hit && this.now() - hit.at < this.ttl) out.set(o, hit.balance)
      else if (this.store) {
        try {
          const s = this.store.read(this.keyFor(gate, o))
          if (s && this.now() - s.at < this.ttl) { const b = BigInt(s.balance); this.cache.set(this.keyFor(gate, o), { balance: b, at: s.at }); out.set(o, b); continue }
        } catch { /* miss */ }
        missing.push(o)
      } else missing.push(o)
    }
    if (missing.length > 0) {
      if (this.reader.balancesOf) {
        try {
          const vals = await this.reader.balancesOf(VARIANT_TO_EIP155[gate.chain], gate.tokenAddress, missing)
          missing.forEach((o, i) => {
            const b = vals[i] ?? 0n
            const at = this.now()
            this.cache.set(this.keyFor(gate, o), { balance: b, at })
            try { this.store?.write(this.keyFor(gate, o), b.toString(), at) } catch { /* in-memory only */ }
            out.set(o, b)
          })
        } catch {
          await Promise.all(missing.map(async (o) => { try { out.set(o, await this.balance(gate, o)) } catch { /* fail closed below via memberMap default */ } }))
        }
      } else {
        await Promise.all(missing.map(async (o) => { try { out.set(o, await this.balance(gate, o)) } catch { /* fail closed */ } }))
      }
    }
    return out
  }

  /** Membership per owner, fail-closed. One batched RPC when the reader supports it. */
  async memberMap(gate: BoardGate, owners: string[]): Promise<Map<string, boolean>> {
    const balances = await this.balances(gate, owners).catch(() => new Map<string, bigint>())
    return new Map([...new Set(owners.map((o) => o.toLowerCase()))].map((o) => [o, (balances.get(o) ?? -1n) >= gate.threshold && balances.has(o)] as const))
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
