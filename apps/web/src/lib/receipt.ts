'use client'

/**
 * Membership receipts in the browser.
 *
 * Reading: every post's `attn` is verified offline against the Haven-AOL
 * canister's attestation public key (one query ever, cached; or pinned via
 * `NEXT_PUBLIC_HAVEN_ATTEST_PUBKEY`). No `balanceOf`, no RPC per post.
 *
 * Writing: before a member's first post on a gate in an epoch, the wallet
 * signs one EIP-712 `AttestRequest` and the canister checks the balance and
 * returns the receipt. It is kept in localStorage and attached to every post
 * for the rest of the epoch. One signature per gate per 30 days, no gas.
 */

import {
  attestHoldingRequest,
  attestRequestTypedData,
  blockToUnix,
  currentEpoch,
  fromHex,
  gateSpecOf,
  randomAttestNonce,
  receiptFromAttestation,
  receiptRemaining,
  verifyRecordAuthor,
  type AttestHoldingOk,
  type BlockClock,
  type BoardGate,
  type MemberReceipt,
  type ReceiptCheck,
} from '@fairhaven/board-core'
import { agent, type WalletClientLike } from './aol'
import { env } from './env'

// ── Attestation public key ─────────────────────────────────────────────

let keyP: Promise<Uint8Array> | undefined

function keyStorageId(): string {
  return `fh:attest-key:${env.havenAolCanisterId}`
}

/** The canister's Ed25519 attestation key. Pinned by env, else cached after one query. */
export function attestKey(): Promise<Uint8Array> {
  return (keyP ??= (async () => {
    if (env.attestPublicKeyHex) {
      const k = fromHex(env.attestPublicKeyHex)
      if (k.length !== 32) throw new Error('NEXT_PUBLIC_HAVEN_ATTEST_PUBKEY must be 32 bytes of hex')
      return k
    }
    try {
      const cached = typeof localStorage !== 'undefined' ? localStorage.getItem(keyStorageId()) : null
      if (cached && /^[0-9a-f]{64}$/.test(cached)) return fromHex(cached)
    } catch { /* storage unavailable */ }
    const sdk = await import('haven-aol')
    const k = await sdk.fetchAttestationPublicKey(await agent(), env.havenAolCanisterId)
    if (k.length !== 32) throw new Error('canister returned an attestation key that is not 32 bytes')
    try { localStorage.setItem(keyStorageId(), Array.from(k, (b) => b.toString(16).padStart(2, '0')).join('')) } catch { /* memory only */ }
    return k
  })().catch((e) => {
    keyP = undefined
    throw e
  }))
}

// ── Verification ──────────────────────────────────────────────────────

export interface Authored {
  key: string
  owner: string
  gate: BoardGate
  sha256Ct: string
  createdAt: number
  source?: 'board' | 'haven'
  payload?: { attn?: unknown }
}

/** Keys of the records whose author proved membership, plus why the others did not. */
export async function verifyAuthors<T extends Authored>(records: readonly T[], clock: BlockClock | undefined): Promise<{ ok: T[]; rejected: Map<string, ReceiptCheck> }> {
  if (records.length === 0) return { ok: [], rejected: new Map() }
  const key = await attestKey()
  const now = Math.floor(Date.now() / 1000)
  const ok: T[] = []
  const rejected = new Map<string, ReceiptCheck>()
  for (const r of records) {
    const at = clock ? blockToUnix(r.createdAt, clock) : now
    const check = verifyRecordAuthor(r, key, at)
    if (check.ok) ok.push(r)
    else rejected.set(r.key, check)
  }
  return { ok, rejected }
}

export function clockNow(currentBlock: number | undefined): BlockClock | undefined {
  return currentBlock === undefined ? undefined : { currentBlock, observedAtUnix: Math.floor(Date.now() / 1000) }
}

// ── Minting ───────────────────────────────────────────────────────────

/** Re-mint when less than a day of validity is left, so a post never lands with a receipt about to expire. */
const MIN_REMAINING_S = 86_400

function receiptStorageId(gate: BoardGate, holder: string): string {
  return `fh:receipt:${gateSpecOf(gate)}:${holder.toLowerCase()}`
}

export function storedReceipt(gate: BoardGate, holder: string, now: number = Math.floor(Date.now() / 1000)): MemberReceipt | undefined {
  try {
    const raw = localStorage.getItem(receiptStorageId(gate, holder))
    if (!raw) return undefined
    const r = JSON.parse(raw) as MemberReceipt
    if (typeof r.epoch !== 'number' || typeof r.at !== 'number' || typeof r.bal !== 'string' || typeof r.sig !== 'string') return undefined
    return receiptRemaining(r, now) >= MIN_REMAINING_S ? r : undefined
  } catch {
    return undefined
  }
}

export function forgetReceipts(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('fh:receipt:')) localStorage.removeItem(k)
  } catch { /* nothing to forget */ }
}

async function attestActor() {
  const { Actor } = await import('@icp-sdk/core/agent')
  const { IDL } = await import('@icp-sdk/core/candid')
  const chainVariant = IDL.Variant({ EthMainnet: IDL.Null, EthSepolia: IDL.Null, ArbitrumOne: IDL.Null, BaseMainnet: IDL.Null, OptimismMainnet: IDL.Null })
  const req = IDL.Record({
    chain: chainVariant,
    tokenAddress: IDL.Text,
    threshold: IDL.Nat,
    cidHash: IDL.Text,
    evmAddress: IDL.Text,
    nonce: IDL.Nat,
    signature: IDL.Vec(IDL.Nat8),
    eip712ChainId: IDL.Nat,
    eip712VerifyingContract: IDL.Text,
  })
  const attestation = IDL.Record({
    evmAddress: IDL.Text,
    chain: chainVariant,
    tokenAddress: IDL.Text,
    threshold: IDL.Nat,
    balanceAtCheck: IDL.Nat,
    cidHash: IDL.Text,
    timestamp: IDL.Nat,
  })
  const err = IDL.Variant({
    InsufficientBalance: IDL.Record({ required: IDL.Nat, actual: IDL.Nat }),
    InvalidAddress: IDL.Text,
    InvalidThreshold: IDL.Null,
    EvmRpcError: IDL.Text,
    VetKDError: IDL.Text,
    InvalidSignature: IDL.Text,
    NonceAlreadyUsed: IDL.Null,
    InvalidEpoch: IDL.Null,
    MarketCapNotReached: IDL.Record({ required: IDL.Nat, actual: IDL.Nat }),
    InvalidOracle: IDL.Text,
  })
  const res = IDL.Variant({ ok: IDL.Record({ attestation, signature: IDL.Vec(IDL.Nat8) }), err })
  const factory = () => IDL.Service({ attestHolding: IDL.Func([req], [res], []) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Actor.createActor(factory, { agent: await agent(), canisterId: env.havenAolCanisterId }) as any
}

export function describeAttestError(err: Record<string, unknown>): string {
  if ('InsufficientBalance' in err) {
    const e = err.InsufficientBalance as { required: bigint; actual: bigint }
    return `this wallet holds ${e.actual.toString()} of the ${e.required.toString()} required`
  }
  if ('EvmRpcError' in err) return `the canister could not read the gate chain (${String(err.EvmRpcError)}); try again`
  if ('InvalidSignature' in err) return `the canister rejected the wallet signature (${String(err.InvalidSignature)})`
  if ('NonceAlreadyUsed' in err) return 'nonce reused; try again'
  const k = Object.keys(err)[0] ?? 'unknown'
  return `canister refused: ${k}${typeof err[k] === 'string' ? ` (${err[k] as string})` : ''}`
}

export type ReceiptProgress = (msg: string | null) => void

/** A receipt for this wallet on this gate, minting one when none is stored. */
export async function ensureReceipt(wallet: WalletClientLike, gate: BoardGate, onProgress?: ReceiptProgress): Promise<MemberReceipt> {
  const holder = wallet.account.address.toLowerCase()
  const have = storedReceipt(gate, holder)
  if (have) return have
  const epoch = currentEpoch()
  const fields = { holder, gate, epoch, nonce: randomAttestNonce(), eip712ChainId: env.eip712ChainId, verifyingContract: env.eip712VerifyingContract }
  const typed = attestRequestTypedData(fields)
  onProgress?.('sign once to prove membership for 30 days (no gas)…')
  const sigHex = await wallet.signTypedData({
    domain: typed.domain as unknown as Record<string, unknown>,
    types: typed.types as unknown as Record<string, unknown[]>,
    primaryType: typed.primaryType,
    message: typed.message as unknown as Record<string, unknown>,
  })
  const sdk = await import('haven-aol')
  const signature = sdk.parseSignatureHex(sigHex)
  onProgress?.('canister is checking your balance…')
  const actor = await attestActor()
  const req = attestHoldingRequest(fields, signature)
  const result = (await actor.attestHolding({
    chain: { [req.chain]: null },
    tokenAddress: req.tokenAddress,
    threshold: req.threshold,
    cidHash: req.cidHash,
    evmAddress: req.evmAddress,
    nonce: req.nonce,
    signature: req.signature,
    eip712ChainId: req.eip712ChainId,
    eip712VerifyingContract: req.eip712VerifyingContract,
  })) as { ok: AttestHoldingOk & { attestation: AttestHoldingOk['attestation'] & { chain: Record<string, null> } } } | { err: Record<string, unknown> }
  if ('err' in result) throw new Error(describeAttestError(result.err))
  const okRes: AttestHoldingOk = { attestation: result.ok.attestation, signature: new Uint8Array(result.ok.signature) }
  const receipt = receiptFromAttestation(fields, okRes)
  try { localStorage.setItem(receiptStorageId(gate, holder), JSON.stringify(receipt)) } catch { /* memory only */ }
  onProgress?.(null)
  return receipt
}
