# Friction log — building Fairhaven on Arkiv Tiramisu

Real friction hit while building, expected-vs-actual where we had an expectation, and what we did
about it. Written from the build, not after it. Some items we fixed in this repo; the ones we lived
with are marked as such.

## Environment

- `@arkiv-network/sdk` **0.8.1** · `viem` **2.57.0** · `wagmi` **3.7.7** · `@reown/appkit` **1.8.24**
- `next` **16.3.6** · `react` **19.3.0** · TypeScript **7.0.2** · Vitest **5.0.2** · pnpm **11.0.0**
- Arkiv **Tiramisu** testnet, chain id **`7738577`**
  - HTTP `https://rpc.tiramisu.db-chain.testnet.arkiv.network`
  - WS `wss://rpc.tiramisu.db-chain.testnet.arkiv.network`
- Entity contract `0x4400000000000000000000000000000000000044`
- Built **9–18 October 2026** for Arkiv: Global Tour Stop

---

## 1. A plain viem wallet client has no `createEntity` — and the app said nothing

**Expected.** Build the write client with viem's `createWalletClient` (the obvious choice for a
wagmi/Reown app) and call the Arkiv write method on it.

**Actual.** viem's wallet client has no `createEntity` / `deleteEntity`. The call was undefined, so
**no Arkiv transaction and no signing prompt ever happened**, while the UI sat on "Sealing…" — a step
a public reply never even performs. Nothing threw at the type level because the client was cast
through `as never` to satisfy the transport generics.

**Fix.** Use the Arkiv-extended factory, `createWalletClient` from `@arkiv-network/sdk`, and assert the
method exists before showing a write as in-flight:

```ts
const { createWalletClient, ExpirationTime } = await import('@arkiv-network/sdk')
const client = createWalletClient({ account: address, chain, transport: custom(provider) } as never)
if (typeof (client as any).createEntity !== 'function') {
  throw new Error('Arkiv wallet client unavailable (createEntity missing)')
}
```

Code: [`apps/web/src/lib/post.ts`](../apps/web/src/lib/post.ts) (`arkivWallet`). Regression test:
[`apps/web/tests/post.spec.ts`](../apps/web/tests/post.spec.ts) (the test both asserts the Arkiv
address receives the tx **and** that the UI never claims "Sealing…" for a public reply).

**Ask.** An SDK client factory that cannot be confused with viem's — or have `createEntity` throw a
named error on a plain client, so the failure is loud instead of a silent no-op. This is the single
bug that cost us the most time, because it looked like a UI bug.

---

## 2. Braga was sunset; the live network is Tiramisu, and the docs we had still pointed at Braga

**Expected.** Follow the network details we had (Braga testnet, faucet, explorer, RPC).

**Actual.** Braga was retired **12 August 2026**; the faucet, explorer and RPC went with it. By
October the live testnet was **Tiramisu** (chain id `7738577`), discoverable through the SDK's exported
`chains.tiramisu` rather than from the material we started with. Our own env file carries the note
["Braga was sunset"](../apps/web/.env.local.example).

**Fix.** Default every read and write to Tiramisu, and keep `localhost` as an override for a local
node: [`apps/web/src/lib/env.ts`](../apps/web/src/lib/env.ts),
[`apps/web/src/lib/wallet.ts`](../apps/web/src/lib/wallet.ts).

**Repro.** Point `NEXT_PUBLIC_ARKIV_RPC_URL` at the old Braga endpoint: requests fail, and there is no
faucet to fund the write wallet.

**Ask.** Keep a single canonical "current network + faucet + explorer" page that old links redirect
to; a retired testnet that still appears in tutorials costs every new builder an afternoon.

---

## 3. The anonymous query budget is 100 units per call and ~100 calls/hour, and 429 handling makes it worse

**Expected.** The public RPC is rate-limited in the abstract, but a demo with a couple of tabs will
not hit it.

**Actual.** `arkiv_query` is a **flat 100 units per charged call**, with roughly **100 charged
calls/hour/IP** for unauthenticated clients. A cold board page is ~4 charged calls (defs + roots +
replies) plus batched hydration; two tabs and a refresh exhaust the budget. Then the HTTP surface
returns 429 and viem's default transport respects `Retry-After`, which can park a call for **tens of
minutes** — the app looks broken rather than rate-limited.

**Fix (shipped).** We built the whole read path to the budget:

- `retryCount: 0` — fail in ~0.6 s instead of sleeping `Retry-After`.
- In-flight de-duplication and a concurrency cap of 2.
- A cooldown that honours `Retry-After` and quota headers, and a rendered "rate limited, resets in
  N s" state — never a silent empty board.
- `limit` + `cursor` paging with `SCAN_ROWS = 100`, and one batched `$key` OR-query per 50 payloads
  instead of a `getEntity` loop.
- The free `arkiv_getEntityCount` call as a change probe (60 s, paused on hidden tabs).
- A WebSocket `watchEntityEvents` subscription so creations/patches are one batched read and deletions
  cost no query at all.
- A localStorage-persisted query cache so a repeat visit renders without a charged call.

Code: [`apps/web/src/lib/arkiv.ts`](../apps/web/src/lib/arkiv.ts),
[`packages/board-core/src/service.ts`](../packages/board-core/src/service.ts),
[`apps/web/src/hooks/useBoard.ts`](../apps/web/src/hooks/useBoard.ts).

**Ask (the one thing we would fix first).**
1. Surface a server-side maximum runtime / `timeoutMs` for `arkiv_query`, and make the HTTP gateway
   fail fast the way the WebSocket surface does instead of hanging.
2. Put remaining quota and reset time in the 429 body and headers — "N queries left, resets in N
   minutes" turns budgeting from guesswork into arithmetic.
3. Say "an access key raises this quota" **in the 429**. We stayed on the anonymous tier, but the
   failure body is where a builder will actually read it.

---

## 4. Attribute types are exact, and a type mismatch returns an empty result with no error

**Expected.** `eq('gate_threshold', 1)` matches `1`, or a mismatched query errors.

**Actual.** Predicates must match the stored type exactly, and a mismatch is **not** an error — the
query runs and returns **zero rows**. The specific trap for us: `gate_threshold` is a `u256` because
real ERC-20 thresholds like `1e18` do not fit `i32`. Querying it with an `i32` predicate, or writing a
large threshold as `i32`, silently produces the wrong answer.

**Fix.** One shared codec builds every attribute through its SDK constructor (`str()`, `i32()`,
`u256()`) on the write side, and readers reconstruct the same types on the query side, so the two can
never drift:

- [`packages/board-core/src/codec.ts`](../packages/board-core/src/codec.ts) (`gateAttributes`,
  `build*Write`).
- [`apps/web/src/lib/post.ts`](../apps/web/src/lib/post.ts) (`sendWrite`, the `typeof v === 'bigint' ?
  u256(v) : …` mapping).
- Pinned by [`tests/fixtures/board-payload-vectors.json`](../packages/board-core/tests/fixtures/board-payload-vectors.json).

**Repro.** Write `gate_threshold` as `i32(1000000000000000000)`, or query an existing `u256` cell with
`eq('gate_threshold', i32(1))`; observe no error and no rows.

**Ask.** Error (or at least warn) on unambiguous type mismatches, and expose the stored type in the
error/empty response. "Empty because it is genuinely empty" and "empty because you used `str` instead
of `i32`" should not be the same answer.

---

## 5. Attribute read shape changed between SDK lines, and numbers arrive as bigints

**Expected.** Read an entity's attributes as plain values.

**Actual.** `0.8` returns attributes as a tagged map (`{ name: { type, value } }`) while older `0.7`
returned an array (`[{ key, value }]`); `u64`/`u256` values deserialize as `bigint`. Mixing versions
across a workspace produced rows of `undefined`.

**Fix.** A single structural adapter normalises both shapes and converts bigints safely, used by both
the web client and the agent plugin:
[`packages/board-core/src/sdk.ts`](../packages/board-core/src/sdk.ts) (`toAttributeRecord`,
`toRawEntity`).

**Ask.** Document the attribute shape change loudly per major, and publish a supported-read-shape note
so a builder can tell whether a row is malformed or the SDK simply changed.

---

## 6. Entity keys are `0x${string}` and case-sensitive as strings

**Expected.** Entity keys are strings you can pass around freely.

**Actual.** The SDK types keys as `` `0x${string}` `` (Hex), and an uppercase key will not match a
lowercase-typed `$key` predicate. A runtime string ends up in a type error that looks more alarming
than the actual fix.

**Fix.** Normalise every key to lowercase at the boundary (`normalizeKey`) and cast once, after a
shape check; [`packages/board-core/src/codec.ts`](../packages/board-core/src/codec.ts),
[`apps/web/src/lib/arkiv.ts`](../apps/web/src/lib/arkiv.ts) (`getMany`).

**Repro.** Query `$key` with the same key in mixed case: no match. Cast a plain `string` into a `$key`
predicate: compiler error, not a runtime one.

---

## 7. BTL is whole 2-second blocks — an odd number of seconds is not representable

**Expected.** Ask for `expiresIn: 7` seconds and get 7 seconds.

**Actual.** Lifetimes are whole blocks at a nominal 2 s each; odd durations do not resolve. The SDK's
`ExpirationTime.fromBlocks` is the primitive, so the conversion has to be explicit.

**Fix.** All TTLs are even multiples of seconds, converted with
`ExpirationTime.fromBlocks(Math.floor(seconds / 2))`, and the codec rejects a non-multiple:
[`apps/web/src/lib/post.ts`](../apps/web/src/lib/post.ts) (`toBlocks`),
[`packages/board-core/src/codec.ts`](../packages/board-core/src/codec.ts) (`requireExpires`),
[`packages/board-core/src/constants.ts`](../packages/board-core/src/constants.ts) (`BLOCK_TIME_S`).

**Ask.** A `fromSeconds` that rounds or rejects loudly, plus the real block time in the SDK constants
(`arkiv_getBlockTiming` tells you; not every client knows to ask).

---

## 8. Tiramisu is not in the wallet's network list, so the write path shows "unsupported network"

**Expected.** Adding the Arkiv chain to the app's network list is enough for the wallet to switch.

**Actual.** Tiramisu is not an AppKit/wagmi default chain, so a wallet left on it renders an
unsupported-network screen, and viem refuses to send an Arkiv transaction from any other chain.

**Fix.** The write path switches the wallet to Tiramisu before sending, adds the chain on EIP-1193
`4902`, and restores the pre-write network afterwards so the wallet is never stranded:
[`apps/web/src/lib/post.ts`](../apps/web/src/lib/post.ts) (`arkivWallet`, `restoreNetwork`),
[`apps/web/src/lib/wallet.ts`](../apps/web/src/lib/wallet.ts).
Regression test: [`apps/web/tests/wallet.spec.ts`](../apps/web/tests/wallet.spec.ts).

**Ask.** An Arkiv chain definition that a wallet library accepts out of the box (name, chain id, RPC,
currency, explorer) and a documented `wallet_addEthereumChain` snippet.

---

## 9. No server-side ordering, and `$createdAt` is not filterable

**Expected.** `orderBy('createdAt')`, or a predicate over creation time.

**Actual.** Results come back newest-first only; there is no `orderBy`. Of the system attributes only
`$owner`, `$creator`, `$key` and `$expiresAt` are indexed and filterable — `$createdAt` and
`$updatedAt` can be selected but not filtered on. We needed block numbers to build a deterministic
order, so we read them from the rows we already had.

**Fix / decision.** Ordering is computed in the client, deliberately: the bump-order fold over
`(createdAt, entityKey)` is deterministic and pinned by fixtures, so two clients with the same entity
set produce the same page order with no server:
[`packages/board-core/src/fold.ts`](../packages/board-core/src/fold.ts),
[`tests/fixtures/board-order-vectors.json`](../packages/board-core/tests/fixtures/board-order-vectors.json).
`$createdAt` block heights still drive wall-time display through a `BlockClock`
([`packages/board-core/src/time.ts`](../packages/board-core/src/time.ts)).

**Ask.** Document clearly that ordering is client-side by design, and note which system attributes are
filterable and which are not — the absence of `$createdAt` from predicates is easy to assume away.

---

_Running total: 9 items. The friction is data; this file is updated as we hit more._
