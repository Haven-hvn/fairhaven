/**
 * Membership receipts: the Haven-AOL canister's Ed25519 attestation, verified
 * offline by every reader. Replaces per-reader `balanceOf` RPC calls.
 *
 * The canister (`attestHolding`) checks `balanceOf(holder) >= threshold` on
 * the gate chain itself and signs
 *
 *   HAVEN_ATTEST_V1:{chain}:{token}:{threshold}:{holder}:{cidHash}:{timestamp}:{balance}
 *
 * with a threshold-Schnorr Ed25519 key whose public half is a one-time query
 * (`getAttestationPublicKey`). `cidHash` is caller-chosen; the canister only
 * binds it. Fairhaven binds it to the member and the epoch:
 *
 *   cidHash = sha256("HAVEN_MEMBER_V1:" + gateSpec + ":" + epoch)
 *
 * so one receipt per member per gate per 30-day epoch covers every post that
 * member writes in the epoch (and, in redhaven, every vote). A reader holding
 * the public key verifies a post with one signature check and no network.
 *
 * Haven media records (haven-cli, haven-dapp) carry the dapp's attestation
 * shapes instead, bound to the record's `sha256_ct`; both are verified here so
 * a board shows every record under its gate with the same guarantee.
 *
 * Everything in this module is synchronous and pure; the only I/O (fetching
 * the key, calling `attestHolding`) is the caller's.
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { CHAIN_VARIANTS, EPOCH_LENGTH_SECONDS, VARIANT_TO_EIP155, type ChainVariant } from './constants.ts'
import { concat, fromHex, toHex, utf8Encode } from './bytes.ts'
import { epochOf } from './time.ts'
import type { BoardGate } from './types.ts'

/** Same string as `gateSpecOf` in service.ts; repeated here so codec → attest → service is not a cycle. */
function gateSpec(gate: BoardGate): string {
  return `gate:${VARIANT_TO_EIP155[gate.chain]}:${gate.tokenAddress.toLowerCase()}:${gate.threshold.toString()}`
}

// ── Constants ───────────────────────────────────────────────────────────

export const MEMBER_RECEIPT_PREFIX = 'HAVEN_MEMBER_V1'
export const ATTEST_PREIMAGE_PREFIX = 'HAVEN_ATTEST_V1'
export const BATCH_ATTEST_PREIMAGE_PREFIX = 'HAVEN_BATCH_ATTEST_V1'
/** A receipt is relied upon for at most one epoch after the canister issued it. */
export const RECEIPT_TTL_SECONDS = EPOCH_LENGTH_SECONDS
/** A receipt may be dated this far after the moment it is relied upon (clock skew + block-time estimate). */
export const RECEIPT_FUTURE_SLACK_SECONDS = 3600

/** EIP-712 domain the canister verifies `AttestRequest` under. No `version` field. */
export const AOL_EIP712_NAME = 'HavenAOL'
export const AOL_DOMAIN_TYPE = 'EIP712Domain(string name,uint256 chainId,address verifyingContract)'
export const ATTEST_REQUEST_TYPE = 'AttestRequest(address evmAddress,bytes32 cidHash,uint256 nonce)'
export const ATTEST_REQUEST_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  AttestRequest: [
    { name: 'evmAddress', type: 'address' },
    { name: 'cidHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^(0x)?[0-9a-fA-F]{128}$/
const ADDR = /^0x[0-9a-fA-F]{40}$/
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/

// ── Types ───────────────────────────────────────────────────────────────

/** Fairhaven's per-member, per-epoch receipt as carried in `payload.attn`. */
export interface MemberReceipt {
  /** Haven-AOL epoch the receipt was minted in (`epochOf(at)`). */
  epoch: number
  /** Canister timestamp, unix seconds. */
  at: number
  /** `balanceAtCheck`, decimal string (raw token units). */
  bal: string
  /** Canister Ed25519 signature, 64 bytes as bare lowercase hex. */
  sig: string
}

/** haven-dapp / haven-cli single-CID attestation (`attest_holding`). */
export interface HavenSingleAttestation {
  evmAddress: string
  chain: string
  tokenAddress: string
  threshold: number | string
  balanceAtCheck: number | string
  cidHash: string
  timestamp: number
  signature: string
}

/** haven-dapp / haven-cli Merkle batch attestation (`batchAttestHolding`). */
export interface HavenMerkleAttestation {
  evmAddress: string
  chain: string
  tokenAddress: string
  threshold: number | string
  balanceAtCheck: number | string
  timestamp: number
  cidCount: number
  cidHash: string
  merkleProof: Array<{ side: 'left' | 'right'; hash: string }>
  merkleRoot: string
  rootSignature: string
}

export type HavenAttestation = HavenSingleAttestation | HavenMerkleAttestation
export type PayloadAttestation = MemberReceipt | HavenAttestation

export type ReceiptReason = 'missing' | 'shape' | 'binding' | 'balance' | 'epoch' | 'future' | 'expired' | 'signature' | 'unsupported_chain'
export type ReceiptCheck = { ok: true } | { ok: false; reason: ReceiptReason }

export function describeReceiptReason(r: ReceiptReason): string {
  switch (r) {
    case 'missing': return 'no membership receipt'
    case 'shape': return 'malformed membership receipt'
    case 'binding': return 'receipt issued for another member, gate or content'
    case 'balance': return 'receipt balance below the gate threshold'
    case 'epoch': return 'receipt epoch does not match its timestamp'
    case 'future': return 'receipt dated after the post'
    case 'expired': return 'receipt older than one epoch at post time'
    case 'signature': return 'receipt not signed by the Haven-AOL canister'
    case 'unsupported_chain': return 'gate chain has no Haven-AOL attestation support'
  }
}

// ── Reader-facing state wording ────────────────────────────────────────

/**
 * How a record's attestation reads to a viewer, shared by every Haven app
 * so the same situation gets the same words everywhere.
 *
 * Policy the wording encodes: absence of an attestation is not evidence
 * about the poster — legacy records, other Haven apps, and agents without
 * attestHolding publish without one — so a missing attestation is shown
 * anyway and worded as a fact about the record, never as an accusation.
 * Only a present-but-invalid attestation is a validation failure, and even
 * then the wording blames the proof, not the person.
 */
export type AttestationState =
  /** `payload.attn` present and verified against the canister key. */
  | 'verified'
  /** No `payload.attn` on the record. Fallback: shown anyway. */
  | 'missing'
  /** `payload.attn` present but failed verification. */
  | 'invalid'
  /** Verification could not run (e.g. attestation key unavailable). */
  | 'unchecked'

/** Short badge text for a listing row. */
export function attestationLabel(state: AttestationState): string {
  switch (state) {
    case 'verified': return 'attested'
    case 'missing': return 'no attestation — shown anyway'
    case 'invalid': return 'attestation did not validate'
    case 'unchecked': return 'not checked'
  }
}

/** One-sentence explanation, suitable for a tooltip or notice line. */
export function describeAttestation(state: AttestationState): string {
  switch (state) {
    case 'verified': return 'membership attested by Haven-AOL'
    case 'missing': return "shown without an attestation — the publishing app didn't include one"
    case 'invalid': return "the membership proof on this post couldn't be validated"
    case 'unchecked': return 'membership checks are unavailable right now'
  }
}

// ── Shapes ──────────────────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isUnix(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 2 ** 40
}

function decimalOf(x: unknown): string | undefined {
  if (typeof x === 'string') return DECIMAL.test(x) ? x : undefined
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return String(x)
  if (typeof x === 'bigint' && x >= 0n) return x.toString()
  return undefined
}

export function isMemberReceiptShape(x: unknown): x is MemberReceipt {
  if (!isRecord(x)) return false
  return isUnix(x.epoch) && isUnix(x.at) && decimalOf(x.bal) !== undefined && typeof x.sig === 'string' && HEX128.test(x.sig) && !('cidHash' in x)
}

export function isHavenAttestationShape(x: unknown): x is HavenAttestation {
  if (!isRecord(x)) return false
  const base =
    typeof x.evmAddress === 'string' && ADDR.test(x.evmAddress) &&
    typeof x.chain === 'string' &&
    typeof x.tokenAddress === 'string' && ADDR.test(x.tokenAddress) &&
    decimalOf(x.threshold) !== undefined &&
    decimalOf(x.balanceAtCheck) !== undefined &&
    typeof x.cidHash === 'string' && HEX64.test(x.cidHash.toLowerCase().replace(/^0x/, '')) &&
    isUnix(x.timestamp)
  if (!base) return false
  if (typeof x.merkleRoot === 'string') {
    return Array.isArray(x.merkleProof) && typeof x.rootSignature === 'string' && HEX128.test(x.rootSignature) && HEX64.test(x.merkleRoot.toLowerCase()) && isUnix(x.cidCount)
  }
  return typeof x.signature === 'string' && HEX128.test(x.signature)
}

export function isMerkleAttestation(a: HavenAttestation): a is HavenMerkleAttestation {
  return typeof (a as HavenMerkleAttestation).merkleRoot === 'string'
}

/** Keep only the fields the wire shape defines; anything else is dropped before storage. */
export function normalizeAttestation(x: unknown): PayloadAttestation | undefined {
  if (isMemberReceiptShape(x)) return { epoch: x.epoch, at: x.at, bal: decimalOf(x.bal)!, sig: x.sig.toLowerCase().replace(/^0x/, '') }
  if (isHavenAttestationShape(x)) {
    const base = { evmAddress: x.evmAddress, chain: x.chain, tokenAddress: x.tokenAddress, threshold: x.threshold, balanceAtCheck: x.balanceAtCheck, cidHash: x.cidHash, timestamp: x.timestamp }
    if (isMerkleAttestation(x)) {
      return { ...base, cidCount: x.cidCount, merkleProof: x.merkleProof.map((s) => ({ side: s.side, hash: s.hash })), merkleRoot: x.merkleRoot, rootSignature: x.rootSignature }
    }
    return { ...base, signature: x.signature }
  }
  return undefined
}

// ── Member receipt ──────────────────────────────────────────────────────

/** The `cidHash` Fairhaven asks the canister to bind: bare lowercase sha256 hex. */
export function memberCidHash(gate: BoardGate, epoch: number): string {
  return toHex(sha256(utf8Encode(`${MEMBER_RECEIPT_PREFIX}:${gateSpec(gate)}:${epoch}`)))
}

/** Bytes the canister signs. `token`, `holder` and `cidHash` must be exactly what was submitted (lowercase). */
export function attestPreimage(chain: ChainVariant, token: string, threshold: bigint | string, holder: string, cidHash: string, at: number, bal: string): Uint8Array {
  return utf8Encode(`${ATTEST_PREIMAGE_PREFIX}:${chain}:${token}:${threshold.toString()}:${holder}:${cidHash}:${at}:${bal}`)
}

function verifyEd25519(sigHex: string, msg: Uint8Array, key: Uint8Array): boolean {
  try {
    const sig = fromHex(sigHex)
    if (sig.length !== 64 || key.length !== 32) return false
    return ed25519.verify(sig, msg, key)
  } catch {
    return false
  }
}

/**
 * Verify a member receipt for `holder` on `gate` as of `atUnix` (when the
 * receipt is being relied upon: a post's creation time, a vote's `at`).
 */
export function verifyMemberReceipt(r: unknown, gate: BoardGate, holder: string, attestKey: Uint8Array, atUnix: number): ReceiptCheck {
  if (r === undefined || r === null) return { ok: false, reason: 'missing' }
  if (!isMemberReceiptShape(r)) return { ok: false, reason: 'shape' }
  if (!(CHAIN_VARIANTS as readonly string[]).includes(gate.chain)) return { ok: false, reason: 'unsupported_chain' }
  const bal = decimalOf(r.bal)!
  if (BigInt(bal) < gate.threshold) return { ok: false, reason: 'balance' }
  if (epochOf(r.at) !== r.epoch) return { ok: false, reason: 'epoch' }
  if (r.at > atUnix + RECEIPT_FUTURE_SLACK_SECONDS) return { ok: false, reason: 'future' }
  if (atUnix - r.at > RECEIPT_TTL_SECONDS) return { ok: false, reason: 'expired' }
  const msg = attestPreimage(gate.chain, gate.tokenAddress.toLowerCase(), gate.threshold, holder.toLowerCase(), memberCidHash(gate, r.epoch), r.at, bal)
  if (!verifyEd25519(r.sig, msg, attestKey)) return { ok: false, reason: 'signature' }
  return { ok: true }
}

// ── Haven media attestations (dapp / cli shapes) ────────────────────────

const LEAF_PREFIX = new Uint8Array([0x00])
const NODE_PREFIX = new Uint8Array([0x01])

function havenLeafPreimage(a: HavenAttestation): Uint8Array {
  return utf8Encode(`${ATTEST_PREIMAGE_PREFIX}:${a.chain}:${a.tokenAddress}:${decimalOf(a.threshold)}:${a.evmAddress}:${a.cidHash}:${a.timestamp}:${decimalOf(a.balanceAtCheck)}`)
}

function havenBatchPreimage(a: HavenMerkleAttestation): Uint8Array {
  return utf8Encode(`${BATCH_ATTEST_PREIMAGE_PREFIX}:${a.chain}:${a.tokenAddress}:${decimalOf(a.threshold)}:${a.evmAddress}:${a.merkleRoot}:${a.cidCount}:${a.timestamp}:${decimalOf(a.balanceAtCheck)}`)
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number)
  return d === 0
}

/**
 * Verify a haven-dapp / haven-cli attestation on a media record under `gate`,
 * written by `owner`, whose stored content hash is `sha256Ct`.
 */
export function verifyHavenAttestation(a: unknown, gate: BoardGate, owner: string, sha256Ct: string, attestKey: Uint8Array, atUnix: number): ReceiptCheck {
  if (a === undefined || a === null) return { ok: false, reason: 'missing' }
  if (!isHavenAttestationShape(a)) return { ok: false, reason: 'shape' }
  if (a.evmAddress.toLowerCase() !== owner.toLowerCase()) return { ok: false, reason: 'binding' }
  if (a.tokenAddress.toLowerCase() !== gate.tokenAddress.toLowerCase()) return { ok: false, reason: 'binding' }
  if (a.chain !== gate.chain) return { ok: false, reason: 'binding' }
  if (BigInt(decimalOf(a.threshold)!) !== gate.threshold) return { ok: false, reason: 'binding' }
  if (a.cidHash.toLowerCase().replace(/^0x/, '') !== sha256Ct.toLowerCase()) return { ok: false, reason: 'binding' }
  if (BigInt(decimalOf(a.balanceAtCheck)!) < gate.threshold) return { ok: false, reason: 'balance' }
  if (a.timestamp > atUnix + RECEIPT_FUTURE_SLACK_SECONDS) return { ok: false, reason: 'future' }
  if (atUnix - a.timestamp > RECEIPT_TTL_SECONDS) return { ok: false, reason: 'expired' }
  if (!isMerkleAttestation(a)) {
    return verifyEd25519(a.signature, havenLeafPreimage(a), attestKey) ? { ok: true } : { ok: false, reason: 'signature' }
  }
  try {
    let h = sha256(concat([LEAF_PREFIX, havenLeafPreimage(a)]))
    for (const step of a.merkleProof) {
      if ((step.side !== 'left' && step.side !== 'right') || typeof step.hash !== 'string' || !HEX64.test(step.hash.toLowerCase())) return { ok: false, reason: 'shape' }
      const sib = fromHex(step.hash)
      h = step.side === 'left' ? sha256(concat([NODE_PREFIX, sib, h])) : sha256(concat([NODE_PREFIX, h, sib]))
    }
    if (!bytesEq(h, fromHex(a.merkleRoot))) return { ok: false, reason: 'signature' }
    return verifyEd25519(a.rootSignature, havenBatchPreimage(a), attestKey) ? { ok: true } : { ok: false, reason: 'signature' }
  } catch {
    return { ok: false, reason: 'shape' }
  }
}

/**
 * One rule for every record under a gate: Fairhaven posts carry a member
 * receipt bound to (owner, gate, epoch); Haven media records carry the dapp
 * attestation bound to (owner, gate, sha256_ct).
 */
export function verifyRecordAuthor(
  rec: { owner: string; gate: BoardGate; sha256Ct: string; payload?: { attn?: unknown }; source?: 'board' | 'haven' },
  attestKey: Uint8Array,
  atUnix: number,
): ReceiptCheck {
  const attn = rec.payload?.attn
  if (rec.source === 'haven') return verifyHavenAttestation(attn, rec.gate, rec.owner, rec.sha256Ct, attestKey, atUnix)
  return verifyMemberReceipt(attn, rec.gate, rec.owner, attestKey, atUnix)
}

// ── Minting (the member's side) ─────────────────────────────────────────

export interface AttestRequestFields {
  /** Lowercase 0x wallet address. */
  holder: string
  gate: BoardGate
  epoch: number
  /** uint256 as decimal string; fresh random per request (the canister rejects reuse). */
  nonce: string
  eip712ChainId: bigint
  /** 0x address in the HavenAOL EIP-712 domain. */
  verifyingContract: string
}

export interface AttestRequestTypedData {
  domain: { name: string; chainId: bigint; verifyingContract: string }
  types: typeof ATTEST_REQUEST_TYPES
  primaryType: 'AttestRequest'
  message: { evmAddress: string; cidHash: `0x${string}`; nonce: bigint }
}

/** What a browser wallet signs (`signTypedData`). Identical bytes to `attestRequestDigest`. */
export function attestRequestTypedData(f: AttestRequestFields): AttestRequestTypedData {
  return {
    domain: { name: AOL_EIP712_NAME, chainId: f.eip712ChainId, verifyingContract: f.verifyingContract },
    types: ATTEST_REQUEST_TYPES,
    primaryType: 'AttestRequest',
    message: { evmAddress: f.holder, cidHash: `0x${memberCidHash(f.gate, f.epoch)}`, nonce: BigInt(f.nonce) },
  }
}

function word(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(32)
  out.set(b, 32 - b.length)
  return out
}

function uint256(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('uint256: negative')
  return word(fromHex(n.toString(16).padStart(64, '0')))
}

/** EIP-712 digest a raw signer (agent wallet) signs: keccak(0x1901 ‖ domainSeparator ‖ structHash). */
export function attestRequestDigest(f: AttestRequestFields): Uint8Array {
  const domain = keccak_256(concat([keccak_256(utf8Encode(AOL_DOMAIN_TYPE)), keccak_256(utf8Encode(AOL_EIP712_NAME)), uint256(f.eip712ChainId), word(fromHex(f.verifyingContract))]))
  const struct = keccak_256(concat([keccak_256(utf8Encode(ATTEST_REQUEST_TYPE)), word(fromHex(f.holder)), fromHex(memberCidHash(f.gate, f.epoch)), uint256(BigInt(f.nonce))]))
  return keccak_256(concat([new Uint8Array([0x19, 0x01]), domain, struct]))
}

/** Random uint64 nonce as decimal (fits the canister's Nat and any wallet's uint256 display). */
export function randomAttestNonce(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  let n = 0n
  for (const x of b) n = (n << 8n) | BigInt(x)
  return n.toString()
}

/** The Candid record for `attestHolding`, field for field. */
export interface AttestHoldingRequest {
  chain: ChainVariant
  tokenAddress: string
  threshold: bigint
  cidHash: string
  evmAddress: string
  nonce: bigint
  signature: Uint8Array
  eip712ChainId: bigint
  eip712VerifyingContract: string
}

export function attestHoldingRequest(f: AttestRequestFields, signature: Uint8Array): AttestHoldingRequest {
  if (signature.length !== 65) throw new Error('attestHoldingRequest: signature must be 65 bytes')
  return {
    chain: f.gate.chain,
    tokenAddress: f.gate.tokenAddress.toLowerCase(),
    threshold: f.gate.threshold,
    cidHash: memberCidHash(f.gate, f.epoch),
    evmAddress: f.holder.toLowerCase(),
    nonce: BigInt(f.nonce),
    signature,
    eip712ChainId: f.eip712ChainId,
    eip712VerifyingContract: f.verifyingContract,
  }
}

/** Canister `#ok` payload, as decoded from Candid. */
export interface AttestHoldingOk {
  attestation: { evmAddress: string; tokenAddress: string; threshold: bigint; balanceAtCheck: bigint; cidHash: string; timestamp: bigint }
  signature: Uint8Array
}

/** Turn the canister's answer into the receipt readers verify. Throws if the canister echoed other fields than requested. */
export function receiptFromAttestation(f: AttestRequestFields, ok: AttestHoldingOk): MemberReceipt {
  const a = ok.attestation
  if (a.cidHash.toLowerCase().replace(/^0x/, '') !== memberCidHash(f.gate, f.epoch)) throw new Error('receipt: canister bound a different cidHash')
  if (a.evmAddress.toLowerCase() !== f.holder.toLowerCase()) throw new Error('receipt: canister attested a different address')
  if (a.tokenAddress.toLowerCase() !== f.gate.tokenAddress.toLowerCase() || a.threshold !== f.gate.threshold) throw new Error('receipt: canister attested a different gate')
  const r: MemberReceipt = { epoch: f.epoch, at: Number(a.timestamp), bal: a.balanceAtCheck.toString(), sig: toHex(ok.signature) }
  if (epochOf(r.at) !== r.epoch) throw new Error(`receipt: canister clock is in epoch ${epochOf(r.at)}, requested ${r.epoch}; retry`)
  return r
}

/** Seconds of validity left on a receipt as of `now`; ≤ 0 means re-mint. */
export function receiptRemaining(r: MemberReceipt, now: number): number {
  return r.at + RECEIPT_TTL_SECONDS - now
}
