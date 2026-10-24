'use client'

import { Suspense, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { backlinks, blockToUnix, type IndexPageItem } from '@fairhaven/board-core'
import { useIndex, useResolvedBoard } from '@/hooks/useBoard'
import { useHidden } from '@/hooks/useHidden'
import { GateCard } from '@/components/GateCard'
import { PostForm } from '@/components/PostForm'
import { Pager } from '@/components/Pager'
import { OpView, ReplyView, type PostContext } from '@/components/Post'
import { useShallow } from 'zustand/react/shallow'
import { useSession } from '@/store/session'
import { pendingProgressLabel } from '@/lib/post'
import { blurhashDataUrl, mimeLabel } from '@/lib/media'
import { ShareLink } from '@/components/ShareLink'
import { RateLimitNotice } from '@/components/RateLimitNotice'
import { Lock } from '@/components/Icons'

export default function BoardPage() {
  return (
    <Suspense fallback={<div className="muted">Loading…</div>}>
      <BoardInner />
    </Suspense>
  )
}

function BoardInner() {
  const params = useSearchParams()
  const router = useRouter()
  const qc = useQueryClient()
  const slug = params.get('b')
  const page = Math.max(1, Number(params.get('p') ?? '1') || 1)
  const view = params.get('view') === 'catalog' ? 'catalog' : 'index'
  const board = useResolvedBoard(slug)
  const { index, page: pg, currentBlock, loadMore } = useIndex(board.data, page)
  const pending = useSession(useShallow((s) => s.pending.filter((p) => p.board === board.data?.ref.slug && !p.root && !p.key && !p.error)))
  const [quote, setQuote] = useState<string | null>(null)
  const visible = useMemo(() => pg.data?.items.flatMap((i) => [i.thread, ...i.tail]) ?? [], [pg.data])
  const { hidden, showStubs } = useHidden(visible)

  if (!slug) return <div className="notice">No board given.</div>
  if (board.isLoading) return <div className="muted">Resolving board…</div>
  if (board.isError) return <RateLimitNotice error={board.error} />
  if (!board.data) return <div className="notice"><h1>Unknown board</h1>Try a slug from the <Link href="/boards">board list</Link> or a gate: spec.</div>
  const b = board.data

  const observed = Math.floor(Date.now() / 1000)
  const blockToDate = (block: number) => (currentBlock !== undefined ? new Date(blockToUnix(block, { currentBlock, observedAtUnix: observed }) * 1000) : undefined)

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['index'] })
    qc.invalidateQueries({ queryKey: ['index-page'] })
    qc.invalidateQueries({ queryKey: ['block'] })
  }

  return (
    <div>
      <h1 className="subject" style={{ margin: '8px 0 2px', textAlign: 'center' }}>
        /{b.ref.slug}/ – {b.title} <ShareLink path={`/board?b=${encodeURIComponent(b.ref.slug)}`} title={b.title} label="share" />
      </h1>
      {b.def?.about && <div className="muted" style={{ textAlign: 'center' }}>{b.def.about}</div>}
      <GateCard board={b} />
      <PostForm board={b} {...(currentBlock !== undefined ? { currentBlock } : {})} quote={quote} onQuoteConsumed={() => setQuote(null)} onPosted={refresh} />
      <hr />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Pager board={slug} page={pg.data?.page ?? page} pages={pg.data?.pages ?? 1} view={view} />
        <a href="#" onClick={(e) => (e.preventDefault(), refresh())}>
          [Refresh]
        </a>
        <Link href={`/stats?b=${encodeURIComponent(b.ref.slug)}`}>[Stats]</Link>
        {pg.data && <span className="muted">{pg.data.total} threads</span>}
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
      {pg.isLoading && <div className="muted">Loading index…</div>}
      {(index.error || pg.error) && <RateLimitNotice error={index.error ?? pg.error} />}
      {pg.data?.truncated && <div className="notice">Showing the most recent scan window. <button onClick={() => void loadMore()}>Load older threads</button></div>}
      {pg.data && pg.data.items.length === 0 && pending.length === 0 && <div className="notice">Nothing here yet.</div>}
      {pg.data && view === 'index' && <IndexList items={pg.data.items} board={slug} ctx={{ board: slug, gate: b.ref.gate, knownKeys: [], blockToDate, hidden, showStubs, onReplyTo: (k) => router.push(`/thread?b=${encodeURIComponent(b.ref.slug)}&k=${k}`), onDeleted: refresh }} />}
      {pg.data && view === 'catalog' && <Catalog items={pg.data.items.filter((i) => !hidden.has(i.thread.key))} board={slug} />}
      <hr />
      <Pager board={slug} page={pg.data?.page ?? page} pages={pg.data?.pages ?? 1} view={view} />
    </div>
  )
}

function IndexList({ items, board, ctx }: { items: IndexPageItem[]; board: string; ctx: PostContext }) {
  return (
    <>
      {items.map((it) => (
        <IndexThread key={it.thread.key} item={it} board={board} ctx={ctx} />
      ))}
    </>
  )
}

function IndexThread({ item, board, ctx }: { item: IndexPageItem; board: string; ctx: PostContext }) {
  const keys = useMemo(() => [item.thread.key, ...item.tail.map((t) => t.key)], [item])
  const bl = useMemo(() => backlinks(item.tail.map((t) => ({ key: t.key, ...(t.parentRef ? { parentRef: t.parentRef } : {}), ...(t.payload && 'clear' in t.payload.text ? { text: t.payload.text.clear } : {}) }))), [item])
  const local: PostContext = { ...ctx, knownKeys: keys, backlinks: bl }
  return (
    <div className="thread">
      <OpView thread={item.thread} ctx={local} onIndex />
      {item.omitted > 0 && (
        <div className="omitted">
          {item.omitted} {item.omitted === 1 ? 'reply' : 'replies'} omitted. <Link href={`/thread?b=${encodeURIComponent(board)}&k=${item.thread.key}`}>Click here</Link> to view.
        </div>
      )}
      {item.tail.map((t) => (
        <div key={t.key}>
          <ReplyView post={t} ctx={local} />
        </div>
      ))}
      <hr />
    </div>
  )
}

function Catalog({ items, board }: { items: IndexPageItem[]; board: string }) {
  return (
    <div className="catalog">
      {items.map((it) => {
        const m = it.thread.payload?.media
        const hint = m?.hint ? blurhashDataUrl(m.hint, 48, 48) : undefined
        return (
          <Link key={it.thread.key} className="card" href={`/thread?b=${encodeURIComponent(board)}&k=${it.thread.key}`} style={{ textDecoration: 'none' }}>
            {m ? (
              <div className={`tile${m.piece !== undefined ? ' frost' : ''}`}>{hint ? <img src={hint} alt="" /> : <span>{mimeLabel(m.mime) || 'file'}</span>}</div>
            ) : (
              <div className={`tile${it.thread.sealed & 1 ? ' frost' : ''}`}>
                <span>{it.thread.sealed & 1 ? <Lock /> : 'text'}</span>
              </div>
            )}
            <span className="muted">R: {it.folded.replyCount}</span>
            <span className="subject">{it.thread.subject}</span>
          </Link>
        )
      })}
    </div>
  )
}
