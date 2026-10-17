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
  stage: 'sealing' | 'pinning' | 'indexing' | 'done'
  uploaded?: number
  total?: number
}

export type ProgressFn = (p: WriteProgress) => void

function toBlocks(expiresInS: number): number {
  return Math.max(1, Math.floor(expiresInS / 2))
}

async function arkivWallet(wallet: BrowserWallet) {
  const { createWalletClient, custom } = await import('viem')
  const chains = await import('@arkiv-network/sdk/chains')
  const { ExpirationTime } = await import('@arkiv-network/sdk')
  const local = env.arkivRpcUrl.includes('localhost') || env.arkivRpcUrl.includes('127.0.0.1')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain = ((local ? (chains as any).localhost : (chains as any).tiramisu) ?? (chains as any).tiramisu) as { id: number }
  const address = wallet.account.address as `0x${string}`
  // Sign through the connected wallet's own provider (works for injected and
  // WalletConnect alike); the chain id on the tx is Arkiv's, so ask the
  // wallet to switch first — rejection surfaces as a clear wallet error.
  try {
    await wallet.switchChain?.({ id: chain.id })
  } catch {
    /* the send below surfaces a clear chain error */
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = ((wallet.transport as any)?.value ?? (typeof window !== 'undefined' ? (window as any).ethereum : undefined)) as any
  if (!provider?.request) throw new Error('wallet provider not available for signing')
  const client = createWalletClient({ account: address, chain: chain as never, transport: custom(provider) } as never)
  return { client, ExpirationTime }
}

async function sendWrite(wallet: BrowserWallet, w: EntityWrite, onProgress?: ProgressFn): Promise<{ key: string; txHash: string }> {
  const { client, ExpirationTime } = await arkivWallet(wallet)
  const { i32, str } = await import('@arkiv-network/sdk/attr')
  const attributes: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(w.attributes)) {
    attributes[k] = typeof v === 'number' ? i32(v) : str(v)
  }
  onProgress?.({ stage: 'indexing' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (client as any).createEntity({
    payload: w.payload,
    contentType: w.contentType,
    attributes,
    expires: ExpirationTime.fromBlocks(toBlocks(w.expiresIn)),
  })
  onProgress?.({ stage: 'done' })
  return { key: String(res.entityKey).toLowerCase(), txHash: String(res.txHash) }
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
  a.onProgress?.({ stage: 'sealing' })
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
  a.onProgress?.({ stage: 'sealing' })
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
  return sendWrite(a.wallet as BrowserWallet, w)
}

/** Owner-only delete (Arkiv DELETE by the record owner). */
export async function deletePost(wallet: BrowserWallet, key: string): Promise<{ txHash: string }> {
  const { client } = await arkivWallet(wallet)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (client as any).deleteEntity({ entityKey: key as `0x${string}` })
  return { txHash: String(res.txHash) }
}
