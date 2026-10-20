'use client'

/**
 * Haven-AOL v3 access for the Fairhaven web client: epoch unlock (one
 * EIP-712 `GateRequestV3` signature per board per 30-day epoch), sealed-text
 * opening, and post sealing.
 *
 * Read flow (§SPEC 3): sign → `requestDecryptionKeyV3` → `recoverVetKey` →
 * cache per `(chain, token, threshold, epoch)` → IBE-unwrap each sealed field
 * locally. Write flow: fresh AES-256 key per post, Haven framed AES-GCM via
 * board-core, IBE-wrap under the canister's VetKD derived public key,
 * canonical v3 gate JSON.
 *
 * The v3 canister actor is defined here (the TS SDK ships v3 derivation and
 * metadata but no v3 actor — same split as haven-dapp's `haven-aol-client`).
 */

import {
  CHAIN_VARIANTS,
  decodeTextPlain,
  encodeTextPlain,
  freshAesKey,
  gateCidForText,
  openAny,
  sealFramed,
  sha256Hex,
  toBase64,
  fromBase64,
  type BoardGate,
  type BoardPayload,
  type ChainVariant,
} from '@fairhaven/board-core'
import { env } from './env'

export interface WalletClientLike {
  account: { address: string }
  signTypedData: (args: { domain: Record<string, unknown>; types: Record<string, unknown[]>; primaryType: string; message: Record<string, unknown> }) => Promise<string>
}

export interface ParsedGate {
  version: number
  epoch?: number
  gate: BoardGate
}

/** Parse any Haven gate JSON; v1/v4 stay readable so callers can link out. */
export function parseGateJson(json: string): ParsedGate | undefined {
  try {
    const raw = JSON.parse(json) as { version?: unknown; epoch?: unknown; chain?: unknown; tokenAddress?: unknown; threshold?: unknown }
    if (typeof raw.version !== 'number') return undefined
    if (typeof raw.chain !== 'string' || !(CHAIN_VARIANTS as readonly string[]).includes(raw.chain)) return undefined
    if (typeof raw.tokenAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw.tokenAddress)) return undefined
    const threshold = typeof raw.threshold === 'string' && /^\d+$/.test(raw.threshold) ? BigInt(raw.threshold) : undefined
    if (threshold === undefined || threshold <= 0n) return undefined
    const gate: BoardGate = { chain: raw.chain as ChainVariant, tokenAddress: raw.tokenAddress.toLowerCase(), threshold }
    return {
      version: raw.version,
      ...(typeof raw.epoch === 'number' && Number.isInteger(raw.epoch) ? { epoch: raw.epoch } : {}),
      gate,
    }
  } catch {
    return undefined
  }
}

// ── VetKey cache ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VetKey = any

const vetKeys = new Map<string, VetKey>()

function cacheKey(gate: BoardGate, epoch: number): string {
  return `${gate.chain}:${gate.tokenAddress}:${gate.threshold.toString()}:${epoch}`
}

/** True when this device already holds the epoch key (no signature needed). */
export function hasUnlocked(gate: BoardGate, epoch: number): boolean {
  return vetKeys.has(cacheKey(gate, epoch))
}

/** Drop all epoch keys (wallet disconnect). Sealed bytes follow via `clearOpened`. */
export function forgetKeys(): void {
  vetKeys.clear()
}

// ── Signing on the EIP-712 chain ────────────────────────────────────────────
// viem's `signTypedData` rejects when the signature domain's `chainId`
// differs from the wallet's active chain ("Active chainId is 0x2105 but
// received 0x1"). The Haven-AOL domain lives on `env.eip712ChainId`
// (Ethereum mainnet by default) while the wallet usually sits on the gate
// chain (e.g. Base 8453), so switch there for the signature and back
// afterwards — the same switch-and-restore shape as the Arkiv write path
// in `lib/post`. Wallets without a reachable provider sign as-is.

/** Minimal provider surface needed to switch chains around a signature. */
export interface SwitchableWallet extends WalletClientLike {
  transport?: unknown
  request?: unknown
}

function providerOf(wallet: SwitchableWallet): { request: (args: { method: string; params?: unknown }) => Promise<unknown> } | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = wallet as any
  const transport = w.transport as any
  if (transport?.value?.request) return transport.value
  if (typeof transport?.request === 'function') return { request: transport.request.bind(transport) }
  if (typeof w.request === 'function') return { request: w.request.bind(wallet) }
  if (typeof window !== 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eth = (window as any).ethereum
    if (eth?.request) return eth
  }
  return undefined
}

/**
 * `wallet.signTypedData` with the wallet temporarily switched to `chainId`
 * (the EIP-712 domain chain). Restores the previous chain afterwards without
 * masking the signature result. Skips switching when the wallet is already
 * there or exposes no provider (tests, agent signers).
 */
export async function signTypedDataOnChain(
  wallet: SwitchableWallet,
  args: { domain: Record<string, unknown>; types: Record<string, unknown[]>; primaryType: string; message: Record<string, unknown> },
  chainId: bigint = env.eip712ChainId,
): Promise<string> {
  const provider = providerOf(wallet)
  if (!provider) return wallet.signTypedData(args)
  const want = `0x${Number(chainId).toString(16)}`
  let previous: string | undefined
  try {
    const id: unknown = await provider.request({ method: 'eth_chainId' })
    if (typeof id === 'string' && /^0x[0-9a-fA-F]+$/.test(id)) previous = id
  } catch { /* nothing to restore to */ }
  const needSwitch = !previous || previous.toLowerCase() !== want.toLowerCase()
  if (needSwitch) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] })
    } catch (e) {
      throw new Error(`wallet did not switch to the signature chain: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  try {
    return await wallet.signTypedData(args)
  } finally {
    if (needSwitch && previous && previous.toLowerCase() !== want.toLowerCase()) {
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: previous }] })
      } catch { /* the signature already settled; never mask it */ }
    }
  }
}

// ── Canister plumbing ───────────────────────────────────────────────────────

export async function agent() {
  const { HttpAgent, AnonymousIdentity } = await import('@icp-sdk/core/agent')
  const a = await HttpAgent.create({ host: env.icpHost, identity: new AnonymousIdentity(), verifyQuerySignatures: false })
  if (env.fetchRootKey) await a.fetchRootKey()
  return a
}

async function v3Actor() {
  const { Actor } = await import('@icp-sdk/core/agent')
  const { IDL } = await import('@icp-sdk/core/candid')
  const chainVariant = IDL.Variant({ EthMainnet: IDL.Null, EthSepolia: IDL.Null, ArbitrumOne: IDL.Null, BaseMainnet: IDL.Null, OptimismMainnet: IDL.Null })
  const req = IDL.Record({
    chain: chainVariant,
    tokenAddress: IDL.Text,
    threshold: IDL.Nat,
    epoch: IDL.Nat,
    evmAddress: IDL.Text,
    transportPublicKey: IDL.Vec(IDL.Nat8),
    nonce: IDL.Nat,
    signature: IDL.Vec(IDL.Nat8),
    eip712ChainId: IDL.Nat,
    eip712VerifyingContract: IDL.Text,
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
  })
  const res = IDL.Variant({ ok: IDL.Record({ encrypted_key: IDL.Vec(IDL.Nat8), verification_key: IDL.Vec(IDL.Nat8) }), err })
  const factory = () => IDL.Service({ requestDecryptionKeyV3: IDL.Func([req], [res], []) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Actor.createActor(factory, { agent: await agent(), canisterId: env.havenAolCanisterId }) as any
}

function randomNonce(): bigint {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return BigInt(`0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`)
}

function gateErrorMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'canister rejected the unlock'
  if ('InsufficientBalance' in err) return 'this wallet does not hold the gate token at this epoch'
  if ('InvalidEpoch' in err) return 'epoch not open for unlock yet — try again shortly'
  if ('NonceAlreadyUsed' in err) return 'nonce collision — try again'
  if ('InvalidSignature' in err) return `invalid signature: ${String((err as Record<string, unknown>).InvalidSignature)}`
  if ('EvmRpcError' in err) return `gate RPC error: ${String((err as Record<string, unknown>).EvmRpcError)}`
  if ('VetKDError' in err) return `key error: ${String((err as Record<string, unknown>).VetKDError)}`
  return 'canister rejected the unlock'
}

/**
 * Unlock one `(gate, epoch)`: sign `GateRequestV3`, fetch the epoch VetKey,
 * cache it on this device. Progress messages go to `onProgress`.
 */
export async function unlock(wallet: WalletClientLike, gate: BoardGate, epoch: number, onProgress?: (msg: string | null) => void): Promise<void> {
  const address = wallet.account.address
  if (!address) throw new Error('wallet not connected')
  const sdk = await import('haven-aol')
  onProgress?.('Preparing signature…')
  const { secretKey, publicKey } = sdk.createTransportKeyPair()
  const nonce = randomNonce()
  const typed = sdk.buildGateRequestV3TypedData({
    evmAddress: address,
    transportPublicKey: publicKey,
    epoch,
    nonce,
    eip712ChainId: env.eip712ChainId,
    eip712VerifyingContract: env.eip712VerifyingContract,
  })
  onProgress?.('Sign to unlock (no gas)…')
  let signatureHex: string
  try {
    signatureHex = await signTypedDataOnChain(wallet, {
      domain: typed.domain as unknown as Record<string, unknown>,
      types: typed.types as unknown as Record<string, unknown[]>,
      primaryType: typed.primaryType,
      message: { ...typed.message, epoch: BigInt(typed.message.epoch), nonce: BigInt(typed.message.nonce) } as unknown as Record<string, unknown>,
    })
  } catch (e) {
    throw new Error(`signature rejected: ${e instanceof Error ? e.message : String(e)}`)
  }
  const signature = sdk.parseSignatureHex(signatureHex)
  onProgress?.('Requesting epoch key…')
  const actor = await v3Actor()
  const raw = await actor.requestDecryptionKeyV3({
    chain: { [gate.chain]: null },
    tokenAddress: gate.tokenAddress,
    threshold: gate.threshold,
    epoch: BigInt(epoch),
    evmAddress: address,
    transportPublicKey: publicKey,
    nonce,
    signature,
    eip712ChainId: env.eip712ChainId,
    eip712VerifyingContract: env.eip712VerifyingContract,
  })
  if (!('ok' in raw)) throw new Error(gateErrorMessage((raw as { err: unknown }).err))
  onProgress?.('Recovering key…')
  const derivationInput = await sdk.computeDerivationInputV3(gate.chain, gate.tokenAddress, gate.threshold, epoch)
  const vetKey = sdk.recoverVetKey(new Uint8Array(raw.ok.encrypted_key), secretKey, new Uint8Array(raw.ok.verification_key), derivationInput)
  vetKeys.set(cacheKey(gate, epoch), vetKey)
  onProgress?.(null)
}

/**
 * Unwrap the post AES key for a v3 gate record. Text and media on one post
 * share the key, so media opens through the same record the text uses.
 */
export async function aesKeyForGate(gateJson: string): Promise<Uint8Array> {
  const g = parseGateJson(gateJson)
  if (!g) throw new Error('unreadable gate')
  if (g.version !== 3 || g.epoch === undefined) throw new Error(`sealed with protocol v${g.version}`)
  const vetKey = vetKeys.get(cacheKey(g.gate, g.epoch))
  if (!vetKey) throw new Error('epoch key not unlocked on this device')
  const sdk = await import('haven-aol')
  return sdk.ibeDecryptAesKey((JSON.parse(gateJson) as { encryptedAesKey: string }).encryptedAesKey, vetKey)
}

/** Open a sealed-text field of a board payload. Throws when locked or foreign. */
export async function openSealedText(payload: BoardPayload): Promise<string> {
  if (!('sealed' in payload.text)) throw new Error('text is not sealed')
  if (!payload.gate) throw new Error('sealed text without a gate')
  const g = parseGateJson(payload.gate)
  if (!g) throw new Error('unreadable gate')
  if (g.version !== 3 || g.epoch === undefined) throw new Error(`sealed with protocol v${g.version}`)
  const vetKey = vetKeys.get(cacheKey(g.gate, g.epoch))
  if (!vetKey) throw new Error('epoch key not unlocked on this device')
  const sdk = await import('haven-aol')
  const aesKey = sdk.ibeDecryptAesKey(JSON.parse(payload.gate).encryptedAesKey as string, vetKey)
  return decodeTextPlain(await openAny(fromBase64(payload.text.sealed), aesKey))
}

// ── Sealing (writes) ────────────────────────────────────────────────────────

let dpkP: Promise<unknown> | undefined

async function derivedPublicKey(): Promise<unknown> {
  return (dpkP ??= (async () => {
    const sdk = await import('haven-aol')
    const vetkeys = await import('@icp-sdk/vetkeys')
    const verificationKey = await sdk.fetchVerificationKey((await agent()) as never, env.havenAolCanisterId)
    return vetkeys.DerivedPublicKey.deserialize(verificationKey)
  })())
}

export interface SealedPostParts {
  textField: BoardPayload['text']
  /** Stored text bytes (sealed bytes if sealed, UTF-8 if clear). */
  textBytes: Uint8Array
  mediaBytes?: Uint8Array
  gateJson?: string
  /** sha256 hex (bare) of the stored text bytes. */
  sha256Ct: string
}

/**
 * Seal one post's fields under a fresh AES-256 key (one key per post).
 * Returns clear fields untouched when nothing is sealed.
 */
export async function sealPostParts(gate: BoardGate, text: string, sealText: boolean, media: Uint8Array | undefined, sealMedia: boolean, epoch: number): Promise<SealedPostParts> {
  if (!sealText && !(media && sealMedia)) {
    const textBytes = new TextEncoder().encode(text)
    return { textField: { clear: text }, textBytes, ...(media ? { mediaBytes: media } : {}), sha256Ct: await sha256Hex(textBytes) }
  }
  const sdk = await import('haven-aol')
  const vetkeys = await import('@icp-sdk/vetkeys')
  const aesKey = freshAesKey()
  const textPlain = encodeTextPlain(text)
  const textBytes = sealText ? await sealFramed(textPlain, aesKey) : new TextEncoder().encode(text)
  const mediaBytes = media ? (sealMedia ? await sealFramed(media, aesKey) : media) : undefined
  // IBE-wrap under the canister's VetKD derived public key for the v3 identity.
  const derivationInput = await sdk.computeDerivationInputV3(gate.chain, gate.tokenAddress, gate.threshold, epoch)
  const dpk = (await derivedPublicKey()) as Parameters<typeof vetkeys.IbeCiphertext.encrypt>[0]
  const identity = vetkeys.IbeIdentity.fromBytes(derivationInput)
  const ct = vetkeys.IbeCiphertext.encrypt(dpk, identity, aesKey, vetkeys.IbeSeed.random())
  const encryptedAesKey = toBase64(ct.serialize())
  // `gate.cid` is a label, not a locator: the web client hashes sealed bytes.
  const cid = gateCidForText(await sha256Hex(textBytes))
  const gateJson = sdk.gateMetadataV3ToJson(sdk.buildGateMetadataV3({ cid, chain: gate.chain, tokenAddress: gate.tokenAddress, threshold: gate.threshold, epoch, encryptedAesKey }))
  return {
    textField: sealText ? { sealed: toBase64(textBytes) } : { clear: text },
    textBytes,
    ...(mediaBytes ? { mediaBytes } : {}),
    gateJson,
    sha256Ct: await sha256Hex(textBytes),
  }
}
