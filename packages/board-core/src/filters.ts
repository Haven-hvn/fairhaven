/**
 * Personal moderation. Haven has no board authority, so moderation is a
 * client-side filter the reader owns: addresses they do not want to see,
 * communities (holders of some other token) they do not want to see, and
 * optionally every post whose text is public.
 *
 * Filters change what is RENDERED, never what is ORDERED. The bump-order fold
 * runs over the full record set so every client still derives the identical
 * index (acceptance criterion 3); hidden posts render as stubs or nothing.
 *
 * Filter lists live on the reader's device. They are never written on-chain
 * and never sent anywhere: who you mute is nobody's business.
 */

import { SEALED_TEXT, VARIANT_TO_EIP155 } from './constants.ts'
import type { MembershipCache } from './membership.ts'
import { gateSpecOf, parseGateSpec } from './service.ts'
import type { BoardGate } from './types.ts'

export interface PersonalFilters {
  v: 1
  /** Lowercase 0x addresses. */
  addresses: string[]
  /** Gates whose holders are hidden (any post by an owner holding ≥ threshold). */
  communities: BoardGate[]
  /** Hide posts whose text is public (clear). */
  hideClear: boolean
  /** Render a one-line stub for hidden posts instead of nothing. */
  showStubs: boolean
}

export const EMPTY_FILTERS: PersonalFilters = { v: 1, addresses: [], communities: [], hideClear: false, showStubs: true }

export type HiddenReason = { kind: 'address' } | { kind: 'community'; gate: BoardGate } | { kind: 'clear' }

export function describeHidden(r: HiddenReason): string {
  switch (r.kind) {
    case 'address':
      return 'address muted'
    case 'community':
      return `holder of ${r.gate.tokenAddress.slice(0, 8)}… on chain ${VARIANT_TO_EIP155[r.gate.chain]} muted`
    case 'clear':
      return 'public-text posts hidden'
  }
}

// ── Editing ─────────────────────────────────────────────────────────────

export function isAddressMuted(f: PersonalFilters, owner: string): boolean {
  return f.addresses.includes(owner.toLowerCase())
}

export function muteAddress(f: PersonalFilters, owner: string): PersonalFilters {
  const a = owner.toLowerCase()
  return f.addresses.includes(a) ? f : { ...f, addresses: [...f.addresses, a] }
}

export function unmuteAddress(f: PersonalFilters, owner: string): PersonalFilters {
  const a = owner.toLowerCase()
  return { ...f, addresses: f.addresses.filter((x) => x !== a) }
}

function sameGate(a: BoardGate, b: BoardGate): boolean {
  return a.chain === b.chain && a.tokenAddress === b.tokenAddress && a.threshold === b.threshold
}

export function isCommunityMuted(f: PersonalFilters, gate: BoardGate): boolean {
  return f.communities.some((g) => sameGate(g, gate))
}

export function muteCommunity(f: PersonalFilters, gate: BoardGate): PersonalFilters {
  const g = { ...gate, tokenAddress: gate.tokenAddress.toLowerCase() }
  return isCommunityMuted(f, g) ? f : { ...f, communities: [...f.communities, g] }
}

export function unmuteCommunity(f: PersonalFilters, gate: BoardGate): PersonalFilters {
  return { ...f, communities: f.communities.filter((g) => !sameGate(g, gate)) }
}

// ── Persistence (JSON-safe; bigint thresholds as strings) ───────────────

export interface FiltersJson {
  v: 1
  addresses: string[]
  communities: string[]
  hideClear: boolean
  showStubs: boolean
}

export function filtersToJson(f: PersonalFilters): FiltersJson {
  return { v: 1, addresses: [...f.addresses], communities: f.communities.map(gateSpecOf), hideClear: f.hideClear, showStubs: f.showStubs }
}

export function filtersFromJson(j: unknown): PersonalFilters {
  if (typeof j !== 'object' || j === null) return EMPTY_FILTERS
  const o = j as Partial<FiltersJson>
  const addresses = Array.isArray(o.addresses) ? o.addresses.filter((a): a is string => typeof a === 'string' && /^0x[0-9a-f]{40}$/.test(a.toLowerCase())).map((a) => a.toLowerCase()) : []
  const communities = Array.isArray(o.communities) ? o.communities.map((s) => (typeof s === 'string' ? parseGateSpec(s) : undefined)).filter((g): g is BoardGate => g !== undefined) : []
  return { v: 1, addresses: [...new Set(addresses)], communities, hideClear: o.hideClear === true, showStubs: o.showStubs !== false }
}

// ── Applying ────────────────────────────────────────────────────────────

export interface Filterable {
  owner: string
  sealed: number
}

export interface FilterContext {
  /** Membership oracle for community mutes (balanceOf on the muted gate). */
  members: MembershipCache
  /** The reader's own address; their posts are never hidden. */
  me?: string
}

/** Why a record is hidden, or undefined if it should render. */
export async function classifyHidden(rec: Filterable, f: PersonalFilters, ctx: FilterContext): Promise<HiddenReason | undefined> {
  const owner = rec.owner.toLowerCase()
  if (ctx.me && owner === ctx.me.toLowerCase()) return undefined
  if (f.addresses.includes(owner)) return { kind: 'address' }
  if (f.hideClear && (rec.sealed & SEALED_TEXT) === 0) return { kind: 'clear' }
  for (const gate of f.communities) {
    if (await ctx.members.isMember(gate, owner)) return { kind: 'community', gate }
  }
  return undefined
}

export interface Filtered<T> {
  record: T
  hidden?: HiddenReason
}

/** Annotate records with hide reasons. Order is preserved; nothing is removed. */
export async function applyFilters<T extends Filterable>(records: readonly T[], f: PersonalFilters, ctx: FilterContext): Promise<Filtered<T>[]> {
  const empty = f.addresses.length === 0 && f.communities.length === 0 && !f.hideClear
  if (empty) return records.map((record) => ({ record }))
  // One classification per distinct (owner, sealed) pair keeps community checks cheap.
  const cache = new Map<string, Promise<HiddenReason | undefined>>()
  return Promise.all(
    records.map(async (record) => {
      const k = `${record.owner.toLowerCase()}:${record.sealed & SEALED_TEXT}`
      let p = cache.get(k)
      if (!p) {
        p = classifyHidden(record, f, ctx)
        cache.set(k, p)
      }
      const hidden = await p
      return hidden ? { record, hidden } : { record }
    }),
  )
}

/** Only the visible records (for clients that drop rather than stub). */
export function visibleOnly<T>(items: readonly Filtered<T>[]): T[] {
  return items.filter((i) => i.hidden === undefined).map((i) => i.record)
}
