/**
 * Membership receipts: a fake canister (random Ed25519 key) signs exactly the
 * bytes the real one signs, so every rule in attest.ts is exercised offline.
 */

import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import {
  ATTEST_REQUEST_TYPE,
  AOL_DOMAIN_TYPE,
  RECEIPT_TTL_SECONDS,
  attestHoldingRequest,
  attestPreimage,
  attestRequestDigest,
  attestRequestTypedData,
  describeReceiptReason,
  isMemberReceiptShape,
  memberCidHash,
  normalizeAttestation,
  receiptFromAttestation,
  receiptRemaining,
  verifyHavenAttestation,
  verifyMemberReceipt,
  verifyRecordAuthor,
  type HavenMerkleAttestation,
  type HavenSingleAttestation,
  type MemberReceipt,
} from '../src/attest.ts'
import { fromHex, toHex, utf8Decode, utf8Encode, concat } from '../src/bytes.ts'
import { epochOf } from '../src/time.ts'
import type { BoardGate } from '../src/types.ts'
import vectors from './fixtures/receipt-vectors.json'
import { sha256 } from '@noble/hashes/sha2.js'

const GATE: BoardGate = { chain: 'BaseMainnet', tokenAddress: vectors.gate.tokenAddress, threshold: 1n }
const NOW = vectors.now
const EPOCH = vectors.epochOfNow
const HOLDER = '0x1111111111111111111111111111111111111111'

/** A stand-in canister: same preimage, same signature algorithm, its own key. */
function canister() {
  const priv = ed25519.utils.randomSecretKey()
  const pub = ed25519.getPublicKey(priv)
  const mint = (gate: BoardGate, holder: string, epoch: number, at: number, bal: string): MemberReceipt => {
    const msg = attestPreimage(gate.chain, gate.tokenAddress, gate.threshold, holder, memberCidHash(gate, epoch), at, bal)
    return { epoch, at, bal, sig: toHex(ed25519.sign(msg, priv)) }
  }
  const signSingle = (a: Omit<HavenSingleAttestation, 'signature'>): HavenSingleAttestation => {
    const msg = utf8Encode(`HAVEN_ATTEST_V1:${a.chain}:${a.tokenAddress}:${a.threshold}:${a.evmAddress}:${a.cidHash}:${a.timestamp}:${a.balanceAtCheck}`)
    return { ...a, signature: toHex(ed25519.sign(msg, priv)) }
  }
  return { pub, priv, mint, signSingle }
}

describe('member receipt binding (fixture-pinned)', () => {
  it('cidHash is sha256 of the HAVEN_MEMBER_V1 binding string', () => {
    for (const [epoch, v] of Object.entries(vectors.cidHash)) {
      expect(memberCidHash(GATE, Number(epoch))).toBe(v.sha256)
      expect(toHex(sha256(utf8Encode(v.binding)))).toBe(v.sha256)
    }
  })

  it('preimage matches the canister encoding byte for byte', () => {
    const p = vectors.preimage
    expect(utf8Decode(attestPreimage(GATE.chain, GATE.tokenAddress, GATE.threshold, p.holder, memberCidHash(GATE, p.epoch), p.at, p.bal))).toBe(p.expected)
  })

  it('EIP-712 type strings hash to the canister constants', () => {
    expect(ATTEST_REQUEST_TYPE).toBe(vectors.eip712.attestRequestType)
    expect(AOL_DOMAIN_TYPE).toBe(vectors.eip712.domainType)
    expect(toHex(keccak_256(utf8Encode(ATTEST_REQUEST_TYPE)))).toBe(vectors.eip712.attestRequestTypehash)
    expect(toHex(keccak_256(utf8Encode(AOL_DOMAIN_TYPE)))).toBe(vectors.eip712.domainTypehash)
  })

  it('typed data and raw digest describe the same request', () => {
    const f = { holder: HOLDER, gate: GATE, epoch: EPOCH, nonce: '12345', eip712ChainId: 1n, verifyingContract: `0x${'00'.repeat(20)}` }
    const td = attestRequestTypedData(f)
    expect(td.domain).toEqual({ name: 'HavenAOL', chainId: 1n, verifyingContract: `0x${'00'.repeat(20)}` })
    expect(td.message.cidHash).toBe(`0x${memberCidHash(GATE, EPOCH)}`)
    expect(td.message.nonce).toBe(12345n)
    expect(attestRequestDigest(f)).toHaveLength(32)
    expect(attestRequestDigest(f)).not.toEqual(attestRequestDigest({ ...f, nonce: '12346' }))
    const req = attestHoldingRequest(f, new Uint8Array(65))
    expect(req).toMatchObject({ chain: 'BaseMainnet', tokenAddress: GATE.tokenAddress, threshold: 1n, cidHash: memberCidHash(GATE, EPOCH), evmAddress: HOLDER, nonce: 12345n, eip712ChainId: 1n })
  })
})

describe('verifyMemberReceipt', () => {
  const c = canister()

  it('accepts a receipt the canister minted for this holder, gate and epoch', () => {
    const r = c.mint(GATE, HOLDER, EPOCH, NOW - 100, '5')
    expect(verifyMemberReceipt(r, GATE, HOLDER, c.pub, NOW)).toEqual({ ok: true })
    expect(isMemberReceiptShape(r)).toBe(true)
  })

  it('is case-insensitive on the holder address but binds to it', () => {
    const r = c.mint(GATE, HOLDER, EPOCH, NOW - 100, '5')
    expect(verifyMemberReceipt(r, GATE, HOLDER.toUpperCase().replace('0X', '0x'), c.pub, NOW)).toEqual({ ok: true })
    expect(verifyMemberReceipt(r, GATE, `0x${'22'.repeat(20)}`, c.pub, NOW)).toEqual({ ok: false, reason: 'signature' })
  })

  it('rejects another gate, another epoch, and another canister key', () => {
    const r = c.mint(GATE, HOLDER, EPOCH, NOW - 100, '5')
    expect(verifyMemberReceipt(r, { ...GATE, threshold: 2n }, HOLDER, c.pub, NOW)).toEqual({ ok: false, reason: 'balance' })
    expect(verifyMemberReceipt(r, { ...GATE, tokenAddress: `0x${'33'.repeat(20)}` }, HOLDER, c.pub, NOW)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyMemberReceipt({ ...r, epoch: EPOCH + 1 }, GATE, HOLDER, c.pub, NOW)).toEqual({ ok: false, reason: 'epoch' })
    expect(verifyMemberReceipt(r, GATE, HOLDER, canister().pub, NOW)).toEqual({ ok: false, reason: 'signature' })
  })

  it('a receipt covers one epoch of posting and not more', () => {
    const r = c.mint(GATE, HOLDER, EPOCH, NOW, '5')
    expect(verifyMemberReceipt(r, GATE, HOLDER, c.pub, NOW + RECEIPT_TTL_SECONDS)).toEqual({ ok: true })
    expect(verifyMemberReceipt(r, GATE, HOLDER, c.pub, NOW + RECEIPT_TTL_SECONDS + 1)).toEqual({ ok: false, reason: 'expired' })
    expect(receiptRemaining(r, NOW + 100)).toBe(RECEIPT_TTL_SECONDS - 100)
  })

  it('a receipt dated after the post (beyond slack) is rejected', () => {
    const r = c.mint(GATE, HOLDER, EPOCH, NOW + 7200, '5')
    expect(verifyMemberReceipt(r, GATE, HOLDER, c.pub, NOW)).toEqual({ ok: false, reason: 'future' })
    expect(verifyMemberReceipt(c.mint(GATE, HOLDER, EPOCH, NOW + 1800, '5'), GATE, HOLDER, c.pub, NOW)).toEqual({ ok: true })
  })

  it('balance is checked against the gate, so a 1-token receipt cannot serve a 1M-token gate', () => {
    const big: BoardGate = { ...GATE, threshold: 1_000_000n }
    const r = c.mint(big, HOLDER, EPOCH, NOW, '1')
    expect(verifyMemberReceipt(r, big, HOLDER, c.pub, NOW)).toEqual({ ok: false, reason: 'balance' })
    const ok = c.mint(big, HOLDER, EPOCH, NOW, '1000000000000000000')
    expect(verifyMemberReceipt(ok, big, HOLDER, c.pub, NOW)).toEqual({ ok: true })
  })

  it('tampered fields fail the signature; garbage fails the shape', () => {
    const r = c.mint(GATE, HOLDER, EPOCH, NOW, '5')
    expect(verifyMemberReceipt({ ...r, bal: '6' }, GATE, HOLDER, c.pub, NOW)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyMemberReceipt({ ...r, at: r.at + 1 }, GATE, HOLDER, c.pub, NOW)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyMemberReceipt(undefined, GATE, HOLDER, c.pub, NOW)).toEqual({ ok: false, reason: 'missing' })
    expect(verifyMemberReceipt({ epoch: 1 }, GATE, HOLDER, c.pub, NOW)).toEqual({ ok: false, reason: 'shape' })
    expect(verifyMemberReceipt({ ...r, sig: 'zz' }, GATE, HOLDER, c.pub, NOW)).toEqual({ ok: false, reason: 'shape' })
    expect(describeReceiptReason('signature')).toMatch(/canister/)
  })

  it('normalizeAttestation strips unknown fields and lowercases the signature', () => {
    const r = c.mint(GATE, HOLDER, EPOCH, NOW, '5')
    const n = normalizeAttestation({ ...r, sig: `0x${r.sig.toUpperCase()}`, extra: 1 })
    expect(n).toEqual(r)
  })

  it('receiptFromAttestation checks the canister echoed what was asked', () => {
    const f = { holder: HOLDER, gate: GATE, epoch: EPOCH, nonce: '1', eip712ChainId: 1n, verifyingContract: `0x${'00'.repeat(20)}` }
    const sig = new Uint8Array(64)
    const good = { attestation: { evmAddress: HOLDER, tokenAddress: GATE.tokenAddress, threshold: 1n, balanceAtCheck: 5n, cidHash: memberCidHash(GATE, EPOCH), timestamp: BigInt(NOW) }, signature: sig }
    expect(receiptFromAttestation(f, good)).toEqual({ epoch: EPOCH, at: NOW, bal: '5', sig: toHex(sig) })
    expect(() => receiptFromAttestation(f, { ...good, attestation: { ...good.attestation, cidHash: memberCidHash(GATE, EPOCH + 1) } })).toThrow(/cidHash/)
    expect(() => receiptFromAttestation(f, { ...good, attestation: { ...good.attestation, timestamp: BigInt(NOW + RECEIPT_TTL_SECONDS) } })).toThrow(/epoch/)
  })
})

describe('haven media attestations (dapp / cli shapes)', () => {
  const c = canister()
  const SHA = 'ab'.repeat(32)
  const base = { evmAddress: HOLDER, chain: 'BaseMainnet', tokenAddress: GATE.tokenAddress, threshold: 1, balanceAtCheck: 3, cidHash: SHA, timestamp: NOW - 10 }

  it('verifies a single-CID attestation bound to sha256_ct', () => {
    const a = c.signSingle(base)
    expect(verifyHavenAttestation(a, GATE, HOLDER, SHA, c.pub, NOW)).toEqual({ ok: true })
    expect(verifyHavenAttestation(a, GATE, HOLDER, 'cd'.repeat(32), c.pub, NOW)).toEqual({ ok: false, reason: 'binding' })
    expect(verifyHavenAttestation(a, GATE, `0x${'22'.repeat(20)}`, SHA, c.pub, NOW)).toEqual({ ok: false, reason: 'binding' })
    expect(verifyHavenAttestation(a, { ...GATE, threshold: 2n }, HOLDER, SHA, c.pub, NOW)).toEqual({ ok: false, reason: 'binding' })
    expect(verifyHavenAttestation({ ...a, balanceAtCheck: 9 }, GATE, HOLDER, SHA, c.pub, NOW)).toEqual({ ok: false, reason: 'signature' })
  })

  it('verifies a Merkle batch attestation (RFC 6962 prefixes) and rejects a bad proof step', () => {
    // Two-leaf batch: ours (left) and a sibling (right).
    const leafOf = (cid: string) => sha256(concat([new Uint8Array([0]), utf8Encode(`HAVEN_ATTEST_V1:${base.chain}:${base.tokenAddress}:${base.threshold}:${base.evmAddress}:${cid}:${base.timestamp}:${base.balanceAtCheck}`)]))
    const mine = leafOf(SHA)
    const sibling = leafOf('cd'.repeat(32))
    const root = sha256(concat([new Uint8Array([1]), mine, sibling]))
    const batch = utf8Encode(`HAVEN_BATCH_ATTEST_V1:${base.chain}:${base.tokenAddress}:${base.threshold}:${base.evmAddress}:${toHex(root)}:2:${base.timestamp}:${base.balanceAtCheck}`)
    const a: HavenMerkleAttestation = { ...base, cidCount: 2, merkleProof: [{ side: 'right', hash: toHex(sibling) }], merkleRoot: toHex(root), rootSignature: toHex(ed25519.sign(batch, c.priv)) }
    expect(verifyHavenAttestation(a, GATE, HOLDER, SHA, c.pub, NOW)).toEqual({ ok: true })
    expect(verifyHavenAttestation({ ...a, merkleProof: [{ side: 'left', hash: toHex(sibling) }] }, GATE, HOLDER, SHA, c.pub, NOW)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyHavenAttestation({ ...a, merkleProof: [{ side: 'up' as 'left', hash: 'x' }] }, GATE, HOLDER, SHA, c.pub, NOW)).toEqual({ ok: false, reason: 'shape' })
  })

  it('verifyRecordAuthor dispatches on source', () => {
    const receipt = c.mint(GATE, HOLDER, EPOCH, NOW, '5')
    const boardRec = { owner: HOLDER, gate: GATE, sha256Ct: SHA, source: 'board' as const, payload: { attn: receipt } }
    const havenRec = { owner: HOLDER, gate: GATE, sha256Ct: SHA, source: 'haven' as const, payload: { attn: c.signSingle(base) } }
    expect(verifyRecordAuthor(boardRec, c.pub, NOW)).toEqual({ ok: true })
    expect(verifyRecordAuthor(havenRec, c.pub, NOW)).toEqual({ ok: true })
    expect(verifyRecordAuthor({ ...boardRec, payload: {} }, c.pub, NOW)).toEqual({ ok: false, reason: 'missing' })
    expect(verifyRecordAuthor({ ...havenRec, payload: { attn: receipt } }, c.pub, NOW)).toEqual({ ok: false, reason: 'shape' })
  })

  it('epochOf agrees with the fixture', () => {
    expect(epochOf(NOW)).toBe(EPOCH)
    expect(fromHex(vectors.cidHash['679'].sha256)).toHaveLength(32)
  })
})
