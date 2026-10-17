/**
 * Protocol constants for haven.board.* (see docs/ENTITY_SPEC.md).
 * Values here are wire-visible; changing one is a spec change.
 */

export const GRP_DEF = 'haven.board.def'
export const GRP_THREAD = 'haven.board.thread'
export const GRP_POST = 'haven.board.post'
export const BOARD_GROUPS = [GRP_DEF, GRP_THREAD, GRP_POST] as const

/**
 * Haven media records that other Haven apps publish (haven-cli, haven-dapp,
 * dsh agents). Any record in one of these groups whose gate triple matches a
 * board's gate is a thread root on that board: Fairhaven is a lens over the
 * community, not a silo. Replies attach with `root_ref` = that record's key.
 */
export const HAVEN_FULL_GROUPS = [
  'haven.video.full',
  'haven.audio.full',
  'haven.image.full',
  'haven.text.full',
  'haven.file.full',
] as const
export type HavenFullGroup = (typeof HAVEN_FULL_GROUPS)[number]

/** Payload format version written in every board payload. */
export const PAYLOAD_VERSION = 1

/** Boards always use the Haven-AOL v3 (epoch corpus) gate. */
export const GATE_TYPE_V3 = 3

/** Haven-AOL epoch length, seconds. Mirrors `haven-aol` `EPOCH_LENGTH_SECONDS`. */
export const EPOCH_LENGTH_SECONDS = 2_592_000

/** Arkiv block time used for BTL math (Haven reference value). */
export const BLOCK_TIME_S = 2

/** `sealed` attribute bitmask. */
export const SEALED_TEXT = 1
export const SEALED_MEDIA = 2

/** Limits. */
export const TEXT_MAX_BYTES = 4096
export const SUBJECT_MAX_BYTES = 128
export const TITLE_MAX_BYTES = 128
export const BOARD_SLUG_MAX_BYTES = 64
export const PAYLOAD_MAX_BYTES = 128 * 1024
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024

/** Zero-padding buckets for sealed text plaintext (bytes). */
export const PAD_BUCKETS = [256, 1024, 4096] as const
export const PAD_STEP = 4096

/** Haven framed AES-GCM layout. */
export const FRAME_BASE_IV_BYTES = 12
export const FRAME_HEADER_BYTES = 8
export const FRAME_CHUNK_PLAINTEXT_BYTES = 1024 * 1024
export const FRAME_MAX_CHUNK_BYTES = 64 * 1024 * 1024
export const GCM_TAG_BYTES = 16

/** Board defaults (board definitions may override). */
export const DEFAULT_BUMP_LIMIT = 300
export const DEFAULT_CAPACITY = 150
export const DEFAULT_PAGE_SIZE = 15
export const DEFAULT_DEF_TTL_S = 30 * 24 * 3600
export const DEFAULT_THREAD_TTL_S = 14 * 24 * 3600
export const DEFAULT_POST_TTL_S = 7 * 24 * 3600

/** Replies rendered under an OP on the index (head-and-tail digest). */
export const INDEX_TAIL_REPLIES = 3

/** Short post id length (hex chars after 0x). */
export const SHORT_KEY_HEX = 8

/** Shared Haven MIME enum (`MEDIA_CONTENT_SPEC.md`). Extend by appending only. */
export const MIME_TO_ENUM: Readonly<Record<string, number>> = {
  'video/mp4': 1,
  'video/webm': 2,
  'video/quicktime': 3,
  'audio/mpeg': 4,
  'audio/wav': 5,
  'audio/ogg': 6,
  'image/png': 7,
  'image/jpeg': 8,
  'image/webp': 9,
  'image/gif': 10,
  'image/svg+xml': 11,
  'text/plain': 12,
  'text/markdown': 13,
  'application/pdf': 14,
  // Appended by Fairhaven (proposed for MEDIA_CONTENT_SPEC v2.1): comic archives.
  'application/vnd.comicbook+zip': 15,
  'application/vnd.comicbook-rar': 16,
}

export const MIME_CBZ = 15
export const MIME_CBR = 16

export const ENUM_TO_MIME: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(MIME_TO_ENUM).map(([m, n]) => [n, m]),
) as Record<number, string>

/** Haven-AOL chain variant names and their EIP-155 ids. */
export const CHAIN_VARIANTS = ['EthMainnet', 'EthSepolia', 'ArbitrumOne', 'BaseMainnet', 'OptimismMainnet'] as const
export type ChainVariant = (typeof CHAIN_VARIANTS)[number]

export const VARIANT_TO_EIP155: Readonly<Record<ChainVariant, number>> = {
  EthMainnet: 1,
  EthSepolia: 11155111,
  ArbitrumOne: 42161,
  BaseMainnet: 8453,
  OptimismMainnet: 10,
}

export const EIP155_TO_VARIANT: Readonly<Record<number, ChainVariant>> = Object.fromEntries(
  (Object.entries(VARIANT_TO_EIP155) as Array<[ChainVariant, number]>).map(([v, id]) => [id, v]),
) as Record<number, ChainVariant>

/** Human labels for chains (UI only). */
export const CHAIN_LABEL: Readonly<Record<ChainVariant, string>> = {
  EthMainnet: 'Ethereum',
  EthSepolia: 'Sepolia',
  ArbitrumOne: 'Arbitrum',
  BaseMainnet: 'Base',
  OptimismMainnet: 'Optimism',
}
