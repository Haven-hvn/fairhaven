# Arkiv schema — Fairhaven boards (`haven.board.*`)

Fairhaven is a gated, pseudonymous, ephemeral message board with **no backend, no relayer and no
database**. Every board, thread and reply is an Arkiv entity written by the poster's own wallet.
Readers reconstruct the whole board from Arkiv queries alone.

- **Network:** Arkiv Tiramisu testnet · chain id `7738577`
- **HTTP RPC:** `https://rpc.tiramisu.db-chain.testnet.arkiv.network`
- **WebSocket RPC:** `wss://rpc.tiramisu.db-chain.testnet.arkiv.network`
- **SDK:** `@arkiv-network/sdk` `0.8.1` (`viem` `2.57.0`)
- **Entity contract:** `0x4400000000000000000000000000000000000044`
- **Live deployment:** `https://fairhaven.pinme.dev/`
- **Implementation of record:** [`packages/board-core/src/codec.ts`](../packages/board-core/src/codec.ts)
  and [`docs/ENTITY_SPEC.md`](../docs/ENTITY_SPEC.md)

The same contract is written and read by the browser client
([`apps/web/src/lib/post.ts`](../apps/web/src/lib/post.ts)), the DeepSeek-Harness agent plugin
([`packages/dsh-board`](../packages/dsh-board)), and the redhaven client (a second front end over the
same entities). Fairhaven adds **no new infrastructure** for any of them.

---

## 1. Entity types

| `grp` | What it is | Who writes it | Default BTL |
|---|---|---|---|
| `haven.board.def` | A board definition: gate, title, ordering constants, sealing defaults, TTLs. Its BTL is the board's lifetime. | Board creator | 30 days |
| `haven.board.thread` | A thread (OP). Optional media. `subject` is public by design. | Any member | 14 days |
| `haven.board.post` | A reply. Text only. `root_ref` may point at any root under the gate. | Any member | 7 days |

### Read-only lens over other Haven apps

Any record in `haven.video.full`, `haven.audio.full`, `haven.image.full`, `haven.text.full` or
`haven.file.full` whose gate triple (`gate_token` + `gate_chain` + `gate_threshold`) equals a board's
gate is surfaced as a **thread root** on that board, with `subject = title` and the media locator from
its payload. Fairhaven writes nothing to those groups and requires no change from haven-cli,
haven-dapp or any agent that publishes them. This is what makes Fairhaven a *lens* over a community
rather than a silo ([`codec.ts` `parseHavenFull`](../packages/board-core/src/codec.ts),
[`constants.ts` `HAVEN_FULL_GROUPS`](../packages/board-core/src/constants.ts)).

**Join rule:** Fairhaven records join their board on the `board` string (a slug); Haven media records
carry no `board` attribute and join on the gate triple instead. Both are resolved into one `BoardRef`
by [`resolveBoard`](../packages/board-core/src/service.ts).

---

## 2. Attributes (the queryable surface)

Attribute values are **bare** on the wire: `str`, `i32`, and `u256` for `gate_threshold`. Writers
emit exactly these keys; readers read exactly these keys; no aliases, no fallbacks. Defined once and
shared by every writer in [`codec.ts`](../packages/board-core/src/codec.ts).

### 2.1 Gate triple — on every record

| Attribute | Type | Why this type | Query it enables |
|---|---|---|---|
| `gate_type` | `i32` | Protocol version; always `3` (Haven-AOL v3 epoch key). | Filter to v3 records. |
| `gate_token` | `str` | Lowercase `0x` address; case-normalised at write time so equality is exact. | Community/gate discovery across apps. |
| `gate_chain` | `i32` | EIP-155 id (`1`, `11155111`, `42161`, `8453`, `10`). | Select the chain the token lives on. |
| `gate_threshold` | **`u256`** | Raw `balanceOf` units. Real ERC-20 thresholds (1e18) **do not fit `i32`**, so this is `u256` as Haven writes it. | Rebuild the gate without reading the payload. |

### 2.2 Every record

| Attribute | Type | Notes |
|---|---|---|
| `grp` | `str` | `haven.board.def` / `.thread` / `.post`. |
| `board` | `str` | Lowercase dot hierarchy, 2–4 labels, ≤ 64 bytes (`conference.backchannel`). |
| `sealed` | `i32` | Bitmask: `1` = text sealed, `2` = media sealed. Lets a non-holder client frost the right parts from attributes alone. |
| `sha256_ct` | `str` | sha256 (bare hex) of the stored text bytes — integrity commit, checked after decrypt. |

### 2.3 `haven.board.thread` only

| Attribute | Type | Notes |
|---|---|---|
| `subject` | `str` | ≤ 128 bytes. **Public by design** — it is the teaser a non-holder sees. |
| `mime` | `i32` | Shared Haven MIME enum; `0` = no media. |

### 2.4 `haven.board.post` only

| Attribute | Type | Notes |
|---|---|---|
| `root_ref` | `str` | Entity key of the thread root. `root_ref = str('0x…')` fans out one whole thread. |
| `parent_ref` | `str` | Optional. Entity key of the comment being answered (for `>>` links); absent = direct reply to the OP. |
| `no_bump` | `i32` | `0` or `1`. A `1` reply never moves the thread's bump position. |

### 2.5 `haven.board.def` only

| Attribute | Type | Notes |
|---|---|---|
| `title` | `str` | ≤ 128 bytes. |
| `bump_limit` | `i32` | Replies after which a thread stops bumping. |
| `capacity` | `i32` | Max live threads in the index. |
| `page_size` | `i32` | Threads per page. |

Ten attributes maximum on either thread or post.

---

## 3. What is deliberately *not* an attribute

Nothing inherent to an Arkiv entity is duplicated into a forgeable attribute:

- No `expires_at` — the entity's own `$expiresAt` is the expiry.
- No `owner` / `uploader` / `creator` — that is Arkiv's immutable `$owner` / `$creator`, set at creation.
- No `status: live` — an expired entity is simply not returned; liveness is the absence of a result.
- No `reply_count` — derived deterministically by the fold, never stored.
- No plaintext mirror of the payload — payload mirrors of attributes are forbidden, so there is one
  source of truth for every fact.

---

## 4. Payload (JSON, ≤ 128 KiB, `contentType: application/json`)

Payload version `1`. Full definition in [`types.ts` `BoardPayload`](../packages/board-core/src/types.ts)
and encode/decode in [`codec.ts`](../packages/board-core/src/codec.ts).

```json
{
  "v": 1,
  "gate": "<Haven-AOL v3 gate JSON string>",
  "attn": { "epoch": 679, "at": 1760000000, "bal": "5", "sig": "<128 hex>" },
  "text": { "clear": "…" },
  "media": {
    "fcid": "<clear root CID>",
    "mime": 8,
    "size": 123456,
    "name": "deck.pdf",
    "hint": "<BlurHash>",
    "sha256": "<hex of stored bytes>"
  }
}
```

| Field | Present when | Meaning |
|---|---|---|
| `gate` | anything is sealed | The Haven-AOL v3 gate JSON: version, cid label, chain, token, threshold, epoch, IBE-wrapped AES key. |
| `attn` | author has a membership receipt | The Haven-AOL canister's Ed25519 receipt proving the author held ≥ threshold on this gate in this 30-day epoch. Verified offline by every reader. |
| `text` | always | `{ "clear": "…" }` or `{ "sealed": "<base64 framed AES-GCM>" }`. Sealed plaintext is `{"t":"<text>"}`, zero-padded to a 256 B / 1 KiB / 4 KiB bucket so frosted length leaks only the bucket. |
| `media` | thread with a file | `piece` (sealed CommP CID) **xor** `fcid` (clear UnixFS root CID), plus MIME enum, size, name, optional BlurHash hint for images. Replies carry no media. |

Rules: `gate` is present **iff** something is sealed; one AES key per post, IBE-wrapped for the
`(chain, token, threshold, epoch)` identity; payload ≤ 128 KiB (Arkiv chain limit); text ≤ 4096 UTF-8
bytes.

### Membership receipt preimage

```
HAVEN_ATTEST_V1:{chainVariant}:{gate_token}:{gate_threshold}:{owner}:{cidHash}:{at}:{balance}
cidHash = sha256("HAVEN_MEMBER_V1:gate:{chainId}:{token}:{threshold}:{epoch}")
epoch   = floor(at / 2592000)          # 30-day epochs
```

Readers accept a post iff the Ed25519 signature verifies under the canister's attestation public key,
`balance >= gate_threshold`, `epochOf(at) == epoch`, and the post's block time is within
`[at - 3600, at + 2592000]`. One receipt serves every post a member writes in that epoch on that gate.
Implementation and vectors:
[`attest.ts`](../packages/board-core/src/attest.ts) ·
[`tests/fixtures/receipt-vectors.json`](../packages/board-core/tests/fixtures/receipt-vectors.json).

---

## 5. Lifetime (BTL)

| Entity | Default | Reasoning |
|---|---|---|
| `haven.board.def` | 30 days | The board forgets on a schedule; a def's BTL is the board's lifetime. |
| `haven.board.thread` | 14 days | Long enough for a slow conversation, short enough that the board is ephemeral. |
| `haven.board.post` | 7 days | Replies live shorter than what they reply to. |

- Expiry is Arkiv `ExpirationTime.fromBlocks(blocks)`, and Tiramisu runs at a nominal **2 s/block**
  ([`constants.ts` `BLOCK_TIME_S`](../packages/board-core/src/constants.ts)).
- A reply's TTL is **clamped to the root's remaining life** (`clampPostTtl`), so a reply can never
  outlive its thread.
- Clients also drop a record whose `expiresAt` block has passed even if a node still returns it
  ([`dropExpired`](../packages/board-core/src/service.ts)).
- Old text is deleted from the trie at BTL; a CID cannot deliver that hard expiry, which is why text
  lives inline in the payload instead of on IPFS.

---

## 6. Relationships

```
                 board = "<slug>" (string join on every Fairhaven record)
haven.board.def ─────────────┬─────────────── haven.board.thread
                             │                        │
     gate triple (token/chain/threshold)               │ root_ref = <thread key>
                             │                        ▼
        haven.*.full (haven-cli / haven-dapp) ──> haven.board.post ── parent_ref ──> haven.board.post
```

- **Def → thread / post:** shared `board` slug. First writer of a slug owns it until its BTL ends.
- **Thread → replies:** `post.root_ref = thread.key` (or a `haven.*.full` key).
- **Reply → reply:** `post.parent_ref = post.key` for nesting; absent for a top-level reply.
- **Cross-app:** the gate triple, not `board`, links Fairhaven to records written by other Haven apps.
- **Join key choice:** a `str` slug/entity key, not Arkiv's weak `key` attribute. Nothing can dangle:
  unknown roots are ignored by the fold, and a reply with no live root is simply not rendered.

---

## 7. Query cookbook (SDK spellings)

All queries go through one `EntityStore` built on `@arkiv-network/sdk`:
[`apps/web/src/lib/arkiv.ts`](../apps/web/src/lib/arkiv.ts) (browser) and
[`packages/board-core/src/service.ts`](../packages/board-core/src/service.ts) (shared logic).

| User question | Query | Implementation |
|---|---|---|
| Which boards exist? | `grp = str('haven.board.def')` | `loadBoards` |
| What is on the front page? | one OR-query over `grp ∈ {thread, 5 × haven.*.full}`, plus one replies query | `loadGlobalIndex` |
| What is on board *B*? | `AND(grp = str('haven.board.thread'), board = str('<slug>'))` | `loadIndex` |
| A thread's replies | `AND(grp = str('haven.board.post'), board = str('<slug>'))`, or `root_ref = str('<0x…>')` | `loadIndex` / `loadThread` |
| One thread in **one** charged call | `OR( $key = key('<root>'), AND(grp = str('haven.board.post'), root_ref = str('<root>')) )` | `loadThread` via `queryOr` |
| Payloads for a page of OPs | one batched `$key` OR-query per 50 keys | `hydrateThreads` / `hydratePosts` |
| Has anything changed? | free `arkiv_getEntityCount` probe | `entityCount` |
| Live updates | WebSocket `watchEntityEvents` (free after handshake) | `watchEntities` |

### Read budget

The public Tiramisu RPC bills a flat **100 units per charged `arkiv_query`** at roughly **100 charged
calls/hour/IP**. The read path is built to that budget rather than to data size:

- `retryCount: 0` — fail in ~0.6 s instead of sleeping `Retry-After` (which can be tens of minutes).
- In-flight de-duplication, a concurrency cap of 2, and a cooldown honouring `Retry-After` / quota headers.
- `limit` + `cursor` paging, `SCAN_ROWS = 100` per scan, with `truncated` surfaced so older windows are
  fetched on demand.
- One batched `$key` OR-query per 50 keys — never a `getEntity` loop.
- Free change probe + WebSocket events + a persisted query cache mean an idle tab costs **0 charged calls/min**.
- Membership costs no calls at all: receipts verify offline.

`balanceOf` is queried only for the connected wallet's own balance and for personal mutes — never to
verify someone else's post.

---

## 8. System attributes we rely on

| System attribute | How Fairhaven uses it |
|---|---|
| `$key` | Entity identity: `root_ref`, `parent_ref`, thread routing, batched hydration. Normalised to lowercase hex. |
| `$creator` / `$owner` | The author of a post. Immutable and unforgeable, rendered as the pseudonym. There is no `uploader` attribute because this is it. |
| `$createdAt` | Block height. Drives the deterministic bump-order fold and (through `BlockClock`) wall-time display. |
| `$expiresAt` | The entity's own deadline. Expired records are absent, so liveness is never a filter. |

---

## 9. Write path

1. The poster's wallet switches to Tiramisu (added via `wallet_addEthereumChain` if unknown: chain id
   `7738577`).
2. Attributes are built and typed by `board-core`'s writers (`buildDefWrite`, `buildThreadWrite`,
   `buildPostWrite`), which emit `i32` / `str` / `u256` cells with the SDK's `i32`, `str`, `u256`
   constructors.
3. If anything is sealed, one AES-256 key is generated, each sealed field is framed, and the key is
   IBE-wrapped under the Haven-AOL v3 identity for the epoch. Media (clear or sealed) is pinned to
   Filecoin via Synapse first.
4. One Arkiv `createEntity({ payload, contentType, attributes, expires: ExpirationTime.fromBlocks(...) })`
   is signed and paid by the poster. No server, no relayer.
5. Self-delete is Arkiv's `deleteEntity` by the owner. Posts are immutable: there is no update path,
   only create and delete — so an author cannot silently rewrite history.

The agent plugin writes the same bytes through `dsh-arkiv`'s `ArkivBackend`
([`packages/dsh-board/src/board.ts`](../packages/dsh-board/src/board.ts)), pinned to the same
fixtures so a model and a human can never disagree on the wire shape.

---

## 10. Example entity

```json
{
  "key": "0x…64 hex…",
  "owner": "0x…40 hex…",
  "createdAt": 12345678,
  "expiresAt": 12945678,
  "attributes": {
    "grp": "haven.board.thread",
    "board": "conference.backchannel",
    "subject": "Day one notes",
    "gate_type": 3,
    "gate_token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "gate_chain": 8453,
    "gate_threshold": "1000000",
    "mime": 0,
    "sealed": 1,
    "sha256_ct": "…64 hex…"
  },
  "payload": {
    "v": 1,
    "gate": "{\"version\":3,\"cid\":\"sha256:…\",\"chain\":\"BaseMainnet\",\"tokenAddress\":\"0x8335…2913\",\"threshold\":\"1000000\",\"epoch\":741,\"encryptedAesKey\":\"…\"}",
    "attn": { "epoch": 741, "at": 1760000000, "bal": "5", "sig": "…128 hex…" },
    "text": { "sealed": "…base64 framed AES-GCM…" }
  }
}
```

---

## 11. Fixtures and tests

The wire shapes are pinned so any client, in any language, can conform without reading TypeScript:

- [`tests/fixtures/board-payload-vectors.json`](../packages/board-core/tests/fixtures/board-payload-vectors.json)
  — attributes + payload encode/decode.
- [`tests/fixtures/board-order-vectors.json`](../packages/board-core/tests/fixtures/board-order-vectors.json)
  — the deterministic bump-order fold.
- [`tests/fixtures/receipt-vectors.json`](../packages/board-core/tests/fixtures/receipt-vectors.json)
  — membership receipt preimages/signatures.

Run `pnpm test` (Vitest) from the repo root.

---

## 12. Boundaries — what stays off Arkiv

| Thing | Where it lives instead | Why |
|---|---|---|
| Media bytes | Filecoin (Synapse), as ciphertext when sealed | Arkiv is a database, not a blob store. |
| Decryption keys | Nowhere at rest — derived per request by the Haven-AOL canister (ICP VetKD) | A stored key is a key an operator can leak. |
| Plaintext of sealed fields | The author's machine, then ciphertext only | Every Arkiv entity is publicly readable; we designed for that. |
| Token balances | The gating chain (`balanceOf`) | Mirroring balances would create a second, staler truth. |
| Storage payment | Filecoin rails | Arkiv holds statements, not payments. |
| Votes (redhaven) | Off-chain, peer-to-peer over WebRTC | Low-value ephemeral intents; they need sybil resistance, not permanence. |

Arkiv holds exactly one class of thing: **statements about what exists, who published it, and who may
reach it** — a public index of private things.

---

## 13. Minimal verification script

Anyone can read the entities without cloning either client. Save as `arkiv-verify.mjs`, then:

```sh
pnpm add @arkiv-network/sdk viem
node arkiv-verify.mjs
```

```js
// Prints every Fairhaven thread, reply and board on Tiramisu.
import { createPublicClient, key } from '@arkiv-network/sdk'
import * as chains from '@arkiv-network/sdk/chains'
import { eq, or, and } from '@arkiv-network/sdk/query'
import { str } from '@arkiv-network/sdk/attr'
import { http } from 'viem'

const client = createPublicClient({
  chain: chains.tiramisu,
  transport: http('https://rpc.tiramisu.db-chain.testnet.arkiv.network', { retryCount: 0 }),
})

const selection = { key: true, owner: true, createdAt: true, expiresAt: true, attributes: true, payload: true }

for (const grp of ['haven.board.def', 'haven.board.thread', 'haven.board.post']) {
  const res = await client.select(selection).where(eq('grp', str(grp))).limit(20).fetch()
  for (const e of res.entities) console.log(grp, e.key, e.owner, e.createdAt, e.expiresAt, e.attributes)
}

// One thread and its replies in a single charged query (the loadThread pattern):
// const root = '0x…'
// await client.select(selection).where(or(
//   eq('$key', key(root)),
//   and(eq('grp', str('haven.board.post')), eq('root_ref', str(root))),
// )).limit(100).fetch()
```

- `key / owner / createdAt / expiresAt` are the system attributes (`$key`, `$creator`, `$createdAt`,
  `$expiresAt`).
- `attributes` is the typed map described in §2; `payload` is the JSON in §4.
- To list **who created entities** (the wallets a judge should see), group the `owner` field of the
  rows above — `haven.board.def` rows give the board creators.
