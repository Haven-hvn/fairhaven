'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { CHAIN_LABEL, computeBoardStats, computeMyStats, epochEndUnix, currentEpoch, loadReplies, loadRoots, dropExpired, type BoardIndex, type BoardStats, type MyStats, type ResolvedBoard } from '@fairhaven/board-core'
import { arkivStore } from '@/lib/arkiv'
import { useCurrentBlock, useMyMembership, useResolvedBoard, useUnlock } from '@/hooks/useBoard'
import { RateLimitNotice } from '@/components/RateLimitNotice'

export default function StatsPage() {
  return (
    <Suspense fallback={<div className="muted">Loading…</div>}>
      <StatsInner />
    </Suspense>
  )
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

function ago(s: number): string {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`
  if (s < 86400) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} d`
}

function StatsInner() {
  const params = useSearchParams()
  const slug = params.get('b')
  const board = useResolvedBoard(slug)
  const block = useCurrentBlock()
  const { address } = useAccount()
  const qc = useQueryClient()

  const data = useQuery({
    queryKey: ['stats', board.data?.ref.slug, address ?? ''],
    queryFn: async () => {
      const b = board.data as ResolvedBoard
      const current = block.data ?? undefined
      // Reuse the board index when already loaded; only query Arkiv otherwise.
      const cached = qc.getQueriesData<BoardIndex>({ queryKey: ['index'] }).map(([, d]) => d).find((d) => d?.board.ref.slug === b.ref.slug)
      const [roots, replies] = cached
        ? [[...cached.threads.values()], [...cached.posts.values()]]
        : await Promise.all([loadRoots(arkivStore, b.ref), loadReplies(arkivStore, b.ref)])
      const liveRoots = dropExpired(roots, current)
      const liveReplies = dropExpired(replies, current)
      const clock = { currentBlock: current ?? 0, observedAtUnix: Math.floor(Date.now() / 1000), blockTimeS: 2 }
      const stats = computeBoardStats(liveRoots, liveReplies, clock, { days: 14 })
      const mine = address ? computeMyStats(address, liveRoots, liveReplies, clock) : undefined
      return { stats, mine }
    },
    enabled: !!board.data,
    staleTime: 30_000,
  })

  if (!slug) return <div className="notice">No board given.</div>
  if (board.isLoading) return <div className="muted">Resolving board…</div>
  if (board.isError) return <RateLimitNotice error={board.error} />
  if (!board.data) return <div className="notice"><h1>Unknown board</h1></div>
  const b = board.data

  return (
    <div>
      <div className="nav" style={{ borderBottom: 0 }}>
        [<Link href={`/board?b=${encodeURIComponent(b.ref.slug)}`}>Return</Link>]
        <span className="spacer" />
        <span className="time">write-side facts only; Haven records no reads</span>
      </div>
      <h2 className="subject" style={{ margin: '8px 0 2px', textAlign: 'center' }}>
        /{b.ref.slug}/ – statistics
      </h2>
      {data.isLoading && <div className="muted">Counting…</div>}
      {data.error && <RateLimitNotice error={data.error} />}
      {data.data && (
        <>
          <BoardSection b={b} s={data.data.stats} />
          <hr />
          <YouSection b={b} m={data.data.mine} />
        </>
      )}
    </div>
  )
}

function BoardSection({ b, s }: { b: ResolvedBoard; s: BoardStats }) {
  const max = Math.max(1, ...s.byDay.map((d) => d.threads + d.replies))
  return (
    <div>
      <table className="boards" style={{ margin: '8px auto' }}>
        <tbody>
          <Row k="Gate" v={`≥ ${b.ref.gate.threshold.toString()} of ${b.ref.gate.tokenAddress.slice(0, 10)}… on ${CHAIN_LABEL[b.ref.gate.chain]}`} />
          <Row k="Live threads" v={`${s.threads} (${s.havenRoots} published by other Haven apps) · capacity ${b.capacity}`} />
          <Row k="Live replies" v={`${s.replies} · median ${s.repliesPerThread.median} per thread, max ${s.repliesPerThread.max}, ${s.repliesPerThread.silent} threads with none`} />
          <Row k="Distinct posters" v={String(s.posters)} />
          <Row k="Activity" v={`${s.last24h} posts in 24 h · ${s.last7d} in 7 d`} />
          <Row k="Sealed" v={`${pct(s.sealedTextShare)} of posts have members-only text · ${s.threadsWithMedia ? pct(s.sealedMediaShare) : '—'} of media is members-only`} />
          <Row k="Media" v={s.mediaMix.length ? s.mediaMix.map((m) => `${m.mime} ×${m.count}`).join(', ') : 'none'} />
          <Row k="Expiry" v={`${s.expiringSoon} threads expire within 24 h · oldest live thread ${s.oldestThreadAgeS ? ago(s.oldestThreadAgeS) : '—'} · lifetimes ${Math.round(b.threadTtlS / 86400)} d / ${Math.round(b.postTtlS / 86400)} d`} />
          <Row k="Ordering" v={`bump limit ${b.bumpLimit} · ${b.pageSize} per page`} />
        </tbody>
      </table>
      <div style={{ margin: '8px auto', maxWidth: 560 }}>
        <div className="muted" style={{ fontSize: 11 }}>Posts per day, last 14 days (threads dark, replies light)</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 60, borderBottom: '1px solid var(--border)' }}>
          {s.byDay.map((d) => {
            const h = (d.threads + d.replies) / max
            const th = d.threads / max
            return (
              <div key={d.day} title={`${d.day}: ${d.threads} threads, ${d.replies} replies`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
                <div style={{ height: `${Math.round((h - th) * 100)}%`, background: 'var(--bar)', borderTop: '1px solid var(--border)' }} />
                <div style={{ height: `${Math.round(th * 100)}%`, background: 'var(--subject)' }} />
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }} className="time">
          <span>{s.byDay[0]?.day.slice(5)}</span>
          <span>{s.byDay.at(-1)?.day.slice(5)}</span>
        </div>
      </div>
    </div>
  )
}

function YouSection({ b, m }: { b: ResolvedBoard; m: MyStats | undefined }) {
  const me = useMyMembership(b.ref.gate)
  const { unlocked, epoch } = useUnlock(b.ref.gate)
  if (!m) return <div className="muted" style={{ textAlign: 'center' }}>Connect a wallet to see your own numbers. Nobody else's are shown; the board ranks threads, not people.</div>
  return (
    <table className="boards" style={{ margin: '8px auto' }}>
      <tbody>
        <Row k="You" v={`${m.address.slice(0, 6)}…${m.address.slice(-4)}`} />
        <Row k="Membership" v={me.data ? `${me.data.member ? 'member' : 'not a member'} · balance ${me.data.balance.toString()}` : '…'} />
        <Row k="Unlock" v={unlocked ? `epoch ${epoch} unlocked until ${new Date(epochEndUnix(epoch) * 1000).toLocaleDateString()}` : `epoch ${currentEpoch()} not unlocked on this device`} />
        <Row k="Your posts" v={`${m.threads} threads · ${m.replies} replies (${m.noBumpReplies} no-bump) · ${pct(m.sealedTextShare)} sealed`} />
        <Row k="Replies received" v={`${m.repliesReceived} from others, across ${m.threadsWithOthersReplies} of your threads`} />
        <Row k="First / last post" v={m.firstPostUnix ? `${new Date(m.firstPostUnix * 1000).toLocaleString()} / ${new Date((m.lastPostUnix ?? m.firstPostUnix) * 1000).toLocaleString()}` : '—'} />
      </tbody>
    </table>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <th style={{ whiteSpace: 'nowrap' }}>{k}</th>
      <td>{v}</td>
    </tr>
  )
}
