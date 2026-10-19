'use client'

import Link from 'next/link'
import { useAccount, useWalletClient } from 'wagmi'
import { useState } from 'react'
import { attestationLabel, describeAttestation, shortAddress, shortKey, type BoardGate, type HiddenReason, type PostRecord, type ThreadRecord } from '@fairhaven/board-core'
import { useOpenText } from '@/hooks/useBoard'
import { Body, type QuoteTarget } from './Body'
import { FrostText } from './Frost'
import { MediaView } from './MediaView'
import { HiddenStub, HideMenu } from './HideMenu'
import { ShareLink, threadPath } from './ShareLink'
import { deletePost } from '@/lib/post'

export interface PostContext {
  board: string
  gate: BoardGate
  knownKeys: Iterable<string>
  previewFor?: (key: string) => QuoteTarget | undefined
  backlinks?: Map<string, string[]>
  blockToDate?: (block: number) => Date | undefined
  onReplyTo?: (key: string) => void
  onDeleted?: () => void
  /** Personal-filter verdicts for the records in view. */
  hidden?: Map<string, HiddenReason>
  showStubs?: boolean
}

/** Returns a stub, nothing, or null (= render normally) for a filtered record. */
function useHiddenGate(key: string, owner: string, ctx: PostContext) {
  const [revealed, setRevealed] = useState(false)
  const reason = ctx.hidden?.get(key)
  if (!reason || revealed) return null
  return ctx.showStubs === false ? <></> : <HiddenStub reason={reason} owner={owner} onShow={() => setRevealed(true)} />
}

function Time({ block, ctx }: { block: number; ctx: PostContext }) {
  const d = ctx.blockToDate?.(block)
  return <span className="time" title={`block ${block}`}>{d ? d.toLocaleString() : `block ${block}`}</span>
}

function useDelete(ctx: PostContext) {
  const { data: wc } = useWalletClient()
  const [busy, setBusy] = useState(false)
  return {
    busy,
    canDelete: !!wc,
    run: async (key: string) => {
      if (!wc || busy) return
      if (!confirm('Delete this post? Only you can; it is removed from the index for everyone.')) return
      setBusy(true)
      try {
        await deletePost(wc as never, key)
        ctx.onDeleted?.()
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
  }
}

/** Attestation state badge: shared wording from board-core, shown once a record has been checked. */
export function AttnBadge({ rec }: { rec: ThreadRecord | PostRecord }) {
  const state = rec.payload?.attn !== undefined ? 'verified' as const : 'missing' as const
  return <span className="muted" title={describeAttestation(state)}>· {attestationLabel(state)}</span>
}

export function OpView({ thread, ctx, onIndex }: { thread: ThreadRecord; ctx: PostContext; onIndex?: boolean }) {
  const { address } = useAccount()
  const you = !!address && address.toLowerCase() === thread.owner
  const open = useOpenText(thread, ctx.gate)
  const del = useDelete(ctx)
  const stub = useHiddenGate(thread.key, thread.owner, ctx)
  const media = thread.payload?.media
  const sealedLen = thread.payload && 'sealed' in thread.payload.text ? Math.floor((thread.payload.text.sealed.length * 3) / 4) : 0
  const bl = ctx.backlinks?.get(thread.key) ?? []
  if (stub !== null) return <div className="op" id={`p${shortKey(thread.key)}`}>{stub}</div>

  return (
    <div className={`op${you ? ' you' : ''}`} id={`p${shortKey(thread.key)}`}>
      {media && <MediaView thread={thread} media={media} />}
      <div className="meta">
        <span className="subject">{thread.subject}</span> <span className="name" title={thread.owner}>{shortAddress(thread.owner)}</span>
        {you && <span className="you-tag"> (you)</span>} <AttnBadge rec={thread} />{' '}
        {thread.source === 'haven' && (
          <span className="muted" title={thread.grp}>
            via {thread.grp.split('.')[1]}{' '}
          </span>
        )}
        <Time block={thread.createdAt} ctx={ctx} /> <span className="postid">
          No.<a href={`#p${shortKey(thread.key)}`} onClick={(e) => (e.preventDefault(), ctx.onReplyTo?.(thread.key))} title="Quote this post">{shortKey(thread.key)}</a>
        </span>{' '}
        {onIndex && (
          <span>
            [<Link href={`/thread?b=${encodeURIComponent(ctx.board)}&k=${thread.key}`} className="reply-link">Reply</Link>]
          </span>
        )}{' '}
        <ShareLink path={threadPath(ctx.board, thread.key)} title={thread.subject} />
        <HideMenu owner={thread.owner} boardGate={ctx.gate} />
        {you && del.canDelete && (
          <span>
            {' '}
            [<a href="#" onClick={(e) => (e.preventDefault(), del.run(thread.key))}>{del.busy ? 'deleting…' : 'Delete'}</a>]
          </span>
        )}
        {bl.length > 0 && (
          <span className="backlinks">
            {' '}
            {bl.map((k) => (
              <a key={k} href={`#p${shortKey(k)}`}>{`>>${shortKey(k)}`}</a>
            ))}
          </span>
        )}
      </div>
      {thread.payload ? (
        open.state === 'clear' || open.state === 'open' ? (
          open.text ? <Body text={open.text} knownKeys={ctx.knownKeys} previewFor={ctx.previewFor} /> : null
        ) : (
          <FrostText sealedBytes={sealedLen} state={open.state} gate={ctx.gate} {...(((open as { reason?: string }).reason) ? { reason: (open as { reason?: string }).reason } : {})} />        )
      ) : thread.sealed & 1 ? (
        <FrostText sealedBytes={256} state="locked" gate={ctx.gate} />
      ) : null}
    </div>
  )
}

export function ReplyView({ post, ctx, pending }: { post: PostRecord; ctx: PostContext; pending?: boolean }) {
  const { address } = useAccount()
  const you = !!address && address.toLowerCase() === post.owner
  const open = useOpenText(post, ctx.gate)
  const del = useDelete(ctx)
  const stub = useHiddenGate(post.key, post.owner, ctx)
  const sealedLen = post.payload && 'sealed' in post.payload.text ? Math.floor((post.payload.text.sealed.length * 3) / 4) : 0
  const bl = ctx.backlinks?.get(post.key) ?? []
  if (stub !== null) return <div id={`p${shortKey(post.key)}`}>{stub}</div>
  return (
    <div className={`reply${you ? ' you' : ''}${pending ? ' pending' : ''}`} id={`p${shortKey(post.key)}`}>
      <div className="meta">
        <span className="name" title={post.owner}>{shortAddress(post.owner)}</span>
        {you && <span className="you-tag"> (you)</span>} {!pending && <AttnBadge rec={post} />} {pending ? <span className="time">confirming…</span> : <Time block={post.createdAt} ctx={ctx} />}{' '}
        <span className="postid">
          No.<a href={`#p${shortKey(post.key)}`} onClick={(e) => (e.preventDefault(), ctx.onReplyTo?.(post.key))} title="Quote this post">{shortKey(post.key)}</a>
        </span>
        {post.noBump && <span className="time"> · no bump</span>}{' '}
        {!pending && <ShareLink path={threadPath(ctx.board, post.rootRef, post.key)} title={`Post ${shortKey(post.key)}`} label="Link" />}
        {!pending && <HideMenu owner={post.owner} boardGate={ctx.gate} />}
        {you && !pending && del.canDelete && (
          <span>
            {' '}
            [<a href="#" onClick={(e) => (e.preventDefault(), del.run(post.key))}>{del.busy ? 'deleting…' : 'Delete'}</a>]
          </span>
        )}
        {bl.length > 0 && (
          <span className="backlinks">
            {' '}
            {bl.map((k) => (
              <a key={k} href={`#p${shortKey(k)}`}>{`>>${shortKey(k)}`}</a>
            ))}
          </span>
        )}
      </div>
      {open.state === 'clear' || open.state === 'open' ? (
        <Body text={open.text} knownKeys={ctx.knownKeys} previewFor={ctx.previewFor} />
      ) : post.payload ? (
        <FrostText sealedBytes={sealedLen} state={open.state} gate={ctx.gate} {...(((open as { reason?: string }).reason) ? { reason: (open as { reason?: string }).reason } : {})} />      ) : (
        <FrostText sealedBytes={256} state="locked" gate={ctx.gate} />
      )}
    </div>
  )
}
