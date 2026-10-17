# Fairhaven UI

Dense, square, utilitarian. One column. No shadows, gradients, rounded corners,
avatars, reactions, badges, infinite scroll. The only non-flat element is **frost**,
the treatment for sealed content, which is why it reads as "something is here."

## Views

- **Front page** (`/?p=<n>`): the global feed. Every thread on the network across every gate, one bump order (shared fold, default constants, capacity 300). Each thread is tagged with its board (`/slug/`) and renders open or frosted per the viewer's holdings for *that* gate. Read-only; posting happens on a board. This is what keeps a young network from looking empty: ten sparse boards become one busy page.
- **Boards** (`/boards`): list of board definitions with gate card summary, plus "open any gate".
- **Index** (`/board?b=<slug>&p=<n>`): gate card, post form, threads in bump order, each as OP + omission line + last 3 replies. Catalog toggle (`&view=catalog`) shows a grid of OP media/placeholder tiles in the same order.
- **Thread** (`/thread?b=<slug>&k=<key>`): OP and all replies, reply form at bottom. Deleted or expired → `/expired`.
- **Stats** (`/stats?b=<slug>`): board counts (threads, replies, posters, activity 24h/7d, sealed shares, media mix, expiry, posts-per-day bars) and, with a wallet connected, your own numbers. Write-side facts only; Haven records no reads. No per-address leaderboard of other people.
- **New board** (`/new`): gate, title, ordering constants, defaults, lifetime.

## States every sealed element has

| State | Text | Media |
|---|---|---|
| Locked | frosted lines, count ∝ ciphertext bucket, lock glyph | BlurHash tile if `hint`, else MIME placeholder tile, frosted |
| Unlocking | same, shimmer | same |
| Open | plain text | thumbnail / inline player / download |
| Failed | frosted, "could not open" | same |

Clear content gets no treatment.

Every frosted element carries a one-line caption that says why and what to do, and the
frost itself is clickable to do it. The caption adapts to the viewer:

| Viewer | Caption | Click |
|---|---|---|
| No wallet | 🔒 Members only · hold ≥ 1 BACK on Base · **connect wallet** | opens wallet modal |
| Holder, not unlocked | 🔒 Members only · you hold the token · **sign to unlock (no gas, once a month)** | signs GateRequestV3 |
| Not a holder | 🔒 Members only · you hold 0 of 1 BACK · **get BACK** | scrolls to the gate card |
| Sealed by v1/v4 Haven app | 🔒 Sealed by another Haven app (v4) · **open in haven-dapp** | new tab |
| Failed | 🔒 Could not open: … · **retry** | re-runs unlock |

Frost means "encrypted", never "please buy": clear text is public on Arkiv and is shown
as such. A board that wants nothing public sets both sealing defaults on.

## Gate card copy (one card per board, under the navbar)

1. No wallet: "Members hold at least {threshold} {TOKEN} on {chain}. [Connect wallet]"
2. Holder, locked: "You hold {balance}. [Unlock for 30 days]" + "This proves you control this wallet. No transaction, no gas."
3. Holder, unlocked: one line "Member · unlocked until {date}"
4. Not a holder: "You hold {balance} of {threshold}. [Get {TOKEN}] [Check again]"
5. Wrong network for posting: "Switch to Arkiv Tiramisu to post" (reads need no switch)

## Post form

Subject (threads only), Comment, File (threads only), two lock toggles (text, file)
preset from the board defaults, `no bump` checkbox (replies only). Under the form an
exposure line updates live: `Subject · public  ·  Text · members  ·  File · members`.
Submit shows the post in place as "confirming" until it appears in the query.

## Identity rendering

Owner address → `0x4f2e…91c3`. Posts by the connected wallet are marked "(you)".
Short post id = first 8 hex chars after `0x` of the entity key, rendered `>>8f3a2c1d`,
clickable, with hover preview and red backlink markers on quoted posts. Lines starting
with `>` render green.

## Personal filters

Every post's meta line has `[Hide ▾]`: mute this address, or mute holders of another
community (gate spec). `/filters` manages the lists, the "hide public-text posts" switch,
and whether hidden posts show as one-line stubs (default) or vanish. Stubs have `Show` to
reveal one post without unmuting. Filters never reorder threads; a thread whose OP is
hidden still occupies its position as a stub. Lists live in localStorage only.

## Media viewers

| Kind | Types | Viewer |
|---|---|---|
| Image | png, jpeg, webp, gif, svg | inline, click to expand; BlurHash frosted tile when sealed |
| Video | mp4, webm, quicktime | native `<video controls>` |
| Audio | mp3, wav, ogg | native `<audio controls>` |
| Document | pdf | `<iframe>` |
| Text | txt, md | `<pre>` |
| Comic | cbz | in-browser reader: unzip once, natural page order, single/double page, LTR/RTL, fit height/width, arrow keys, tap zones, slider, remembers last page per thread on this device |
| Comic | cbr | download only, with a note to convert to CBZ |
| Other | | download link |

## Sharing

Every thread has a stable URL, `/thread?b=<slug>&k=<entity key>`, and every post an
anchor, `#p<short id>`. `[Share]` on an OP and `[Link]` on a reply use the native share
sheet on phones and the clipboard elsewhere, with a 1.5 s "copied" confirmation
(haven-dapp's `/watch?v=` behaviour). Boards share as `/board?b=<slug>`; a gate with no
definition shares as `/board?b=gate:<chainId>:<token>:<threshold>`. A recipient without
the token lands on the frosted view with the gate card, which is the intended teaser.
Link previews (Open Graph) are generic: the site is a static export and thread subjects
live on-chain, so there is no server to render per-thread cards.

## Progress, honestly

Every wait shows one line of plain text with exact numbers and a `cancel`. No bars, no
spinners, no invented percentages. The only motion is the frost shimmer while something
is in flight.

| Step | Line | Source of the number |
|---|---|---|
| Unlock | `Sign to prove you control this wallet…` → `Asking the network for the board key…` | actual stages of the EIP-712 sign + canister call |
| Fetch media | `fetching · 3.5 MB of 8.4 MB · cancel` | bytes read from the response stream; the total is shown only if the provider sent `Content-Length` (else the declared `size` from the payload, else bytes alone) |
| Open sealed media | `opening · 4 of 9 · cancel` | 1 MiB chunks decrypted; the decryptor yields between chunks so the line can paint |
| Comic | `Unpacking name.cbz…` then `‹ 3–4 / 42 ›` | archive entries |
| Post | `Sealing…` → `Pinning… 42%` → `Confirm in wallet…` | local seal; Synapse upload callback; wallet prompt |
| Confirm | reply rendered dimmed with `confirming on Arkiv…` until it appears in the query | the next index poll |

Opened media is kept for the tab (200 MB cap, oldest evicted) so moving between the
feed, a board, and a thread never re-downloads or re-decrypts the same file. Cleared on
disconnect along with the keys.

## Prefetch and pre-open (holders)

If the viewer can already open a file (clear, or sealed under an epoch they have
unlocked), the client fetches and decrypts it before they ask, following haven-dapp's
`video-prefetch` policy: one download at a time, a queue of five, nothing on data-saver,
2g, or slow cellular, idle items ≤ 40 MB, and the open cache's byte budget as the ceiling.
Triggers: the OP enters a 600 px margin around the viewport, or the mouse rests on it for
1.5 s. Idle prefetch shows nothing; if the user clicks while one is in flight the view
attaches to the same task and shows its real numbers.

The result is that a holder sees media the way an imageboard shows it: images as real
thumbnails, video and audio as ready players (`preload="metadata"`, blob URL, so pressing
play is immediate), documents and comics as a "ready" tile. One click expands; nothing
loads on that click. Non-holders see frost; nothing is fetched for them.

## Mark

`apps/web/public/mark.svg` (also `src/app/icon.svg` as favicon, `components/Mark.tsx`
inline). A haven silhouette: two crenellated towers, a wall, one open arched doorway cut
out as negative space so it reads on any background, and a single pennant on the skyline
for the "fair". Flat, square, monochrome, `currentColor`; legible at 16 px. It appears
only where an image slot would otherwise be empty: the favicon, the gate card when a
collection publishes no icon, and the expiry page. It never appears in the navbar or
next to content.

## Palette

Daybreak (default) and Parchment. Structure is the classic two-tone imageboard layout;
three pairs in the source palette failed WCAG AA at 13 px and were darkened. Run
`scripts/audit-contrast.mjs`-style checks before changing these.

| Role | Daybreak | Parchment |
|---|---|---|
| page bg | `#EEF2FF` | `#FFFFEE` |
| post header / reply bg | `#D6DAF0` | `#F0E0D6` |
| border | `#B7C5D9` | `#D9BFA7` |
| subject | `#0F0C5D` | `#800000` |
| name (owner) | `#0D5C33` (was `#117743`, 4.0:1) | `#0D5C33` |
| timestamp | `#555555` (was `#666666`, 4.1:1) | `#555555` |
| post id | `#800000` | `#800000` |
| body | `#000000` | `#000000` |
| link | `#3473C3` | `#800000` |
| greentext | `#4A6610` (was `#789922`, 2.4:1) | `#4A6610` |
| backlink marker | `#DD0000` | `#DD0000` |
| frost | `rgba(255,255,255,.55)` over `#C9CFE8` stripes | over `#E6D2C4` |

Body 13 px Arial/Helvetica, line-height 1.25. Container 75 % width ≥ 768 px, 100 %
below. Tap targets ≥ 32 px on phones for `>>` links and form buttons.
