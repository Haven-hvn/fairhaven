import type { ChainVariant } from './constants.ts'

/** A Haven gate: who may read. */
export interface BoardGate {
  chain: ChainVariant
  /** Lowercase 0x address. */
  tokenAddress: string
  /** Raw `balanceOf` units. > 0. */
  threshold: bigint
}

/**
 * Board identity. A board is a gate. A `haven.board.def` entity gives it a
 * slug, title, and ordering constants; without one, clients derive an implicit
 * slug from the gate (`g.<chainId>.<token[2..14]>`) and use defaults.
 */
export interface BoardRef {
  slug: string
  gate: BoardGate
}

/** Minimal entity shape as returned by any Arkiv client (SDK, backend, test). */
export interface RawEntity {
  key: string
  owner: string
  /** Creation block height. */
  createdAt: number
  /** Expiry block height, if selected. */
  expiresAt?: number
  /** Attribute record, already unwrapped from SDK tags (name → value). */
  attributes: Record<string, unknown>
  /** Payload bytes, when selected. */
  payload?: Uint8Array
}

export type TextField = { clear: string } | { sealed: string }

export interface MediaField {
  /** Clear content: Filecoin/UnixFS root CID. Mutually exclusive with `piece`. */
  fcid?: string
  /** Sealed content: CommP piece CID. */
  piece?: string
  /** Shared Haven MIME enum. */
  mime: number
  /** Stored byte size (sealed bytes if sealed). */
  size: number
  name?: string
  /** BlurHash of the plaintext image (image MIME only, optional). */
  hint?: string
  /** sha256 hex (bare) of the stored bytes. */
  sha256?: string
}

export interface BoardPayload {
  v: 1
  /** Haven-AOL gate JSON string (v3 for board posts; v1/v3/v4 on haven records). Present iff anything is sealed. */
  gate?: string
  /** Haven media records have no text; the parser supplies `{ clear: '' }`. */
  text: TextField
  media?: MediaField
}

export interface BoardDefaults {
  sealText: boolean
  sealMedia: boolean
}

export interface BoardTtl {
  thread_s: number
  post_s: number
}

export interface BoardDef {
  kind: 'def'
  key: string
  owner: string
  board: string
  title: string
  about: string
  gate: BoardGate
  bumpLimit: number
  capacity: number
  pageSize: number
  defaults: BoardDefaults
  ttl: BoardTtl
  createdAt: number
  expiresAt?: number
}

export interface ThreadRecord {
  kind: 'thread'
  key: string
  owner: string
  board: string
  /**
   * `board`: written by a Fairhaven client (`haven.board.thread`).
   * `haven`: a Haven media record (`haven.*.full`) published by haven-cli,
   * haven-dapp, or an agent under the same gate; surfaced as a thread root.
   */
  source: 'board' | 'haven'
  /** The entity's `grp`. */
  grp: string
  subject: string
  gate: BoardGate
  /** Gate protocol version of the sealed content (3 for board posts; 1/3/4 for haven records). 0 when nothing is sealed. */
  gateVersion: 0 | 1 | 3 | 4
  mime: number
  sealed: number
  sha256Ct: string
  createdAt: number
  expiresAt?: number
  payload?: BoardPayload
}

export interface PostRecord {
  kind: 'post'
  key: string
  owner: string
  board: string
  rootRef: string
  parentRef?: string
  noBump: boolean
  gate: BoardGate
  sealed: number
  sha256Ct: string
  createdAt: number
  expiresAt?: number
  payload?: BoardPayload
}

export type BoardRecord = BoardDef | ThreadRecord | PostRecord

/** What a writer hands to an Arkiv client. Attribute values are bare (str/i32). */
export interface EntityWrite {
  attributes: Record<string, string | number>
  payload: Uint8Array
  contentType: 'application/json'
  /** Seconds. Multiple of BLOCK_TIME_S. */
  expiresIn: number
}
