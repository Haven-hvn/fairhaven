/**
 * haven.board.* attribute and payload codec. Implementation of record for
 * docs/ENTITY_SPEC.md. Writers call `build*Write`; readers call `parseEntity`.
 */

import {
  BLOCK_TIME_S,
  BOARD_SLUG_MAX_BYTES,
  DEFAULT_BUMP_LIMIT,
  DEFAULT_CAPACITY,
  DEFAULT_DEF_TTL_S,
  DEFAULT_PAGE_SIZE,
  DEFAULT_POST_TTL_S,
  DEFAULT_THREAD_TTL_S,
  EIP155_TO_VARIANT,
  GATE_TYPE_V3,
  GRP_DEF,
  GRP_POST,
  GRP_THREAD,
  HAVEN_FULL_GROUPS,
  PAYLOAD_MAX_BYTES,
  PAYLOAD_VERSION,
  SEALED_MEDIA,
  SEALED_TEXT,
  SUBJECT_MAX_BYTES,
  TITLE_MAX_BYTES,
  VARIANT_TO_EIP155,
  type ChainVariant,
  CHAIN_VARIANTS,
} from './constants.ts'
import { normalizeAttestation } from './attest.ts'
import { fromBase64, utf8Bytes, utf8Decode, utf8Encode } from './bytes.ts'
import type {
  BoardDef,
  BoardDefaults,
  BoardGate,
  BoardPayload,
  BoardRecord,
  BoardRef,
  BoardTtl,
  EntityWrite,
  MediaField,
  PostRecord,
  RawEntity,
  TextField,
  ThreadRecord,
} from './types.ts'

// ── Validation helpers ──────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9-]+(\.[a-z0-9-]+){1,3}$/
const ADDR_RE = /^0x[0-9a-f]{40}$/
const KEY_RE = /^0x[0-9a-f]{64}$/
const HEX64_RE = /^[0-9a-f]{64}$/

export class BoardCodecError extends Error {
  constructor(message: string) {
    super(`board-core: ${message}`)
    this.name = 'BoardCodecError'
  }
}

export function isBoardSlug(s: unknown): s is string {
  return typeof s === 'string' && SLUG_RE.test(s) && utf8Bytes(s) <= BOARD_SLUG_MAX_BYTES
}

export function normalizeAddress(a: string): string {
  const l = a.toLowerCase()
  if (!ADDR_RE.test(l)) throw new BoardCodecError(`invalid address ${JSON.stringify(a)}`)
  return l
}

export function normalizeKey(k: string): string {
  const l = k.toLowerCase()
  if (!KEY_RE.test(l)) throw new BoardCodecError(`invalid entity key ${JSON.stringify(k)}`)
  return l
}

function requireSlug(s: string): string {
  if (!isBoardSlug(s)) throw new BoardCodecError(`invalid board slug ${JSON.stringify(s)} (lowercase dot hierarchy, 2–4 labels)`)
  return s
}

function requireText(name: string, s: string, maxBytes: number): string {
  if (typeof s !== 'string' || s.length === 0) throw new BoardCodecError(`${name} is required`)
  if (utf8Bytes(s) > maxBytes) throw new BoardCodecError(`${name} is ${utf8Bytes(s)} bytes, over ${maxBytes}`)
  if (s.includes('\u0000')) throw new BoardCodecError(`${name} contains NUL`)
  return s
}

function requireI32(name: string, n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 0x7fffffff) throw new BoardCodecError(`${name} must be a non-negative i32, got ${n}`)
  return n
}

function requireExpires(name: string, s: number): number {
  if (!Number.isInteger(s) || s <= 0) throw new BoardCodecError(`${name} must be a positive integer (seconds)`)
  if (s % BLOCK_TIME_S !== 0) throw new BoardCodecError(`${name} must be a multiple of ${BLOCK_TIME_S}s, got ${s}`)
  return s
}

const U256_MAX = (1n << 256n) - 1n

/** Gate attributes. `gate_threshold` is a u256 cell (as Haven writes it): real ERC-20 thresholds (1e18 and beyond) do not fit i32. */
export function gateAttributes(gate: BoardGate): Record<string, string | number | bigint> {
  if (!CHAIN_VARIANTS.includes(gate.chain)) throw new BoardCodecError(`unknown chain ${String(gate.chain)}`)
  if (gate.threshold <= 0n) throw new BoardCodecError('gate threshold must be > 0')
  if (gate.threshold > U256_MAX) throw new BoardCodecError('gate threshold exceeds u256')
  return {
    gate_type: GATE_TYPE_V3,
    gate_token: normalizeAddress(gate.tokenAddress),
    gate_chain: VARIANT_TO_EIP155[gate.chain],
    gate_threshold: gate.threshold,
  }
}

// ── Payload ─────────────────────────────────────────────────────────────

export function encodePayload(p: BoardPayload): Uint8Array {
  const bytes = utf8Encode(JSON.stringify(p))
  if (bytes.length > PAYLOAD_MAX_BYTES) throw new BoardCodecError(`payload is ${bytes.length} bytes, over ${PAYLOAD_MAX_BYTES}`)
  return bytes
}

export function decodePayload(bytes: Uint8Array | undefined): BoardPayload | undefined {
  if (!bytes || bytes.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(utf8Decode(bytes))
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.v !== PAYLOAD_VERSION) return undefined
  const text = parsed.text
  if (!isRecord(text)) return undefined
  let textField: TextField
  if (typeof text.clear === 'string') textField = { clear: text.clear }
  else if (typeof text.sealed === 'string') textField = { sealed: text.sealed }
  else return undefined
  const out: BoardPayload = { v: 1, text: textField }
  if (typeof parsed.gate === 'string') out.gate = parsed.gate
  if (isRecord(parsed.media)) {
    const m = parsed.media
    if (typeof m.mime !== 'number' || typeof m.size !== 'number') return undefined
    const media: MediaField = { mime: m.mime, size: m.size }
    if (typeof m.fcid === 'string') media.fcid = m.fcid
    if (typeof m.piece === 'string') media.piece = m.piece
    if (typeof m.name === 'string') media.name = m.name
    if (typeof m.hint === 'string') media.hint = m.hint
    if (typeof m.sha256 === 'string') media.sha256 = m.sha256
    if (media.fcid === undefined && media.piece === undefined) return undefined
    if (media.fcid !== undefined && media.piece !== undefined) return undefined
    out.media = media
  }
  if (parsed.attn !== undefined) {
    const attn = normalizeAttestation(parsed.attn)
    if (attn) out.attn = attn
  }
  return out
}

export function sealedMaskOf(p: BoardPayload): number {
  let m = 0
  if ('sealed' in p.text) m |= SEALED_TEXT
  if (p.media?.piece !== undefined) m |= SEALED_MEDIA
  return m
}

// ── Writers ─────────────────────────────────────────────────────────────

export interface ThreadWriteArgs {
  board: string
  subject: string
  gate: BoardGate
  payload: BoardPayload
  /** sha256 hex (bare) of the stored text bytes. */
  sha256Ct: string
  expiresIn?: number
}

export function buildThreadWrite(a: ThreadWriteArgs): EntityWrite {
  const sealed = sealedMaskOf(a.payload)
  if ((sealed !== 0) !== (a.payload.gate !== undefined)) throw new BoardCodecError('gate must be present iff something is sealed')
  const sha = a.sha256Ct.replace(/^0x/i, '').toLowerCase()
  if (!HEX64_RE.test(sha)) throw new BoardCodecError('sha256Ct must be 64 hex chars')
  return {
    attributes: {
      grp: GRP_THREAD,
      board: requireSlug(a.board),
      subject: requireText('subject', a.subject, SUBJECT_MAX_BYTES),
      ...gateAttributes(a.gate),
      mime: requireI32('mime', a.payload.media?.mime ?? 0),
      sealed,
      sha256_ct: sha,
    },
    payload: encodePayload(a.payload),
    contentType: 'application/json',
    expiresIn: requireExpires('expiresIn', a.expiresIn ?? DEFAULT_THREAD_TTL_S),
  }
}

export interface PostWriteArgs {
  board: string
  rootRef: string
  parentRef?: string
  noBump: boolean
  gate: BoardGate
  payload: BoardPayload
  sha256Ct: string
  expiresIn?: number
}

export function buildPostWrite(a: PostWriteArgs): EntityWrite {
  if (a.payload.media !== undefined) throw new BoardCodecError('replies carry no media')
  const sealed = sealedMaskOf(a.payload)
  if ((sealed !== 0) !== (a.payload.gate !== undefined)) throw new BoardCodecError('gate must be present iff something is sealed')
  const sha = a.sha256Ct.replace(/^0x/i, '').toLowerCase()
  if (!HEX64_RE.test(sha)) throw new BoardCodecError('sha256Ct must be 64 hex chars')
  const attributes: Record<string, string | number> = {
    grp: GRP_POST,
    board: requireSlug(a.board),
    root_ref: normalizeKey(a.rootRef),
    ...(a.parentRef !== undefined ? { parent_ref: normalizeKey(a.parentRef) } : {}),
    no_bump: a.noBump ? 1 : 0,
    ...gateAttributes(a.gate),
    sealed,
    sha256_ct: sha,
  }
  return {
    attributes,
    payload: encodePayload(a.payload),
    contentType: 'application/json',
    expiresIn: requireExpires('expiresIn', a.expiresIn ?? DEFAULT_POST_TTL_S),
  }
}

export interface DefWriteArgs {
  board: string
  title: string
  about: string
  gate: BoardGate
  bumpLimit?: number
  capacity?: number
  pageSize?: number
  defaults?: Partial<BoardDefaults>
  ttl?: Partial<BoardTtl>
  expiresIn?: number
}

export function buildDefWrite(a: DefWriteArgs): EntityWrite {
  const ttl: BoardTtl = {
    thread_s: requireExpires('ttl.thread_s', a.ttl?.thread_s ?? DEFAULT_THREAD_TTL_S),
    post_s: requireExpires('ttl.post_s', a.ttl?.post_s ?? DEFAULT_POST_TTL_S),
  }
  const defaults: BoardDefaults = { sealText: a.defaults?.sealText ?? true, sealMedia: a.defaults?.sealMedia ?? true }
  const payload = { v: PAYLOAD_VERSION, about: a.about ?? '', defaults, ttl }
  return {
    attributes: {
      grp: GRP_DEF,
      board: requireSlug(a.board),
      title: requireText('title', a.title, TITLE_MAX_BYTES),
      ...gateAttributes(a.gate),
      bump_limit: requireI32('bump_limit', a.bumpLimit ?? DEFAULT_BUMP_LIMIT),
      capacity: requireI32('capacity', a.capacity ?? DEFAULT_CAPACITY),
      page_size: requireI32('page_size', a.pageSize ?? DEFAULT_PAGE_SIZE),
    },
    payload: utf8Encode(JSON.stringify(payload)),
    contentType: 'application/json',
    expiresIn: requireExpires('expiresIn', a.expiresIn ?? DEFAULT_DEF_TTL_S),
  }
}

// ── Readers ─────────────────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function int(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v)
  return undefined
}

function bigInt(v: unknown): bigint | undefined {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v)
  return undefined
}

export function gateFromAttributes(attrs: Record<string, unknown>): BoardGate | undefined {
  const token = str(attrs.gate_token)
  const chainId = int(attrs.gate_chain)
  const threshold = bigInt(attrs.gate_threshold)
  if (!token || chainId === undefined || threshold === undefined) return undefined
  const chain: ChainVariant | undefined = EIP155_TO_VARIANT[chainId]
  if (!chain || !ADDR_RE.test(token.toLowerCase()) || threshold <= 0n) return undefined
  return { chain, tokenAddress: token.toLowerCase(), threshold }
}

/** Gate protocol version inside a gate JSON string; undefined when unparsable. */
export function gateVersionOf(gateJson: string | undefined): 1 | 3 | 4 | undefined {
  if (!gateJson) return undefined
  try {
    const g = JSON.parse(gateJson) as { version?: unknown }
    return g.version === 1 || g.version === 3 || g.version === 4 ? g.version : undefined
  } catch {
    return undefined
  }
}

/** Implicit slug for a board that has no `haven.board.def`: `g.<chainId>.<12 hex of token>`. */
export function implicitSlug(gate: BoardGate): string {
  return `g.${VARIANT_TO_EIP155[gate.chain]}.${gate.tokenAddress.slice(2, 14)}`
}

/**
 * Normalize a Haven media record (`haven.*.full`, written by haven-cli,
 * haven-dapp, or an agent) into a ThreadRecord on `boardSlug`. Haven records
 * carry no text; `title` becomes the subject and the locator becomes media.
 * Returns undefined if the record's gate does not match `gate`.
 */
function parseHavenFull(e: RawEntity, grp: string, boardSlug: string, gate: BoardGate): ThreadRecord | undefined {
  const a = e.attributes
  const recGate = gateFromAttributes(a)
  // Ungated Haven records (threshold 0 / no gate attrs) are not members of any gate.
  if (!recGate || !sameGate(recGate, gate)) return undefined
  const subject = str(a.title) ?? '(untitled)'
  let payload: BoardPayload | undefined
  let gateVersion: 0 | 1 | 3 | 4 = 0
  let sealed = 0
  if (e.payload) {
    let raw: Record<string, unknown> | undefined
    try {
      const p = JSON.parse(utf8Decode(e.payload)) as unknown
      raw = isRecord(p) ? p : undefined
    } catch {
      raw = undefined
    }
    if (raw) {
      const piece = str(raw.piece)
      const fcid = str(raw.fcid)
      const gateJson = str(raw.gate)
      const media: MediaField = {
        mime: int(a.mime) ?? 0,
        size: int(raw.size) ?? 0,
      }
      if (piece) media.piece = piece
      else if (fcid) media.fcid = fcid
      const name = str(raw.name)
      if (name) media.name = name
      payload = { v: 1, text: { clear: '' } }
      if (piece || fcid) payload.media = media
      if (piece && gateJson) {
        payload.gate = gateJson
        sealed = SEALED_MEDIA
        gateVersion = gateVersionOf(gateJson) ?? 0
      }
      const attn = raw.attn !== undefined ? normalizeAttestation(raw.attn) : undefined
      if (attn) payload.attn = attn
    }
  } else {
    // Attributes only (index rows): infer sealing from the presence of a gate type.
    sealed = int(a.gate_type) ? SEALED_MEDIA : 0
    const gt = int(a.gate_type)
    gateVersion = gt === 1 || gt === 3 || gt === 4 ? gt : 0
  }
  const sha = str(a.sha256_ct)?.toLowerCase()
  const rec: ThreadRecord = {
    kind: 'thread',
    key: e.key.toLowerCase(),
    owner: e.owner.toLowerCase(),
    board: boardSlug,
    source: 'haven',
    grp,
    subject,
    gate,
    gateVersion,
    mime: int(a.mime) ?? 0,
    sealed,
    sha256Ct: sha && HEX64_RE.test(sha) ? sha : '0'.repeat(64),
    createdAt: e.createdAt,
    ...(e.expiresAt !== undefined ? { expiresAt: e.expiresAt } : {}),
    ...(payload ? { payload } : {}),
  }
  return rec
}

export interface ParseContext {
  /** The board being viewed. Required to surface `haven.*.full` records, which carry no `board` attribute. */
  board?: BoardRef
}

/**
 * Dispatch an entity on `grp`. Returns undefined for anything malformed or
 * foreign. With `ctx.board`, Haven media records under the same gate are
 * returned as thread roots (`source: 'haven'`).
 */
export function parseEntity(e: RawEntity, ctx: ParseContext = {}): BoardRecord | undefined {
  const a = e.attributes
  const grp = str(a.grp)
  if (!grp) return undefined

  if ((HAVEN_FULL_GROUPS as readonly string[]).includes(grp)) {
    if (!ctx.board) return undefined
    return parseHavenFull(e, grp, ctx.board.slug, ctx.board.gate)
  }

  const board = str(a.board)
  if (!board || !isBoardSlug(board)) return undefined
  const key = e.key.toLowerCase()
  const owner = e.owner.toLowerCase()
  const base = { key, owner, board, createdAt: e.createdAt, ...(e.expiresAt !== undefined ? { expiresAt: e.expiresAt } : {}) }

  if (grp === GRP_DEF) {
    const gate = gateFromAttributes(a)
    const title = str(a.title)
    if (!gate || !title) return undefined
    let about = ''
    let defaults: BoardDefaults = { sealText: true, sealMedia: true }
    let ttl: BoardTtl = { thread_s: DEFAULT_THREAD_TTL_S, post_s: DEFAULT_POST_TTL_S }
    if (e.payload) {
      try {
        const p = JSON.parse(utf8Decode(e.payload)) as Record<string, unknown>
        if (isRecord(p)) {
          about = str(p.about) ?? ''
          if (isRecord(p.defaults)) {
            defaults = { sealText: p.defaults.sealText !== false, sealMedia: p.defaults.sealMedia !== false }
          }
          if (isRecord(p.ttl)) {
            ttl = { thread_s: int(p.ttl.thread_s) ?? ttl.thread_s, post_s: int(p.ttl.post_s) ?? ttl.post_s }
          }
        }
      } catch {
        /* keep defaults */
      }
    }
    const def: BoardDef = {
      kind: 'def',
      ...base,
      title,
      about,
      gate,
      bumpLimit: int(a.bump_limit) ?? DEFAULT_BUMP_LIMIT,
      capacity: int(a.capacity) ?? DEFAULT_CAPACITY,
      pageSize: int(a.page_size) ?? DEFAULT_PAGE_SIZE,
      defaults,
      ttl,
    }
    return def
  }

  const gate = gateFromAttributes(a)
  const sha = str(a.sha256_ct)?.toLowerCase()
  const sealed = int(a.sealed)
  if (!gate || !sha || !HEX64_RE.test(sha) || sealed === undefined) return undefined
  const payload = decodePayload(e.payload)
  if (e.payload && !payload) return undefined

  if (grp === GRP_THREAD) {
    const subject = str(a.subject)
    if (!subject) return undefined
    const rec: ThreadRecord = {
      kind: 'thread',
      ...base,
      source: 'board',
      grp,
      subject,
      gate,
      gateVersion: sealed !== 0 ? 3 : 0,
      mime: int(a.mime) ?? 0,
      sealed,
      sha256Ct: sha,
      ...(payload ? { payload } : {}),
    }
    return rec
  }

  if (grp === GRP_POST) {
    const rootRef = str(a.root_ref)?.toLowerCase()
    if (!rootRef || !KEY_RE.test(rootRef)) return undefined
    const parentRef = str(a.parent_ref)?.toLowerCase()
    const rec: PostRecord = {
      kind: 'post',
      ...base,
      rootRef,
      ...(parentRef && KEY_RE.test(parentRef) ? { parentRef } : {}),
      noBump: (int(a.no_bump) ?? 0) === 1,
      gate,
      sealed,
      sha256Ct: sha,
      ...(payload ? { payload } : {}),
    }
    return rec
  }

  return undefined
}

/** Payload text bytes as stored (what `sha256_ct` commits to). */
export function storedTextBytes(p: BoardPayload): Uint8Array {
  return 'clear' in p.text ? utf8Encode(p.text.clear) : fromBase64(p.text.sealed)
}

/** Same gate? (boards are one gate; a record with a different gate is foreign) */
export function sameGate(a: BoardGate, b: BoardGate): boolean {
  return a.chain === b.chain && a.tokenAddress === b.tokenAddress && a.threshold === b.threshold
}
