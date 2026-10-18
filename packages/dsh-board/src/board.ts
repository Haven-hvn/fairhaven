/**
 * BoardRuntime: the agent-side Fairhaven client. Composes
 *   - an Arkiv public client (reads) and dsh-arkiv's ArkivBackend (writes),
 *   - dsh-haven-aol's AolRuntime (seal / open) wired to ctx.wallet.signDigest,
 *   - a viem balanceOf reader for membership,
 * over the shared @fairhaven/board-core codec, fold, and service layer.
 *
 * Every network-touching factory is routed through `internals` so tests can
 * substitute fakes without a chain, a canister, or a wallet.
 */

import {
  BALANCE_OF_ABI,
  EMPTY_FILTERS,
  MembershipCache,
  VARIANT_TO_EIP155,
  applyFilters,
  boardOf,
  buildDefWrite,
  buildPostWrite,
  buildThreadWrite,
  clampPostTtl,
  currentEpoch,
  decodeTextPlain,
  describeHidden,
  encodeTextPlain,
  filtersFromJson,
  filtersToJson,
  fromBase64,
  gateCidForText,
  gateVersionOf,
  globalPage,
  indexPage,
  loadBoards,
  loadGlobalIndex,
  loadIndex,
  loadThread,
  muteAddress,
  muteCommunity,
  parseGateSpec,
  resolveBoard,
  sha256Hex,
  storedTextBytes,
  toBase64,
  toRawEntity,
  unmuteAddress,
  unmuteCommunity,
  utf8Encode,
  MIME_TO_ENUM,
  type BoardGate,
  type BoardPayload,
  type EntityStore,
  type EntityWrite,
  type FiltersJson,
  type PersonalFilters,
  type PostRecord,
  type QueryOptions,
  type QueryPage,
  type RawEntity,
  type ResolvedBoard,
  type ThreadRecord,
  type WhereClause,
} from '@fairhaven/board-core'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

// ── Seams ───────────────────────────────────────────────────────────────

export interface WalletSeam {
  address(name: string): Promise<string>
  signDigest?(name: string, digestHex: string): Promise<{ address: string; signature: string } | string>
}

export interface CredentialsSeam {
  resolve(ref: string): Promise<string | { value?: string } | undefined>
}

export interface SynapseSeam {
  store(data: Uint8Array, signal?: AbortSignal): Promise<{ cid: string }>
  retrieve(cid: string, signal?: AbortSignal): Promise<Uint8Array>
  pin?(cid: string, signal?: AbortSignal): Promise<unknown>
}

export interface TreasurySeam {
  report(): { balances: unknown[] }
  authorize(category: string, estimatedCostUsd: number): { approved: boolean; reason: string }
  recordExpense(input: { category: string; amount: number; description?: string }): Promise<unknown>
}

/** The subset of dsh-haven-aol's AolRuntime we use. */
export interface AolSeam {
  seal(params: {
    version: 3
    cid: string
    chain: BoardGate['chain']
    tokenAddress: string
    threshold: bigint
    epoch?: number
    plaintext: Uint8Array
  }): Promise<{ sealedBytes: Uint8Array; gateMetadataJson: string }>
  decryptV3(params: { evmAddress: string; gateMetadataJson: string; encryptedFileBytes: Uint8Array; eip712ChainId?: bigint; eip712VerifyingContract?: string }): Promise<Uint8Array>
}

export interface ArkivWriter {
  createEntity(params: { payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }): Promise<{ key: `0x${string}`; txHash: `0x${string}` }>
}

export interface BoardRuntimeOpts {
  wallet: string
  privateKeyRef: string
  arkivRpcUrl: string
  canisterId: string
  icpHost: string
  fetchRootKey: boolean
  eip712ChainId?: bigint
  eip712VerifyingContract?: string
  keyStorePath?: string
  memberCheck: boolean
  evmRpc: Record<string, string>
  postCostUsd: number
  /** Operator-declared personal filters (JSON-safe form; gate specs as strings). */
  filters?: FiltersJson
  /** Durable filter list (versioned JSON). Unset → config + memory only. */
  filtersPath?: string
}

export interface BoardSeams {
  wallet: WalletSeam
  credentials?: CredentialsSeam
  synapse?: SynapseSeam
  treasury?: TreasurySeam
}

/** Test seam: every factory may be replaced. */
export const internals: {
  createStore: ((opts: BoardRuntimeOpts) => Promise<EntityStore & { currentBlock(): Promise<number | undefined> }>) | undefined
  createWriter: ((opts: BoardRuntimeOpts, getPrivateKey: () => Promise<string>) => Promise<ArkivWriter>) | undefined
  createAol: ((opts: BoardRuntimeOpts, signGate: ((digestHex: `0x${string}`) => Promise<`0x${string}`>) | undefined) => Promise<AolSeam>) | undefined
  balanceOf: ((rpcUrl: string, token: string, owner: string) => Promise<bigint>) | undefined
} = { createStore: undefined, createWriter: undefined, createAol: undefined, balanceOf: undefined }

// ── Live factories (lazy imports keep the module loadable in tests) ────

async function liveStore(opts: BoardRuntimeOpts): Promise<EntityStore & { currentBlock(): Promise<number | undefined> }> {
  const { createPublicClient } = await import('@arkiv-network/sdk')
  const chains = await import('@arkiv-network/sdk/chains')
  const { and, eq, or } = await import('@arkiv-network/sdk/query')
  const { key: keyVal } = await import('@arkiv-network/sdk')
  const { isRateLimitError } = await import('@fairhaven/board-core')
  const { http } = await import('viem')
  const chain = opts.arkivRpcUrl.includes('localhost') || opts.arkivRpcUrl.includes('127.0.0.1') ? chains.localhost : chains.tiramisu
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = createPublicClient({ chain, transport: http(opts.arkivRpcUrl, { retryCount: 0 }) } as never)
  const selection = (payload: boolean) => ({ key: true, owner: true, createdAt: true, expiresAt: true, attributes: true, ...(payload ? { payload: true } : {}) })
  return {
    async query(where: WhereClause, q: QueryOptions = {}): Promise<QueryPage> {
      let b = client.select(selection(q.payload === true))
      const clauses = where.map(([k, v]) => (Array.isArray(v) ? or(v.map((x) => eq(k, x as never))) : eq(k, v as never)))
      b = b.where(clauses.length === 1 ? clauses[0] : and(clauses))
      b = b.limit(q.limit ?? 100)
      if (q.cursor) b = b.cursor(q.cursor)
      const res = await b.fetch()
      const entities = ((res.entities ?? []) as unknown[]).map((r) => toRawEntity(r as Record<string, unknown>)).filter((e): e is RawEntity => e !== undefined)
      return { entities, ...(res.cursor ? { cursor: String(res.cursor) } : {}) }
    },
    async queryOr(clauses: WhereClause[], q: QueryOptions = {}): Promise<QueryPage> {
      let b = client.select({ key: true, owner: true, createdAt: true, expiresAt: true, attributes: true, ...(q.payload === false ? {} : { payload: true }) })
      const clause = (k: string, v: string | number | readonly string[]) => k === '$key' ? eq('$key', keyVal(String(v) as `0x${string}`)) : Array.isArray(v) ? or(v.map((x) => eq(k, x as never))) : eq(k, v as never)
      const sets = clauses.map((set) => { const cs = set.map(([k, v]) => clause(k, v)); return cs.length === 1 ? cs[0]! : and(cs) })
      b = b.where(sets.length === 1 ? sets[0] : or(sets))
      b = b.limit(q.limit ?? 100)
      if (q.cursor) b = b.cursor(q.cursor)
      const res = await b.fetch()
      return { entities: ((res.entities ?? []) as unknown[]).map((r) => toRawEntity(r as Record<string, unknown>)).filter((e): e is RawEntity => e !== undefined), ...(res.cursor ? { cursor: String(res.cursor) } : {}) }
    },
    async getMany(keys: string[]): Promise<RawEntity[]> {
      if (keys.length === 0) return []
      let b = client.select({ key: true, owner: true, createdAt: true, expiresAt: true, attributes: true, payload: true })
      b = b.where(or(keys.map((k) => eq('$key', keyVal(k as `0x${string}`)))))
      b = b.limit(Math.max(keys.length, 1))
      const res = await b.fetch()
      return ((res.entities ?? []) as unknown[]).map((r) => toRawEntity(r as Record<string, unknown>)).filter((e): e is RawEntity => e !== undefined)
    },
    async get(key: string): Promise<RawEntity | undefined> {
      try {
        const row = await client.getEntity(key as `0x${string}`)
        return row ? toRawEntity(row as Record<string, unknown>) : undefined
      } catch (e) {
        if (isRateLimitError(e)) throw e
        return undefined
      }
    },
    async currentBlock(): Promise<number | undefined> {
      try {
        const t = await client.getBlockTiming()
        return Number(t.currentBlock)
      } catch {
        return undefined
      }
    },
  }
}

async function liveWriter(opts: BoardRuntimeOpts, getPrivateKey: () => Promise<string>): Promise<ArkivWriter> {
  // dsh-arkiv's ArkivBackend: wallet-client creates via @arkiv-network/sdk. We
  // bypass ctx.arkiv (ArkivRuntime) because its Haven media validator rejects
  // text-only board records.
  const mod = (await import('dsh-arkiv/arkiv')) as unknown as {
    ArkivBackend: new (o: { privateKeyRef: string; getPrivateKey: () => Promise<string>; rpcUrl: string }) => ArkivWriter
  }
  return new mod.ArkivBackend({ privateKeyRef: opts.privateKeyRef, getPrivateKey, rpcUrl: opts.arkivRpcUrl })
}

async function liveAol(opts: BoardRuntimeOpts, signGate: ((digestHex: `0x${string}`) => Promise<`0x${string}`>) | undefined): Promise<AolSeam> {
  const mod = (await import('dsh-haven-aol')) as unknown as { AolRuntime: new (o: Record<string, unknown>) => AolSeam }
  return new mod.AolRuntime({
    canisterId: opts.canisterId,
    icpHost: opts.icpHost,
    fetchRootKey: opts.fetchRootKey,
    ...(opts.eip712ChainId !== undefined ? { eip712ChainId: opts.eip712ChainId } : {}),
    ...(opts.eip712VerifyingContract !== undefined ? { eip712VerifyingContract: opts.eip712VerifyingContract } : {}),
    ...(opts.keyStorePath !== undefined ? { keyStorePath: opts.keyStorePath } : {}),
    ...(signGate ? { signGate } : {}),
  })
}

async function liveBalanceOf(rpcUrl: string, token: string, owner: string): Promise<bigint> {
  const { createPublicClient, http } = await import('viem')
  const client = createPublicClient({ transport: http(rpcUrl) })
  const v = await client.readContract({ address: token as `0x${string}`, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [owner as `0x${string}`] })
  return BigInt(v as bigint)
}

// ── Runtime ─────────────────────────────────────────────────────────────

export interface VerifiedPost {
  key: string
  short: string
  owner: string
  you: boolean
  member: true
  verified: Array<'balance' | 'decrypt' | 'hash'>
  createdAt: number
  expiresAt?: number
  parent?: string
  noBump?: boolean
  sealed: number
  /** Opened or clear text. Untrusted content. */
  text: string
  media?: { locator: string; sealed: boolean; mime: number; size: number; name?: string }
}

export interface RejectedPost {
  key: string
  owner: string
  reason: string
}

export class BoardRuntime {
  private storeP: Promise<EntityStore & { currentBlock(): Promise<number | undefined> }> | undefined
  private writerP: Promise<ArkivWriter> | undefined
  private aolP: Promise<AolSeam> | undefined
  private readonly members: MembershipCache
  /** Personal filters: config seeds them, file (if configured) extends them, tools edit them. */
  private filters: PersonalFilters
  private filtersLoaded: Promise<void> | undefined

  constructor(
    private readonly opts: BoardRuntimeOpts,
    private readonly seams: BoardSeams,
  ) {
    this.members = new MembershipCache({
      balanceOf: async (chainId, token, owner) => {
        const url = this.opts.evmRpc[String(chainId)] ?? ''
        const r = await (internals.balanceOf ?? liveBalanceOf)(url, token, owner)
        return r
      },
    })
    this.filters = opts.filters ? filtersFromJson(opts.filters) : EMPTY_FILTERS
  }

  // ── Personal filters ───────────────────────────────────────────────

  private async loadFilters(): Promise<void> {
    if (!this.filtersLoaded) {
      this.filtersLoaded = (async () => {
        if (!this.opts.filtersPath) return
        try {
          const raw = JSON.parse(await readFile(this.opts.filtersPath, 'utf8')) as unknown
          const fromFile = filtersFromJson(raw)
          // Union: config lists + file lists; booleans from file win (they are user edits).
          let f = this.filters
          for (const a of fromFile.addresses) f = muteAddress(f, a)
          for (const g of fromFile.communities) f = muteCommunity(f, g)
          this.filters = { ...f, hideClear: fromFile.hideClear, showStubs: fromFile.showStubs }
        } catch {
          /* no file yet */
        }
      })()
    }
    return this.filtersLoaded
  }

  private async saveFilters(): Promise<void> {
    const p = this.opts.filtersPath
    if (!p) return
    await mkdir(dirname(p), { recursive: true })
    const tmp = `${p}.tmp`
    await writeFile(tmp, JSON.stringify(filtersToJson(this.filters), null, 2), { mode: 0o600 })
    await rename(tmp, p)
  }

  async getFilters(): Promise<FiltersJson> {
    await this.loadFilters()
    return filtersToJson(this.filters)
  }

  async mute(a: { address?: string; gate?: string; hideClear?: boolean }): Promise<FiltersJson> {
    await this.loadFilters()
    if (a.address) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(a.address)) throw new Error('dsh-board: address must be 0x + 40 hex')
      this.filters = muteAddress(this.filters, a.address)
    }
    if (a.gate) {
      const g = parseGateSpec(a.gate)
      if (!g) throw new Error('dsh-board: gate must be gate:<chainId>:<0xtoken>:<threshold>')
      this.filters = muteCommunity(this.filters, g)
    }
    if (a.hideClear !== undefined) this.filters = { ...this.filters, hideClear: a.hideClear }
    await this.saveFilters()
    return filtersToJson(this.filters)
  }

  async unmute(a: { address?: string; gate?: string }): Promise<FiltersJson> {
    await this.loadFilters()
    if (a.address) this.filters = unmuteAddress(this.filters, a.address)
    if (a.gate) {
      const g = parseGateSpec(a.gate)
      if (g) this.filters = unmuteCommunity(this.filters, g)
    }
    await this.saveFilters()
    return filtersToJson(this.filters)
  }

  /** Drop personally-filtered records; return them separately with reasons. */
  private async filterOut<T extends { key: string; owner: string; sealed: number }>(records: readonly T[], me: string): Promise<{ kept: T[]; hidden: Array<{ key: string; owner: string; reason: string }> }> {
    await this.loadFilters()
    const annotated = await applyFilters(records, this.filters, { members: this.members, me })
    const kept: T[] = []
    const hidden: Array<{ key: string; owner: string; reason: string }> = []
    for (const a of annotated) {
      if (a.hidden) hidden.push({ key: a.record.key, owner: a.record.owner, reason: describeHidden(a.hidden) })
      else kept.push(a.record)
    }
    return { kept, hidden }
  }

  private store() {
    return (this.storeP ??= (internals.createStore ?? liveStore)(this.opts))
  }

  private async privateKey(): Promise<string> {
    const ref = this.opts.privateKeyRef
    let v: string | undefined
    try {
      const r = await this.seams.credentials?.resolve(ref)
      v = typeof r === 'string' ? r : r?.value
    } catch {
      v = undefined
    }
    if (!v) v = globalThis.process?.env?.[ref]
    if (!v) throw new Error(`dsh-board: credential ${ref} not found (set it in the credential store or env; never paste a key into config)`)
    return v
  }

  private writer() {
    return (this.writerP ??= (internals.createWriter ?? liveWriter)(this.opts, () => this.privateKey()))
  }

  private aol() {
    if (!this.aolP) {
      const w = this.seams.wallet
      const signGate = typeof w.signDigest === 'function'
        ? async (digestHex: `0x${string}`) => {
            const res = await w.signDigest!(this.opts.wallet, digestHex)
            return (typeof res === 'string' ? res : res.signature) as `0x${string}`
          }
        : undefined
      this.aolP = (internals.createAol ?? liveAol)(this.opts, signGate)
    }
    return this.aolP
  }

  async address(): Promise<string> {
    return (await this.seams.wallet.address(this.opts.wallet)).toLowerCase()
  }

  // ── Reads ───────────────────────────────────────────────────────────

  async listBoards() {
    const boards = await loadBoards(await this.store())
    return boards.map((b) => ({
      board: b.board,
      title: b.title,
      about: b.about,
      gate: { chain: b.gate.chain, chainId: VARIANT_TO_EIP155[b.gate.chain], token: b.gate.tokenAddress, threshold: b.gate.threshold.toString() },
      bumpLimit: b.bumpLimit,
      capacity: b.capacity,
      pageSize: b.pageSize,
      defaults: b.defaults,
      ttl: b.ttl,
      owner: b.owner,
      createdAt: b.createdAt,
      ...(b.expiresAt !== undefined ? { expiresAt: b.expiresAt } : {}),
    }))
  }

  async resolve(slugOrGate: string): Promise<ResolvedBoard> {
    const b = await resolveBoard(await this.store(), slugOrGate)
    if (!b) throw new Error(`dsh-board: unknown board ${JSON.stringify(slugOrGate)} (use a slug from board_list or gate:<chainId>:<token>:<threshold>)`)
    return b
  }

  async index(slugOrGate: string, page = 1) {
    const store = await this.store()
    const board = await this.resolve(slugOrGate)
    const current = await store.currentBlock()
    const idx = await loadIndex(store, board, current)
    const pg = indexPage(idx, page)
    const me = await this.address().catch(() => '')
    const memberOf = this.opts.memberCheck ? await this.memberMap(board.ref.gate, [...pg.items.map((i) => i.thread.owner), ...pg.items.flatMap((i) => i.tail.map((t) => t.owner))]) : undefined
    const keep = (owner: string) => !memberOf || memberOf.get(owner.toLowerCase()) === true
    const memberItems = pg.items.filter((i) => keep(i.thread.owner)).map((i) => ({ ...i, tail: i.tail.filter((t) => keep(t.owner)) }))
    // Personal filters drop rendering only; the fold above already ran on the full set.
    const { kept: keptThreads, hidden: hiddenThreads } = await this.filterOut(memberItems.map((i) => i.thread), me)
    const keptKeys = new Set(keptThreads.map((t) => t.key))
    const { kept: keptTail, hidden: hiddenTail } = await this.filterOut(memberItems.flatMap((i) => i.tail), me)
    const tailKeys = new Set(keptTail.map((t) => t.key))
    return {
      board: board.ref.slug,
      title: board.title,
      gate: `gate:${VARIANT_TO_EIP155[board.ref.gate.chain]}:${board.ref.gate.tokenAddress}:${board.ref.gate.threshold}`,
      page: pg.page,
      pages: pg.pages,
      ...(current !== undefined ? { currentBlock: current } : {}),
      threads: memberItems
        .filter((i) => keptKeys.has(i.thread.key))
        .map((i) => ({
          key: i.thread.key,
          source: i.thread.source,
          grp: i.thread.grp,
          subject: i.thread.subject,
          owner: i.thread.owner,
          you: i.thread.owner === me,
          createdAt: i.thread.createdAt,
          ...(i.thread.expiresAt !== undefined ? { expiresAt: i.thread.expiresAt } : {}),
          bumpAt: i.folded.bumpAt,
          replies: i.folded.replyCount,
          sealed: i.thread.sealed,
          gateVersion: i.thread.gateVersion,
          mime: i.thread.mime,
          tail: i.tail.filter((t) => tailKeys.has(t.key)).map((t) => ({ key: t.key, owner: t.owner, createdAt: t.createdAt, sealed: t.sealed, noBump: t.noBump })),
        })),
      hidden: [...hiddenThreads, ...hiddenTail],
    }
  }

  async feed(page = 1) {
    const store = await this.store()
    const current = await store.currentBlock()
    const idx = await loadGlobalIndex(store, { ...(current !== undefined ? { currentBlock: current } : {}) })
    const pg = globalPage(idx, page)
    const me = await this.address().catch(() => '')
    const threads: Array<Record<string, unknown>> = []
    const hidden: Array<{ key: string; owner: string; reason: string }> = []
    for (const i of pg.items) {
      const board = boardOf(idx, i.thread)
      const memberOf = this.opts.memberCheck ? await this.memberMap(board.ref.gate, [i.thread.owner, ...i.tail.map((t) => t.owner)]) : undefined
      const keep = (owner: string) => !memberOf || memberOf.get(owner.toLowerCase()) === true
      if (!keep(i.thread.owner)) continue
      const { kept, hidden: h } = await this.filterOut([i.thread, ...i.tail.filter((t) => keep(t.owner))], me)
      hidden.push(...h)
      if (!kept.some((k) => k.key === i.thread.key)) continue
      const tailKeys = new Set(kept.map((k) => k.key))
      threads.push({
        key: i.thread.key,
        board: board.ref.slug,
        gate: `gate:${VARIANT_TO_EIP155[board.ref.gate.chain]}:${board.ref.gate.tokenAddress}:${board.ref.gate.threshold}`,
        source: i.thread.source,
        subject: i.thread.subject,
        owner: i.thread.owner,
        you: i.thread.owner === me,
        createdAt: i.thread.createdAt,
        bumpAt: i.folded.bumpAt,
        replies: i.folded.replyCount,
        sealed: i.thread.sealed,
        mime: i.thread.mime,
        tail: i.tail.filter((t) => tailKeys.has(t.key)).map((t) => ({ key: t.key, owner: t.owner, createdAt: t.createdAt, sealed: t.sealed })),
      })
    }
    return { page: pg.page, pages: pg.pages, gates: idx.boards.size, ...(current !== undefined ? { currentBlock: current } : {}), threads, hidden }
  }

  async thread(slugOrGate: string, rootKey: string): Promise<{ board: string; root: VerifiedPost; replies: VerifiedPost[]; rejected: RejectedPost[]; hidden: Array<{ key: string; owner: string; reason: string }> }> {
    const store = await this.store()
    const board = await this.resolve(slugOrGate)
    const current = await store.currentBlock()
    const loaded = await loadThread(store, board, rootKey, current)
    if (!loaded) throw new Error(`dsh-board: thread ${rootKey} not found on ${board.ref.slug} (expired, deleted, or not under this gate)`)
    const me = await this.address().catch(() => '')
    const rejected: RejectedPost[] = []
    const memberOf = this.opts.memberCheck ? await this.memberMap(board.ref.gate, [loaded.root.owner, ...loaded.replies.map((r) => r.owner)]) : undefined
    // Personal filters: the root is never dropped (the caller asked for this thread), replies are.
    const { kept: keptReplies, hidden } = await this.filterOut(loaded.replies, me)

    const verify = async (rec: ThreadRecord | PostRecord): Promise<VerifiedPost | undefined> => {
      if (memberOf && memberOf.get(rec.owner) !== true) {
        rejected.push({ key: rec.key, owner: rec.owner, reason: 'owner does not hold the gate token' })
        return undefined
      }
      const verified: VerifiedPost['verified'] = memberOf ? ['balance'] : []
      let text = ''
      if (rec.payload) {
        if (rec.kind === 'post' || (rec.kind === 'thread' && rec.source !== 'haven')) {
          const stored = storedTextBytes(rec.payload)
          if ((await sha256Hex(stored)) !== rec.sha256Ct) {
            rejected.push({ key: rec.key, owner: rec.owner, reason: 'sha256_ct does not match stored text' })
            return undefined
          }
          verified.push('hash')
        }
        if ('clear' in rec.payload.text) text = rec.payload.text.clear
        else if (rec.payload.gate) {
          try {
            text = await this.openSealedText(rec.payload.text.sealed, rec.payload.gate)
            verified.push('decrypt')
          } catch (e) {
            rejected.push({ key: rec.key, owner: rec.owner, reason: `sealed text did not open: ${e instanceof Error ? e.message : String(e)}` })
            return undefined
          }
        }
      }
      const m = rec.kind === 'thread' ? rec.payload?.media : undefined
      const out: VerifiedPost = {
        key: rec.key,
        short: rec.key.slice(2, 10),
        owner: rec.owner,
        you: rec.owner === me,
        member: true,
        verified,
        createdAt: rec.createdAt,
        ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
        ...(rec.kind === 'post' && rec.parentRef ? { parent: rec.parentRef } : {}),
        ...(rec.kind === 'post' ? { noBump: rec.noBump } : {}),
        sealed: rec.sealed,
        text,
        ...(m ? { media: { locator: m.piece ?? m.fcid ?? '', sealed: m.piece !== undefined, mime: m.mime, size: m.size, ...(m.name ? { name: m.name } : {}) } } : {}),
      }
      return out
    }

    const root = await verify(loaded.root)
    if (!root) throw new Error(`dsh-board: thread root rejected: ${rejected.at(-1)?.reason}`)
    const replies: VerifiedPost[] = []
    for (const r of keptReplies) {
      const v = await verify(r)
      if (v) replies.push(v)
    }
    return { board: board.ref.slug, root, replies, rejected, hidden }
  }

  private async memberMap(gate: BoardGate, owners: string[]): Promise<Map<string, boolean>> {
    const uniq = [...new Set(owners.map((o) => o.toLowerCase()))]
    const res = await Promise.all(uniq.map((o) => this.members.isMember(gate, o)))
    return new Map(uniq.map((o, i) => [o, res[i] as boolean]))
  }

  private async openSealedText(sealedB64: string, gateJson: string): Promise<string> {
    const v = gateVersionOf(gateJson)
    if (v !== 3) throw new Error(`gate version ${v ?? 'unknown'} is not v3 (boards open v3 only)`)
    const aol = await this.aol()
    const plain = await aol.decryptV3({ evmAddress: await this.address(), gateMetadataJson: gateJson, encryptedFileBytes: fromBase64(sealedB64) })
    // AolRuntime opens the framing and returns plaintext; decode the padded text envelope.
    return openTextPlain(plain)
  }

  // ── Writes ──────────────────────────────────────────────────────────

  private async spend<T>(what: string, task: () => Promise<T>): Promise<T> {
    const t = this.seams.treasury
    const funded = (() => {
      try {
        return (t?.report().balances.length ?? 0) > 0
      } catch {
        return false
      }
    })()
    if (t && funded) {
      const d = t.authorize('tools', this.opts.postCostUsd)
      if (!d.approved) throw new Error(`dsh-board: treasury denied ${what}: ${d.reason}`)
    }
    const out = await task()
    if (t && funded) {
      await t.recordExpense({ category: 'tools', amount: this.opts.postCostUsd, description: `board ${what}` }).catch(() => undefined)
    }
    return out
  }

  private async requireMember(gate: BoardGate): Promise<void> {
    if (!this.opts.memberCheck) return
    const me = await this.address()
    if (!(await this.members.isMember(gate, me))) {
      throw new Error(`dsh-board: ${me} does not hold ≥ ${gate.threshold} of ${gate.tokenAddress} on ${gate.chain}; acquire the gate token before posting`)
    }
  }

  private async sealFields(gate: BoardGate, text: string, sealText: boolean, media: Uint8Array | undefined, sealMedia: boolean) {
    const epoch = currentEpoch()
    let gateJson: string | undefined
    let textField: BoardPayload['text']
    let textBytes: Uint8Array
    let mediaBytes = media
    if (sealText || (media && sealMedia)) {
      const aol = await this.aol()
      // One AES key per post: AolRuntime's v3 seal shares one key per
      // (chain, token, threshold, epoch) bucket, so sealing text and media
      // with the same cid yields one gate record for the post.
      const textPlain = encodeTextPlainForAol(text)
      const probeSha = await sha256Hex(textPlain)
      const cid = gateCidForText(probeSha)
      if (sealText) {
        const r = await aol.seal({ version: 3, cid, chain: gate.chain, tokenAddress: gate.tokenAddress, threshold: gate.threshold, epoch, plaintext: textPlain })
        textBytes = r.sealedBytes
        textField = { sealed: toBase64(textBytes) }
        gateJson = r.gateMetadataJson
      } else {
        textBytes = utf8Encode(text)
        textField = { clear: text }
      }
      if (media && sealMedia) {
        const r = await aol.seal({ version: 3, cid, chain: gate.chain, tokenAddress: gate.tokenAddress, threshold: gate.threshold, epoch, plaintext: media })
        mediaBytes = r.sealedBytes
        gateJson ??= r.gateMetadataJson
      }
    } else {
      textBytes = utf8Encode(text)
      textField = { clear: text }
    }
    return { gateJson, textField, textBytes, mediaBytes, sha256Ct: await sha256Hex(textBytes) }
  }

  async createBoard(a: { board: string; title: string; about?: string; gate: BoardGate; bumpLimit?: number; capacity?: number; pageSize?: number; sealText?: boolean; sealMedia?: boolean; threadTtlS?: number; postTtlS?: number; expiresIn?: number }) {
    await this.requireMember(a.gate)
    const w = buildDefWrite({
      board: a.board,
      title: a.title,
      about: a.about ?? '',
      gate: a.gate,
      ...(a.bumpLimit !== undefined ? { bumpLimit: a.bumpLimit } : {}),
      ...(a.capacity !== undefined ? { capacity: a.capacity } : {}),
      ...(a.pageSize !== undefined ? { pageSize: a.pageSize } : {}),
      defaults: { ...(a.sealText !== undefined ? { sealText: a.sealText } : {}), ...(a.sealMedia !== undefined ? { sealMedia: a.sealMedia } : {}) },
      ttl: { ...(a.threadTtlS !== undefined ? { thread_s: a.threadTtlS } : {}), ...(a.postTtlS !== undefined ? { post_s: a.postTtlS } : {}) },
      ...(a.expiresIn !== undefined ? { expiresIn: a.expiresIn } : {}),
    })
    return this.spend('create', () => this.write(w))
  }

  async postThread(a: { board: string; subject: string; text: string; sealText?: boolean; media?: { bytes: Uint8Array; mime: string; name?: string }; sealMedia?: boolean }) {
    const board = await this.resolve(a.board)
    await this.requireMember(board.ref.gate)
    const sealText = a.sealText ?? board.defaults.sealText
    const sealMedia = a.sealMedia ?? board.defaults.sealMedia
    const { gateJson, textField, mediaBytes, sha256Ct } = await this.sealFields(board.ref.gate, a.text, sealText, a.media?.bytes, sealMedia)
    const payload: BoardPayload = { v: 1, text: textField, ...(gateJson ? { gate: gateJson } : {}) }
    if (a.media) {
      const synapse = this.seams.synapse
      if (!synapse) throw new Error('dsh-board: media given but ctx.synapse is not mounted — install dsh-storage-synapse or post text only')
      const mime = MIME_TO_ENUM[a.media.mime]
      if (mime === undefined) throw new Error(`dsh-board: unsupported media type ${a.media.mime} (shared Haven MIME enum)`)
      const bytes = mediaBytes as Uint8Array
      const { cid } = await synapse.store(bytes)
      await synapse.pin?.(cid).catch(() => undefined)
      payload.media = {
        ...(sealMedia ? { piece: cid } : { fcid: cid }),
        mime,
        size: bytes.length,
        ...(a.media.name ? { name: a.media.name } : {}),
        sha256: await sha256Hex(bytes),
      }
    }
    const w = buildThreadWrite({ board: board.ref.slug, subject: a.subject, gate: board.ref.gate, payload, sha256Ct, expiresIn: board.threadTtlS })
    return this.spend('post', () => this.write(w))
  }

  async reply(a: { board: string; root: string; text: string; parent?: string; noBump?: boolean; sealText?: boolean }) {
    const store = await this.store()
    const board = await this.resolve(a.board)
    const current = await store.currentBlock()
    const loaded = await loadThread(store, board, a.root, current)
    if (!loaded) throw new Error(`dsh-board: root ${a.root} is not a live thread on ${board.ref.slug}`)
    await this.requireMember(board.ref.gate)
    if (a.parent && a.parent.toLowerCase() !== loaded.root.key && !loaded.replies.some((r) => r.key === a.parent!.toLowerCase())) {
      throw new Error(`dsh-board: parent ${a.parent} is not in this thread`)
    }
    const sealText = a.sealText ?? board.defaults.sealText
    const { gateJson, textField, sha256Ct } = await this.sealFields(board.ref.gate, a.text, sealText, undefined, false)
    const payload: BoardPayload = { v: 1, text: textField, ...(gateJson ? { gate: gateJson } : {}) }
    const rootRemaining = loaded.root.expiresAt !== undefined && current !== undefined ? (loaded.root.expiresAt - current) * 2 : undefined
    const w = buildPostWrite({
      board: board.ref.slug,
      rootRef: loaded.root.key,
      ...(a.parent && a.parent.toLowerCase() !== loaded.root.key ? { parentRef: a.parent.toLowerCase() } : {}),
      noBump: a.noBump ?? false,
      gate: board.ref.gate,
      payload,
      sha256Ct,
      expiresIn: clampPostTtl(board.postTtlS, rootRemaining),
    })
    return this.spend('reply', () => this.write(w))
  }

  private async write(w: EntityWrite): Promise<{ key: string; txHash: string }> {
    const writer = await this.writer()
    const { key, txHash } = await writer.createEntity({ payload: w.payload, contentType: w.contentType, attributes: w.attributes, expiresIn: w.expiresIn })
    return { key, txHash }
  }
}

// ── Text envelope helpers (board-core's padded JSON) ────────────────────

function encodeTextPlainForAol(text: string): Uint8Array {
  return encodeTextPlain(text)
}

function openTextPlain(plain: Uint8Array): string {
  return decodeTextPlain(plain)
}
