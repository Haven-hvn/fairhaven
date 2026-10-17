'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { backlinks, blockToUnix, shortAddress } from '@fairhaven/board-core'
import { useResolvedBoard, useThread, useCurrentBlock } from '@/hooks/useBoard'
import { useHidden } from '@/hooks/useHidden'
import { GateCard } from '@/components/GateCard'
import { PostForm } from '@/components/PostForm'
import { OpView, ReplyView, type PostContext } from '@/components/Post'
import { useShallow } from 'zustand/react/shallow'
import { useSession } from '@/store/session'
import type { QuoteTarget } from '@/components/Body'
import { ShareLink, threadPath } from '@/components/ShareLink'
import { RateLimitNotice } from '@/components/RateLimitNotice'

export default function ThreadPage() {
  return (
    <Suspense fallback={<div className="muted">Loading…</div>}>
      <ThreadInner />
    </Suspense>
  )
}

function ThreadInner() {
  const params = useSearchParams()
  const router = useRouter()
  const qc = useQueryClient()
  const slug = params.get('b')
  const key = params.get('k')
  const board = useResolvedBoard(slug)
  const thread = useThread(board.data, key)
  const block = useCurrentBlock()
  const [quote, setQuote] = useState<string | null>(null)
  const pending = useSession(useShallow((s) => s.pending.filter((p) => p.root === key?.toLowerCase() && !p.key && !p.error)))
  const { hidden, showStubs } = useHidden(thread.data && !thread.data.rootHidden ? [thread.data.root, ...thread.data.replies] : undefined)

  if (!slug || !key) return <div className="notice">No thread given.</div>
  if (board.isError) return <RateLimitNotice error={board.error} />
  if (thread.isError) return <RateLimitNotice error={thread.error} />
  if (board.isLoading || thread.isLoading) return <div className="muted">Loading thread…</div>
  if (!board.data) return <div className="notice"><h1>Unknown board</h1></div>
  if (thread.data === null || (thread.data && thread.data.rootHidden)) {
    router.replace('/expired')
    return null
  }
  if (!thread.data) return null
  const b = board.data
  const t = thread.data

  const observed = Math.floor(Date.now() / 1000)
  const currentBlock = block.data ?? undefined
  const blockToDate = (bk: number) => (currentBlock !== undefined ? new Date(blockToUnix(bk, { currentBlock, observedAtUnix: observed }) * 1000) : undefined)
  const keys = [t.root.key, ...t.replies.map((r) => r.key)]
  const bl = backlinks([{ key: t.root.key }, ...t.replies.map((r) => ({ key: r.key, ...(r.parentRef ? { parentRef: r.parentRef } : {}), ...(r.payload && 'clear' in r.payload.text ? { text: r.payload.text.clear } : {}) }))])
  const previewFor = (k: string): QuoteTarget | undefined => {
    if (k === t.root.key) return { key: k, owner: shortAddress(t.root.owner), preview: t.root.payload && 'clear' in t.root.payload.text ? t.root.payload.text.clear.slice(0, 200) : `${t.root.subject} · (sealed)` }
    const r = t.replies.find((x) => x.key === k)
    if (!r) return undefined
    return { key: k, owner: shortAddress(r.owner), preview: r.payload && 'clear' in r.payload.text ? r.payload.text.clear.slice(0, 200) : '(sealed)' }
  }
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['thread'] })
    qc.invalidateQueries({ queryKey: ['block'] })
  }
  const ctx: PostContext = { board: b.ref.slug, gate: b.ref.gate, knownKeys: keys, backlinks: bl, previewFor, blockToDate, hidden, showStubs, onReplyTo: (k) => setQuote(k), onDeleted: () => (t.root ? router.push(`/board?b=${encodeURIComponent(b.ref.slug)}`) : refresh()) }

  const expiresIn = t.root.expiresAt !== undefined && currentBlock !== undefined ? Math.max(0, (t.root.expiresAt - currentBlock) * 2) : undefined

  return (
    <div>
      <div className="nav" style={{ borderBottom: 0 }}>
        [<Link href={`/board?b=${encodeURIComponent(b.ref.slug)}`}>Return</Link>] [<Link href={`/board?b=${encodeURIComponent(b.ref.slug)}&view=catalog`}>Catalog</Link>] [
        <a href="#" onClick={(e) => (e.preventDefault(), refresh())}>
          Refresh
        </a>
        ] <ShareLink path={threadPath(b.ref.slug, t.root.key)} title={t.root.subject} label="Share thread" />
        <span className="spacer" />
        {expiresIn !== undefined && <span className="time">expires in {expiresIn > 86400 ? `${Math.round(expiresIn / 86400)} d` : expiresIn > 3600 ? `${Math.round(expiresIn / 3600)} h` : `${Math.round(expiresIn / 60)} min`}</span>}
      </div>
      <GateCard board={b} />
      <hr />
      <div className="thread">
        <OpView thread={t.root} ctx={ctx} />
        {t.replies.map((r) => (
          <div key={r.key}>
            <ReplyView post={r} ctx={ctx} />
          </div>
        ))}
        {pending.map((p) => (
          <div key={p.tempId}>
            <div className="reply pending">
              <div className="meta">
                <span className="name">you</span> <span className="time">confirming on Arkiv…</span>
              </div>
              <div className="body">{p.sealedText ? '🔒 (sealed)' : p.text}</div>
            </div>
          </div>
        ))}
      </div>
      <hr />
      <PostForm board={b} root={t.root} {...(currentBlock !== undefined ? { currentBlock } : {})} quote={quote} onQuoteConsumed={() => setQuote(null)} onPosted={refresh} />
      <div className="muted" style={{ textAlign: 'center', marginTop: 12 }}>
        {t.replies.length} {t.replies.length === 1 ? 'reply' : 'replies'} · root {t.root.source === 'haven' ? `published by another Haven app (${t.root.grp})` : 'posted here'}
      </div>
    </div>
  )
}
