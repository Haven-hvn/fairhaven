'use client'

/**
 * Sealed-piece retrieval, scoped the way the writer uploaded it.
 *
 * A bare `synapse.storage.download({ pieceCid })` from a throwaway account
 * discovers no providers: the StorageManager races an empty candidate set
 * and surfaces "All provider retrieval attempts failed ... Too many
 * promises rejected" for every file. haven-mobile (foc-cache) and
 * haven-dapp avoid this by scoping retrieval to the uploader: Filecoin
 * chain from the gate network, FilBeam host keyed by the record owner.
 * This module does the same: owner-aware `resolvePieceUrl` (FilBeam
 * first, PDP chain fallback) over a resumable fetch, with the
 * StorageManager download only as a last resort.
 */

import { fetchResumable, withRetry } from './retrieve'

/** Filecoin chain ids (not EIP-155): mainnet 314, calibration 314159. */
export function filecoinChainIdForGate(gateChain?: string): 314 | 314159 {
  // Ungated/unknown defaults to calibration, matching haven-mobile:
  // published sealed content to date is testnet, and mainnet Beam 404s it.
  if (gateChain === undefined) return 314159
  return gateChain === 'EthSepolia' ? 314159 : 314
}

const OWNER_RE = /^0x[0-9a-fA-F]{40}$/

/** FilBeam retrieval URL for a piece, keyed by the uploader wallet. */
export function filbeamUrl(owner: string, pieceCid: string, filecoinChainId: 314 | 314159): string | undefined {
  if (!OWNER_RE.test(owner)) return undefined
  const host = filecoinChainId === 314159 ? 'calibration.filbeam.io' : 'filbeam.io'
  return `https://${owner.toLowerCase()}.${host}/${pieceCid}`
}

export interface SealedFetchOptions {
  piece: string
  /** Arkiv record owner (uploader wallet). */
  owner?: string
  /** Gate chain variant (`EthSepolia`, `BaseMainnet`, ...), when gated. */
  gateChain?: string
  source: string
  withCdn: boolean
  /** Skip owner-aware resolution; go straight to the StorageManager download. */
  forceStorage?: boolean
  signal?: AbortSignal
  onProgress?: (received: number, total?: number) => void
}

export async function fetchSealedBytes(opts: SealedFetchOptions): Promise<Uint8Array> {
  const { Synapse } = await import('@filoz/synapse-sdk')
  const { getChain } = await import('@filoz/synapse-core/chains')
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
  const chainId = filecoinChainIdForGate(opts.gateChain)
  const synapse = Synapse.create({
    account: privateKeyToAccount(generatePrivateKey()),
    chain: getChain(chainId),
    source: opts.source,
    withCDN: opts.withCdn,
  })

  // Owner-aware resolution first: FilBeam (CDN) then on-chain PDP datasets
  // of the uploader — the candidates a bare download never constructs.
  if (!opts.forceStorage && opts.owner && OWNER_RE.test(opts.owner)) {
    try {
      const { tryFrom, resolvePieceUrl, filbeamResolver, chainResolver } = await import('@filoz/synapse-core/piece')
      const parsed = tryFrom(opts.piece)
      if (parsed != null) {
        const url = await resolvePieceUrl({
          address: opts.owner.toLowerCase() as `0x${string}`,
          client: synapse.client,
          pieceCid: parsed,
          resolvers: [filbeamResolver, chainResolver],
          ...(opts.signal ? { signal: opts.signal } : {}),
        })
        return await fetchResumable(url, {
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        })
      }
    } catch (e) {
      if (opts.signal?.aborted) throw e
      // Fall through to the StorageManager download below.
    }
  }

  const piece = opts.piece
  const bytes = await withRetry(() => synapse.storage.download({ pieceCid: piece, withCDN: opts.withCdn }), {
    ...(opts.signal ? { signal: opts.signal } : {}),
    attempts: 2,
  })
  const out = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer)
  opts.onProgress?.(out.length, out.length)
  return out
}
