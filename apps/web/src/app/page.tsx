'use client'

import { Suspense, useMemo } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { backlinks, blockToUnix, gateKey, gateSpecOf, type IndexPageItem, type ResolvedBoard } from '@fairhaven/board-core'
import { useGlobalFeed } from '@/hooks/useBoard'
import { RateLimitNotice } from '@/components/RateLimitNotice'
import { useHidden } from '@/hooks/useHidden'
import { OpView, ReplyView, type PostContext } from '@/components/Post'
import { Lock } from '@/components/Icons'
import { useShallow } from 'zustand/react/shallow'
import { useSession } from '@/store/session'
import { pendingProgressLabel } from '@/lib/post'

/**
 * The front page: every thread on the network in one bump order, across all
 * gates. Each thread is open or frosted according to what the viewer holds.
 * Posting happens on a board; this page only reads.
 */
export default function FrontPage() {
  return (
    <Suspense fallback={<div className="muted">Loading…</div>}>
      <FeedInner />
    </Suspense>
  )
}

function FeedInner() {
  const params = useSearchParams()
  const router = useRouter()
  const qc = useQueryClient()
  const page = Math.max(1, Number(params.get('p') ?? '1') || 1)
  const { index, page: pg, currentBlock, boards, loadMore } = useGlobalFeed(page)
  const visible = useMemo(() => pg.data?.items.flatMap((i) => [i.thread, ...i.tail]) ?? [], [pg.data])
  const { hidden, showStubs } = useHidden(visible)
  const pending = useSession(useShallow((s) => s.pending.filter((p) => !p.root && !p.key && !p.error)))

  const observed = Math.floor(Date.now() / 1000)
  const blockToDate = (block: number) => (currentBlock !== undefined ? new Date(blockToUnix(block, { currentBlock, observedAtUnix: observed }) * 1000) : undefined)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['global'] })
    qc.invalidateQueries({ queryKey: ['block'] })
  }
  const href = (p: number) => `/?p=${p}`

  return (
    <div>
      <h1 className="subject" style={{ margin: '8px 0 2px', textAlign: 'center' }}>
        Fairhaven
      </h1>
      <div className="muted" style={{ textAlign: 'center', marginBottom: 6 }}>
        Every board at once. Hold a gate token to open its threads; <Link href="/boards">boards</Link> · <Link href="/new">new board</Link>
      </div>
      <hr />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="pager">
          {page > 1 ? <Link href={href(page - 1)}>Previous</Link> : <span className="muted">Previous</span>}
          {Array.from({ length: pg.data?.pages ?? 1 }, (_, i) => i + 1).map((p) => (p === (pg.data?.page ?? page) ? <b key={p}>[{p}]</b> : <Link key={p} href={href(p)}>[{p}]</Link>))}
          {page < (pg.data?.pages ?? 1) ? <Link href={href(page + 1)}>Next</Link> : <span className="muted">Next</span>}
        </div>
        <a href="#" onClick={(e) => (e.preventDefault(), refresh())}>
          [Refresh]
        </a>
        {pg.data && (
          <span className="muted">
            {pg.data.total} threads across {boards.size} {boards.size === 1 ? 'gate' : 'gates'}
          </span>
        )}
      </div>
      <hr />
      {pending.map((p) => (
        <div key={p.tempId} className="thread">
          <div className="op reply pending" style={{ display: 'block', margin: 0 }}>
            <div className="meta">
              <span className="subject">{p.subject}</span> <span className="time">{pendingProgressLabel(p.stage)}</span>
            </div>
            <div className="body">{p.sealedText ? <><Lock /> (sealed)</> : p.text}</div>
          </div>
        </div>
      ))}
      {pg.isLoading && <div className="muted">Loading the network…</div>}
      {(index.error || pg.error) && <RateLimitNotice error={index.error ?? pg.error} />}
      {pg.data?.truncated && <div className="notice">Showing the most recent scan window. <button onClick={() => void loadMore()}>Load older threads</button></div>}
      {pg.data && pg.data.items.length === 0 && <div className="notice">Nothing on the network yet. <Link href="/new">Define a board</Link> and post the first thread.</div>}
      {pg.data?.items.map((it) => (
        <FeedThread key={it.thread.key} item={it} board={boards.get(gateKey(it.thread.gate))} hidden={hidden} showStubs={showStubs} blockToDate={blockToDate} onReplyTo={(slug, k) => router.push(`/thread?b=${encodeURIComponent(slug)}&k=${k}`)} onDeleted={refresh} />
      ))}
    </div>
  )
}

function FeedThread({
  item,
  board,
  hidden,
  showStubs,
  blockToDate,
  onReplyTo,
  onDeleted,
}: {
  item: IndexPageItem
  board: ResolvedBoard | undefined
  hidden: PostContext['hidden']
  showStubs: boolean
  blockToDate: (b: number) => Date | undefined
  onReplyTo: (slug: string, key: string) => void
  onDeleted: () => void
}) {
  const slug = board?.ref.slug ?? item.thread.board
  // Def-less boards get an implicit slug that cannot be resolved alone; link by gate spec instead.
  const bParam = board && !board.def ? gateSpecOf(board.ref.gate) : slug
  const keys = useMemo(() => [item.thread.key, ...item.tail.map((t) => t.key)], [item])
  const bl = useMemo(() => backlinks(item.tail.map((t) => ({ key: t.key, ...(t.parentRef ? { parentRef: t.parentRef } : {}), ...(t.payload && 'clear' in t.payload.text ? { text: t.payload.text.clear } : {}) }))), [item])
  const ctx: PostContext = { board: bParam, gate: item.thread.gate, knownKeys: keys, backlinks: bl, blockToDate, hidden, showStubs, onReplyTo: (k) => onReplyTo(bParam, k), onDeleted }
  return (
    <div className="thread">
      <div className="muted" style={{ fontSize: 12 }}>
        <Link href={`/board?b=${encodeURIComponent(bParam)}`}>/{slug}/</Link>
        {board?.title && board.title !== slug ? ` · ${board.title}` : ''}
      </div>
      <OpView thread={item.thread} ctx={ctx} onIndex />
      {item.omitted > 0 && (
        <div className="omitted">
          {item.omitted} {item.omitted === 1 ? 'reply' : 'replies'} omitted. <Link href={`/thread?b=${encodeURIComponent(slug)}&k=${item.thread.key}`}>Click here</Link> to view.
        </div>
      )}
      {item.tail.map((t) => (
        <div key={t.key}>
          <ReplyView post={t} ctx={ctx} />
        </div>
      ))}
      <hr />
    </div>
  )
}
