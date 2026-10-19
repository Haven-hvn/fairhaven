# fairhaven-web

Static Next.js client for Fairhaven boards. Pin `out/` to IPFS (`pnpm deploy` uses pinme,
as haven-dapp does). Nothing runs server-side.

## Setup

```sh
# haven-aol SDK is not on npm; alias a checkout like haven-dapp does
git clone https://github.com/Haven-hvn/haven-aol apps/web/haven-aol   # or: ln -s ../../../haven-aol-main apps/web/haven-aol
cp apps/web/.env.local.example apps/web/.env.local                     # set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
pnpm install
pnpm web:dev
```

## Routes

| Route | What |
|---|---|
| `/` | global feed: every thread across every gate, one bump order |
| `/boards` | boards (`haven.board.def`), plus "open any gate" |
| `/board?b=<slug>&p=<n>&view=index\|catalog` | bump-ordered index with gate card and post form |
| `/thread?b=<slug>&k=<0xkey>` | one thread, reply form |
| `/new` | define a board |
| `/stats?b=<slug>` | board statistics (write-side facts only) and your own numbers when a wallet is connected |
| `/filters` | personal moderation lists (addresses, communities, hide public text, stubs) |
| `/expired` | the expiry page |

`b` may also be `gate:<chainId>:<0xtoken>:<threshold>` for a gate with no definition.

## Where the protocol work lives

`src/lib/arkiv.ts` (store + writes), `src/lib/aol.ts` (unlock, seal, open),
`src/lib/receipt.ts` (membership receipts: attestation key, offline verification of every
author, minting), `src/lib/evm.ts` (your own balance; community mutes), `src/lib/synapse.ts`
(media). Everything else is rendering over `@fairhaven/board-core`.
