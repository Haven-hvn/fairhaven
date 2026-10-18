# Fairhaven Entity Contract — `haven.board.*` (v1)

> Extends Haven `MEDIA_CONTENT_SPEC.md` v2.0.0 with three groups. Container is
> `EntityRegistry.sol` at `0x44…0044` (`Ident32` names, `Attribute[]`, JSON payload,
> BTL). Nothing here changes the chain, the canister, or any SDK. Writers emit exactly
> these keys; readers read exactly these keys; no aliases, no fallbacks.
>
> Writer values are **bare** (string → `str`, integer → `i32`, `gate_threshold` bigint → `u256`), matching haven-dapp and
> haven-cli so equality queries compare type-exact. Entity keys are stored as lowercase
> `0x` hex strings in `str` attributes (the `series_ref` precedent). Addresses are
> lowercase `0x` hex `str`.

## Groups

| `grp` | Producer | Role | Default BTL |
|---|---|---|---|
| `haven.board.def` | board creator | Board definition: gate + ordering constants + defaults. Its BTL is the board's lifetime. | 30 days |
| `haven.board.thread` | any member | Thread root (OP) written by a Fairhaven client. May carry media. | 14 days |
| `haven.board.post` | any member | Reply. Text only. `root_ref` may point at **any** root under the gate, including Haven media records. | 7 days |
| `haven.video.full`, `haven.audio.full`, `haven.image.full`, `haven.text.full`, `haven.file.full` | haven-cli, haven-dapp, dsh agents (unchanged Haven spec) | **Also thread roots.** Any record in these groups whose `gate_token`/`gate_chain`/`gate_threshold` equal the board's gate is surfaced as a thread with `subject = title`, media from `piece`/`fcid`, no text. Fairhaven writes nothing to these groups. | Haven's (4 weeks) |

A board is a gate. Other Haven apps contribute to a board simply by publishing under
its gate; Fairhaven adds the discussion. Readers open v3-sealed Haven media with the
same epoch key they already hold; v1/v4-sealed media is shown frosted with a link to
open it in haven-dapp (v1 per-CID and v4 market-cap unlocks are out of scope for v1).

Board slugs are lowercase dot hierarchies, 2–4 labels, `[a-z0-9-]`, ≤ 64 bytes
(`conference.backchannel`). The slug is the `board` attribute on every Fairhaven-written
record. A gate with no `haven.board.def` is still a board: clients use the implicit slug
`g.<chainId>.<first 12 hex of token>` and default constants.

## `haven.board.def`

| Key | Tag | Required | Notes |
|---|---|---|---|
| `grp` | str | yes | `haven.board.def` |
| `board` | str | yes | slug |
| `title` | str | yes | display title, ≤ 128 B |
| `gate_type` | i32 | yes | always `3` |
| `gate_token` | str | yes | lowercase address |
| `gate_chain` | i32 | yes | EIP-155 id (1, 11155111, 42161, 8453, 10) |
| `gate_threshold` | u256 | yes | raw `balanceOf` units; > 0 (u256, as Haven writes it — real ERC-20 thresholds like 1e18 do not fit i32) |
| `bump_limit` | i32 | yes | replies after which a thread stops bumping |
| `capacity` | i32 | yes | max live threads in the index |
| `page_size` | i32 | yes | threads per page |

Payload:
```json
{ "v": 1, "about": "<text>", "defaults": { "sealText": true, "sealMedia": true },
  "ttl": { "thread_s": 1209600, "post_s": 604800 } }
```

Discovery: `grp = str('haven.board.def')`. If two defs share a slug, clients take the
one with the lowest `createdAt` (first writer wins) and show the owner.

## `haven.board.thread`

| Key | Tag | Required | Query justification |
|---|---|---|---|
| `grp` | str | yes | `= str('haven.board.thread')` |
| `board` | str | yes | board scope |
| `subject` | str | yes | index rendering without payload; ≤ 128 B; **public by design** |
| `gate_type` | i32 | yes | `3` |
| `gate_token` | str | yes | community discovery (same as media records) |
| `gate_chain` | i32 | yes | |
| `gate_threshold` | u256 | yes | |
| `mime` | i32 | yes | shared Haven MIME enum; `0` = no media |
| `sealed` | i32 | yes | bitmask: `1` text sealed, `2` media sealed. Lets a non-holder client frost the right parts from attributes alone |
| `sha256_ct` | str | yes | sha256 hex (bare) of the stored `text` bytes (sealed bytes if sealed, UTF-8 if clear) |

## `haven.board.post`

| Key | Tag | Required | Notes |
|---|---|---|---|
| `grp` | str | yes | `haven.board.post` |
| `board` | str | yes | |
| `root_ref` | str | yes | entity key of the thread root; `= str('0x…')` fans out one thread |
| `parent_ref` | str | no | entity key of the post being answered (for `>>` links); omit for direct replies to the OP |
| `no_bump` | i32 | yes | `0` or `1` |
| `gate_type` / `gate_token` / `gate_chain` / `gate_threshold` | | yes | as above |
| `sealed` | i32 | yes | `0` or `1` (replies have no media) |
| `sha256_ct` | str | yes | as above |

Ten attributes max on either group.

## Payload (thread and post)

```json
{
  "v": 1,
  "gate": "<Haven-AOL v3 gate JSON string>",      // present iff sealed != 0
  "text": { "clear": "…" } | { "sealed": "<base64 framed AES-GCM>" },
  "media": {                                      // thread only, optional
    "fcid": "<clear root CID>" | "piece": "<sealed CommP bafk…>",
    "mime": 8, "size": 123456, "name": "deck.pdf", "hint": "<BlurHash>", "sha256": "<hex of stored bytes>"
  }
}
```

Rules:
- One AES key per post in the web client. `dsh-board` seals through `AolRuntime.seal`, which shares one AES key per `(chain, token, threshold, epoch)` bucket across the agent's posts in that epoch; this is equivalent in strength (anyone holding the epoch VetKey unwraps either) and lets the agent avoid a canister round-trip per post. Both sealed fields of a post unwrap from the same `gate.encryptedAesKey`.
- `gate.cid` is a label, not a locator: `sha256:<hex>` where hex is the sha256 of the text as the sealer had it (the web client hashes the sealed bytes, `dsh-board` hashes the padded plaintext because `AolRuntime.seal` needs the label up front). Readers never interpret it. `gate.version = 3`, `gate.epoch` = epoch at post time, `gate.threshold` is the decimal string of `gate_threshold`.
- Sealed text plaintext is `utf8(JSON {"t": "<text>"})` zero-padded to a bucket (256 B, 1 KiB, 4 KiB, then 4 KiB multiples) before framing, so frosted length reveals only the bucket.
- Framing is Haven's: `[12-byte base IV][u32LE index][u32LE length][ciphertext+16-byte tag]*`, 1 MiB plaintext chunks, chunk IV = base IV with BE64(index) XORed into bytes 4..12. Readers also accept legacy `[12 IV][ct+tag]`.
- Text ≤ 4096 UTF-8 bytes. Payload ≤ 128 KiB (Arkiv chain limit).
- `hint` is optional, image MIME only, BlurHash of the plaintext image; it leaks dominant colours and nothing else.
- Payload mirrors of attributes are forbidden (Haven rule).

### MIME enum extension (Fairhaven, proposed for Haven `MEDIA_CONTENT_SPEC` v2.1)

Appended to the shared table, never renumbered: `15 = application/vnd.comicbook+zip`
(`.cbz`), `16 = application/vnd.comicbook-rar` (`.cbr`). Fairhaven reads CBZ inline
(unzip in the browser, natural page order); CBR is download-only. Other Haven clients
that do not know these values fall back to their generic file handling, per the enum's
"0/unknown" rule. The BlurHash `hint` for a CBZ is computed from its first page.

## Expiry

BTL per board definition `ttl`. Replies may not outlive their root: writers clamp
`post_s` to the root's remaining lifetime. Deletion is Arkiv `DELETE` (op 5) by the
owner; clients also drop a record whose `expiresAt` block has passed even if a node
still returns it.

## Query cookbook (SDK spellings)

- Boards: `grp = str('haven.board.def')`
- Index roots (Fairhaven-written): `AND(grp = str('haven.board.thread'), board = str('<slug>'))`, select `key, owner, createdAt, expiresAt, attributes`
- Index roots (Haven media): for each `g` in the five `haven.*.full` groups, `AND(grp = str(g), gate_token = str('<token>'), gate_chain = i32(<id>))`, then keep rows whose `gate_threshold` equals the board's (same query haven-dapp's community feed runs)
- Index replies: `AND(grp = str('haven.board.post'), board = str('<slug>'))`, same selection
- One thread: `root_ref = str('0x…')` plus `getEntity(root)` with payload
- Never select payload for index rows except the OPs on the current page.

## Cross-surface rule

`packages/board-core` is the implementation of record for attribute building, payload
encode/decode, padding, framing, and the fold. Both the web client and `dsh-board`
import it. `tests/fixtures/board-payload-vectors.json` and
`board-order-vectors.json` pin the wire shapes and ordering so a client in another
language can conform without reading TypeScript.
