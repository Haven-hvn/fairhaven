'use client'

/**
 * Writes: threads, replies, board definitions, and owner deletes. Each write
 * is one Arkiv transaction signed by the poster's own wallet — no server, no
 * relayer. Sealed fields go through `lib/aol`; media bytes are pinned to
 * Filecoin via Synapse before the index record is written.
 */

import {
  MIME_TO_ENUM,
  buildDefWrite,
  buildPostWrite,
  buildThreadWrite,
  clampPostTtl,
  currentEpoch,
  type BoardGate,
  type BoardPayload,
  type EntityWrite,
  type ResolvedBoard,
  type ThreadRecord,
} from '@fairhaven/board-core'
import { sealPostParts } from './aol'
import { env } from './env'

/** Structural wallet: wagmi's `useWalletClient` shape. Callers pass `wc as never`. */
export interface BrowserWallet {
  account: { address: string }
  transport: unknown
  switchChain?: (args: { id: number }) => Promise<unknown>
}

export interface WriteProgress {
  stage: 'preparing' | 'sealing' | 'pinning' | 'switching' | 'signing' | 'done'
  uploaded?: number
  total?: number
}

export type ProgressFn = (p: WriteProgress) => void

/** Button label for a write in flight. Each label names the actual step. */
export function writeProgressLabel(p: WriteProgress): string {
  switch (p.stage) {
    case 'preparing':
      return 'Preparing…'
    case 'sealing':
      return 'Sealing (encrypting)…'
    case 'pinning':
      return `Pinning… ${p.uploaded && p.total ? Math.round((p.uploaded / p.total) * 100) : 0}%`
    case 'switching':
      return 'Switch to Arkiv in wallet…'
    case 'signing':
      return 'Confirm in wallet…'
    case 'done':
      return 'Done'
  }
}

/**
 * Label for the optimistic preview of a write that has not landed yet.
 * Nothing here is on Arkiv until `submit*` resolves, so say so.
 */
export function pendingProgressLabel(stage: string | undefined): string {
  switch (stage) {
    case 'sealing':
      return 'not posted yet — sealing (encrypting)…'
    case 'pinning':
      return 'not posted yet — pinning media…'
    case 'switching':
      return 'not posted yet — switch to Arkiv in your wallet…'
    case 'signing':
      return 'not posted yet — confirm in your wallet…'
    case 'done':
      return 'confirming on Arkiv…'
    default:
      return 'not posted yet — preparing…'
  }
}

function toBlocks(expiresInS: number): number {
  return Math.max(1, Math.floor(expiresInS / 2))
}

/** Reject if the wallet never answers, instead of sitting on a stale stage forever. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withWalletTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for the wallet to ${what} — check your wallet and try again`)), 60_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function arkivWallet(wallet: BrowserWallet, onProgress?: ProgressFn) {
  const { custom } = await import('viem')
  const chains = await import('@arkiv-network/sdk/chains')
  // NOTE: the Arkiv-extended client factory, not viem's. A plain viem wallet
  // client has no `createEntity`/`deleteEntity`, so no Arkiv tx (and no
  // signing prompt) would ever happen.
  const { createWalletClient, ExpirationTime } = await import('@arkiv-network/sdk')
  const local = env.arkivRpcUrl.includes('localhost') || env.arkivRpcUrl.includes('127.0.0.1')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain = ((local ? (chains as any).localhost : (chains as any).tiramisu) ?? (chains as any).tiramisu) as any
  const address = wallet.account.address as `0x${string}`
  // The EIP-1193 provider lives behind the wallet client's transport, but
  // not at `.value`: viem's `custom()` transport carries no value, so that
  // lookup only ever worked via an injected `window.ethereum` and failed
  // outright for WalletConnect/AppKit wallets. Use the transport's own
  // `request` (present on every wagmi wallet client), then fall back.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transport = wallet.transport as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walletRequest = (wallet as any).request as unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider: any =
    transport?.value?.request
      ? transport.value
      : typeof transport?.request === 'function'
        ? { request: transport.request.bind(transport) }
        : typeof walletRequest === 'function'
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { request: (walletRequest as any).bind(wallet) }
          : typeof window !== 'undefined'
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (window as any).ethereum
            : undefined
  if (!provider?.request) throw new Error('wallet provider not available for signing')
  // Sign through the connected wallet's own provider (works for injected and
  // WalletConnect alike). Tiramisu is NOT in the AppKit/wagmi network list
  // (those are the EVM gate chains), so a wallet left on it makes AppKit show
  // its unsupported-network screen. The switch stays mandatory — viem
  // refuses to send a Tiramisu tx from another chain anyway — but, following
  // the haven-dapp drip pattern of keeping Arkiv writes outside wagmi, the
  // caller restores the pre-write network via `restoreNetwork` afterwards,
  // so the wallet never stays on Tiramisu.
  let previousChainIdHex: string | undefined
  try {
    const id: unknown = await provider.request({ method: 'eth_chainId' })
    if (typeof id === 'string' && /^0x[0-9a-fA-F]+$/.test(id)) previousChainIdHex = id
  } catch {
    // Unknown pre-write chain: nothing to restore to.
  }
  const chainIdHex = `0x${Number(chain.id).toString(16)}`
  /** Best-effort return to the pre-write network; never masks the write. */
  const restoreNetwork = async (): Promise<void> => {
    if (!previousChainIdHex || previousChainIdHex.toLowerCase() === chainIdHex.toLowerCase()) return
    try {
      await withWalletTimeout(provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: previousChainIdHex }] }), 'switch back to the previous chain')
    } catch {
      // The write already landed (or failed on its own merits); a refused
      // switch-back must not turn that into a second error.
    }
  }
  onProgress?.({ stage: 'switching' })
  try {
    await withWalletTimeout(provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] }), 'switch to the Arkiv chain')
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = (e as any)?.code
    if (code !== 4902) {
      await restoreNetwork()
      throw new Error(`wallet did not switch to the Arkiv chain: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      await withWalletTimeout(
        provider.request({
          method: 'wallet_addEthereumChain',
          params: [{ chainId: chainIdHex, chainName: String(chain.name ?? 'Arkiv'), rpcUrls: [env.arkivRpcUrl], nativeCurrency: chain.nativeCurrency }],
        }),
        'add the Arkiv chain',
      )
      await withWalletTimeout(provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] }), 'switch to the Arkiv chain')
    } catch (addErr) {
      await restoreNetwork()
      throw new Error(`wallet did not switch to the Arkiv chain: ${addErr instanceof Error ? addErr.message : String(addErr)}`)
    }
  }
  const client = createWalletClient({ account: address, chain, transport: custom(provider) } as never)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (client as any).createEntity !== 'function') throw new Error('Arkiv wallet client unavailable (createEntity missing)')
  return { client, ExpirationTime, restoreNetwork }
}

async function sendWrite(wallet: BrowserWallet, w: EntityWrite, onProgress?: ProgressFn): Promise<{ key: string; txHash: string }> {
  const { client, ExpirationTime, restoreNetwork } = await arkivWallet(wallet, onProgress)
  try {
    const { i32, str, u256 } = await import('@arkiv-network/sdk/attr')
    const attributes: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(w.attributes)) {
      attributes[k] = typeof v === 'bigint' ? u256(v) : typeof v === 'number' ? i32(v) : str(v)
    }
    onProgress?.({ stage: 'signing' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (client as any).createEntity({
      payload: w.payload,
      contentType: w.contentType,
      attributes,
      expires: ExpirationTime.fromBlocks(toBlocks(w.expiresIn)),
    })
    onProgress?.({ stage: 'done' })
    return { key: String(res.entityKey).toLowerCase(), txHash: String(res.txHash) }
  } finally {
    await restoreNetwork()
  }
}

async function pinMedia(bytes: Uint8Array, onProgress?: ProgressFn): Promise<string> {
  const { Synapse } = await import('@filoz/synapse-sdk')
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
  // Reads/uploads bootstrap off a throwaway key (haven-dapp pattern); the
  // commit is paid from the wallet's Filecoin arrangements.
  const synapse = Synapse.create({ account: privateKeyToAccount(generatePrivateKey()), source: 'fairhaven-web', withCDN: env.synapseEnableCdn })
  onProgress?.({ stage: 'pinning', uploaded: 0, total: bytes.length })
  const result = await synapse.storage.upload(bytes, { withCDN: env.synapseEnableCdn } as never)
  onProgress?.({ stage: 'pinning', uploaded: bytes.length, total: bytes.length })
  return String(result.pieceCid)
}

export interface SubmitThreadArgs {
  wallet: BrowserWallet
  board: ResolvedBoard
  subject: string
  text: string
  sealText: boolean
  file?: File
  sealMedia: boolean
  onProgress?: ProgressFn
}

export async function submitThread(a: SubmitThreadArgs): Promise<{ key: string; txHash: string }> {
  const epoch = currentEpoch()
  const fileBytes = a.file ? new Uint8Array(await a.file.arrayBuffer()) : undefined
  if (fileBytes && fileBytes.length > 25 * 1024 * 1024) throw new Error('file is over the 25 MB limit')
  // Only call it sealing when something is actually being encrypted.
  a.onProgress?.({ stage: a.sealText || (fileBytes && a.sealMedia) ? 'sealing' : 'preparing' })
  const sealed = await sealPostParts(a.board.ref.gate, a.text, a.sealText, fileBytes, a.sealMedia, epoch)
  const payload: BoardPayload = { v: 1, text: sealed.textField, ...(sealed.gateJson ? { gate: sealed.gateJson } : {}) }
  if (fileBytes && a.file) {
    const mimeType = a.file.type || 'application/octet-stream'
    const mime = MIME_TO_ENUM[mimeType] ?? MIME_TO_ENUM[mimeType.split(';')[0]?.trim() ?? ''] ?? 0
    const locator = await pinMedia(sealed.mediaBytes ?? fileBytes, a.onProgress)
    const storedBytes = sealed.mediaBytes ?? fileBytes
    const { sha256Hex } = await import('@fairhaven/board-core')
    payload.media = {
      ...(a.sealMedia ? { piece: locator } : { fcid: locator }),
      mime,
      size: storedBytes.length,
      ...(a.file.name ? { name: a.file.name } : {}),
      sha256: await sha256Hex(storedBytes),
    }
  }
  const w = buildThreadWrite({ board: a.board.ref.slug, subject: a.subject, gate: a.board.ref.gate, payload, sha256Ct: sealed.sha256Ct, expiresIn: a.board.threadTtlS })
  return sendWrite(a.wallet as BrowserWallet, w, a.onProgress)
}

export interface SubmitReplyArgs {
  wallet: BrowserWallet
  board: ResolvedBoard
  root: ThreadRecord
  parentKey?: string
  text: string
  sealText: boolean
  noBump: boolean
  currentBlock?: number
  onProgress?: ProgressFn
}

export async function submitReply(a: SubmitReplyArgs): Promise<{ key: string; txHash: string }> {
  const epoch = currentEpoch()
  // Only call it sealing when something is actually being encrypted.
  a.onProgress?.({ stage: a.sealText ? 'sealing' : 'preparing' })
  const sealed = await sealPostParts(a.board.ref.gate, a.text, a.sealText, undefined, false, epoch)
  const payload: BoardPayload = { v: 1, text: sealed.textField, ...(sealed.gateJson ? { gate: sealed.gateJson } : {}) }
  const parent = a.parentKey && a.parentKey.toLowerCase() !== a.root.key ? a.parentKey.toLowerCase() : undefined
  const rootRemaining = a.root.expiresAt !== undefined && a.currentBlock !== undefined ? (a.root.expiresAt - a.currentBlock) * 2 : undefined
  const w = buildPostWrite({
    board: a.board.ref.slug,
    rootRef: a.root.key,
    ...(parent ? { parentRef: parent } : {}),
    noBump: a.noBump,
    gate: a.board.ref.gate,
    payload,
    sha256Ct: sealed.sha256Ct,
    expiresIn: clampPostTtl(a.board.postTtlS, rootRemaining),
  })
  return sendWrite(a.wallet as BrowserWallet, w, a.onProgress)
}

export interface SubmitBoardDefArgs {
  wallet: BrowserWallet
  board: string
  title: string
  about: string
  gate: BoardGate
  bumpLimit: number
  capacity: number
  pageSize: number
  sealText: boolean
  sealMedia: boolean
  threadTtlS: number
  postTtlS: number
  expiresIn: number
  onProgress?: ProgressFn
}

export async function submitBoardDef(a: SubmitBoardDefArgs): Promise<{ key: string; txHash: string }> {
  const w = buildDefWrite({
    board: a.board,
    title: a.title,
    about: a.about,
    gate: a.gate,
    bumpLimit: a.bumpLimit,
    capacity: a.capacity,
    pageSize: a.pageSize,
    defaults: { sealText: a.sealText, sealMedia: a.sealMedia },
    ttl: { thread_s: a.threadTtlS, post_s: a.postTtlS },
    expiresIn: a.expiresIn,
  })
  return sendWrite(a.wallet as BrowserWallet, w, a.onProgress)
}

/** Owner-only delete (Arkiv DELETE by the record owner). */
export async function deletePost(wallet: BrowserWallet, key: string): Promise<{ txHash: string }> {
  const { client, restoreNetwork } = await arkivWallet(wallet)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (client as any).deleteEntity({ entityKey: key as `0x${string}` })
    return { txHash: String(res.txHash) }
  } finally {
    await restoreNetwork()
  }
}
