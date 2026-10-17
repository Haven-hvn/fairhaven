/**
 * Sealing primitives shared by every Fairhaven writer and reader.
 *
 * - Text plaintext encoding with zero-padding to a size bucket.
 * - Haven framed AES-256-GCM: `[12-byte base IV][u32LE index][u32LE length]
 *   [ciphertext+tag]*` over 1 MiB plaintext chunks, chunk IV = base IV with
 *   BE64(index) XORed into bytes 4..12. Byte-identical to haven-cli
 *   `encrypt_file_streaming`, haven-dapp `havenStreamEncrypt`, and
 *   dsh-haven-aol `encryptFileChunkedAesGcm`.
 * - Legacy `[12 IV][ct+tag]` accepted on open.
 *
 * Key wrapping (IBE under the canister's v3 derived public key) is NOT here:
 * it needs `@icp-sdk/vetkeys` and a canister round-trip, which each client
 * wires itself. This module only needs WebCrypto.
 */

import {
  FRAME_BASE_IV_BYTES,
  FRAME_CHUNK_PLAINTEXT_BYTES,
  FRAME_HEADER_BYTES,
  FRAME_MAX_CHUNK_BYTES,
  GCM_TAG_BYTES,
  PAD_BUCKETS,
  PAD_STEP,
  TEXT_MAX_BYTES,
} from './constants.ts'
import { concat, randomBytes, toArrayBuffer, utf8Bytes, utf8Decode, utf8Encode } from './bytes.ts'

// ── Keys ────────────────────────────────────────────────────────────────

export function freshAesKey(): Uint8Array {
  return randomBytes(32)
}

async function importAesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error(`board-core: AES key must be 32 bytes, got ${raw.length}`)
  return crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, usage)
}

// ── Text plaintext encoding ─────────────────────────────────────────────

/** Bucket size for a plaintext length (bytes). */
export function padBucket(n: number): number {
  for (const b of PAD_BUCKETS) if (n <= b) return b
  return Math.ceil(n / PAD_STEP) * PAD_STEP
}

/**
 * `utf8(JSON {"t": text})` zero-padded to a bucket. JSON never contains a raw
 * NUL byte, so trailing zeros are unambiguous on decode.
 */
export function encodeTextPlain(text: string): Uint8Array {
  if (utf8Bytes(text) > TEXT_MAX_BYTES) {
    throw new Error(`board-core: text is ${utf8Bytes(text)} bytes, over the ${TEXT_MAX_BYTES}-byte limit`)
  }
  const body = utf8Encode(JSON.stringify({ t: text }))
  const out = new Uint8Array(padBucket(body.length))
  out.set(body)
  return out
}

export function decodeTextPlain(bytes: Uint8Array): string {
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  const parsed = JSON.parse(utf8Decode(bytes.subarray(0, end))) as { t?: unknown }
  if (typeof parsed.t !== 'string') throw new Error('board-core: text plaintext missing "t"')
  return parsed.t
}

// ── Framing ─────────────────────────────────────────────────────────────

export function deriveChunkIv(baseIv: Uint8Array, chunkIndex: number): Uint8Array {
  if (baseIv.length !== FRAME_BASE_IV_BYTES) throw new Error('board-core: base IV must be 12 bytes')
  const iv = new Uint8Array(baseIv)
  const idx = BigInt(chunkIndex)
  for (let i = 0; i < 8; i++) {
    const shift = BigInt(8 * (7 - i))
    const byte = Number((idx >> shift) & 0xffn)
    iv[4 + i] = (iv[4 + i] as number) ^ byte
  }
  return iv
}

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, true)
  return out
}

function readU32le(b: Uint8Array, offset: number): number {
  return new DataView(b.buffer, b.byteOffset + offset, 4).getUint32(0, true)
}

/** Seal bytes in the Haven framed layout under a raw 32-byte AES key. */
export async function sealFramed(plaintext: Uint8Array, aesKey: Uint8Array): Promise<Uint8Array> {
  const key = await importAesKey(aesKey, ['encrypt'])
  const baseIv = randomBytes(FRAME_BASE_IV_BYTES)
  const parts: Uint8Array[] = [baseIv]
  const chunks = Math.max(1, Math.ceil(plaintext.length / FRAME_CHUNK_PLAINTEXT_BYTES))
  for (let i = 0; i < chunks; i++) {
    const slice = plaintext.subarray(i * FRAME_CHUNK_PLAINTEXT_BYTES, (i + 1) * FRAME_CHUNK_PLAINTEXT_BYTES)
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(deriveChunkIv(baseIv, i)) }, key, toArrayBuffer(slice)),
    )
    parts.push(u32le(i), u32le(ct.length), ct)
  }
  return concat(parts)
}

/** True when `data` parses as the framed layout (vs legacy single-shot). */
export function isFramed(data: Uint8Array): boolean {
  if (data.length < FRAME_BASE_IV_BYTES + FRAME_HEADER_BYTES + GCM_TAG_BYTES) return false
  let offset = FRAME_BASE_IV_BYTES
  let expected = 0
  while (offset < data.length) {
    if (offset + FRAME_HEADER_BYTES > data.length) return false
    const index = readU32le(data, offset)
    const length = readU32le(data, offset + 4)
    if (index !== expected) return false
    if (length < GCM_TAG_BYTES || length > FRAME_MAX_CHUNK_BYTES) return false
    offset += FRAME_HEADER_BYTES + length
    if (offset > data.length) return false
    expected++
  }
  return expected > 0
}

export interface OpenProgress {
  /** Plaintext chunks opened so far and total (framed layout only). */
  chunk: number
  chunks: number
}

export async function openFramed(sealed: Uint8Array, aesKey: Uint8Array, onProgress?: (p: OpenProgress) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const key = await importAesKey(aesKey, ['decrypt'])
  const baseIv = sealed.subarray(0, FRAME_BASE_IV_BYTES)
  // Count chunks first so progress has a denominator.
  let chunks = 0
  for (let o = FRAME_BASE_IV_BYTES; o < sealed.length; ) {
    const len = readU32le(sealed, o + 4)
    o += FRAME_HEADER_BYTES + len
    chunks++
  }
  const out: Uint8Array[] = []
  let offset = FRAME_BASE_IV_BYTES
  let expected = 0
  while (offset < sealed.length) {
    if (signal?.aborted) throw new DOMException('Open cancelled', 'AbortError')
    const index = readU32le(sealed, offset)
    const length = readU32le(sealed, offset + 4)
    if (index !== expected) throw new Error(`board-core: chunk ${index} out of order (expected ${expected})`)
    const start = offset + FRAME_HEADER_BYTES
    const ct = sealed.subarray(start, start + length)
    if (ct.length !== length) throw new Error('board-core: truncated chunk')
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(deriveChunkIv(baseIv, index)) }, key, toArrayBuffer(ct))
    out.push(new Uint8Array(pt))
    offset = start + length
    expected++
    onProgress?.({ chunk: expected, chunks })
    // Yield between 1 MiB chunks so the UI can paint the progress line.
    if (expected < chunks) await new Promise<void>((r) => setTimeout(r, 0))
  }
  return concat(out)
}

/** Legacy single-shot layout `[12 IV][ct+tag]`. */
export async function openLegacy(sealed: Uint8Array, aesKey: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < FRAME_BASE_IV_BYTES + GCM_TAG_BYTES) throw new Error('board-core: sealed data too short')
  const key = await importAesKey(aesKey, ['decrypt'])
  const iv = sealed.subarray(0, FRAME_BASE_IV_BYTES)
  const ct = sealed.subarray(FRAME_BASE_IV_BYTES)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(ct)))
}

/** Dispatch on framing. */
export async function openAny(sealed: Uint8Array, aesKey: Uint8Array, onProgress?: (p: OpenProgress) => void, signal?: AbortSignal): Promise<Uint8Array> {
  return isFramed(sealed) ? openFramed(sealed, aesKey, onProgress, signal) : openLegacy(sealed, aesKey)
}

// ── Convenience: text round-trip ────────────────────────────────────────

export async function sealText(text: string, aesKey: Uint8Array): Promise<Uint8Array> {
  return sealFramed(encodeTextPlain(text), aesKey)
}

export async function openText(sealed: Uint8Array, aesKey: Uint8Array): Promise<string> {
  return decodeTextPlain(await openAny(sealed, aesKey))
}

/** The `cid` field the v3 gate JSON carries for inline text. */
export function gateCidForText(sha256CtHex: string): string {
  return `sha256:${sha256CtHex.replace(/^0x/i, '').toLowerCase()}`
}

/** Number of frosted lines to draw for a sealed text of `sealedBytes` length. */
export function frostLinesFor(sealedBytes: number): number {
  const plain = Math.max(0, sealedBytes - FRAME_BASE_IV_BYTES - FRAME_HEADER_BYTES - GCM_TAG_BYTES)
  return Math.max(1, Math.min(12, Math.ceil(plain / 160)))
}
