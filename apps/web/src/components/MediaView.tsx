'use client'

import { useEffect, useState } from 'react'
import { ENUM_TO_MIME, type MediaField, type ThreadRecord } from '@fairhaven/board-core'
import { blurhashDataUrl, formatBytes, mimeKind, mimeLabel } from '@/lib/media'
import { parseGateJson } from '@/lib/aol'
import { env } from '@/lib/env'
import { useSession } from '@/store/session'
import { FrostCaptionLine, useFrostAction } from './FrostCaption'
import { Lock } from './Icons'
import { ComicReader } from './ComicReader'
import { getOpened } from '@/lib/open-cache'
import { canOpenNow, inFlight, openNow, type Phase } from '@/lib/prefetch'
import { usePrefetchMedia } from '@/hooks/usePrefetch'

/**
 * Media on a thread.
 *
 * Holder who can open it:   prefetched + pre-opened in the background (see
 *                           lib/prefetch). Renders a real thumbnail / ready
 *                           player straight away; one click expands.
 * Holder, not yet opened:   click fetches + opens with a text progress line:
 *                             fetching · 3.5 of 8.4 MB · cancel
 *                             opening · 4 of 9 · cancel
 * Not entitled:             frosted tile with a caption saying what to do.
 *
 * Numbers are exact; nothing is invented; the only motion is frost shimmer.
 */
type State = { s: 'idle' } | { s: 'busy'; phase: Phase } | { s: 'open'; url: string; bytes: Uint8Array } | { s: 'error'; msg: string }

export function MediaView({ thread, media, compact }: { thread: ThreadRecord; media: MediaField; compact?: boolean }) {
  const version = useSession((s) => s.unlockVersion)
  const locator = media.piece ?? media.fcid ?? ''
  const sealed = media.piece !== undefined
  const kind = mimeKind(media.mime)
  const gate = thread.payload?.gate ? parseGateJson(thread.payload.gate) : undefined
  const foreign = sealed && gate && gate.version !== 3
  const entitled = canOpenNow(thread, media)
  const { ref, onMouseEnter, onMouseLeave } = usePrefetchMedia(thread, media)

  const cached = getOpened(locator)
  const [st, setSt] = useState<State>(() => (cached ? { s: 'open', url: cached.url, bytes: cached.bytes } : { s: 'idle' }))
  const [expanded, setExpanded] = useState(false)
  const [cancel, setCancel] = useState<(() => void) | null>(null)

  // Pick up background prefetch results and in-flight prefetches as they land.
  useEffect(() => {
    if (st.s === 'open') return
    const c = getOpened(locator)
    if (c) {
      setSt({ s: 'open', url: c.url, bytes: c.bytes })
      return
    }
    const live = inFlight(media)
    if (live && st.s === 'idle') attach()
    const id = setInterval(() => {
      const c2 = getOpened(locator)
      if (c2) setSt({ s: 'open', url: c2.url, bytes: c2.bytes })
    }, 800)
    return () => clearInterval(id)
  }, [locator, version, st.s])

  const attach = () => {
    const task = openNow(thread, media)
    setSt({ s: 'busy', phase: task.phase })
    const off = task.subscribe((p) => setSt({ s: 'busy', phase: p }))
    setCancel(() => () => task.cancel())
    task.promise
      .then((bytes) => {
        const c = getOpened(locator)
        setSt({ s: 'open', url: c?.url ?? URL.createObjectURL(new Blob([bytes as BlobPart])), bytes })
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') setSt({ s: 'idle' })
        else setSt({ s: 'error', msg: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => {
        off()
        setCancel(null)
      })
  }

  const open = () => {
    if (st.s === 'open') {
      setExpanded((e) => !e)
      return
    }
    if (!entitled || st.s === 'busy') return
    attach()
  }

  const label = [mimeLabel(media.mime), media.size ? formatBytes(media.size) : '', media.name ?? ''].filter(Boolean).join(' · ')
  const hint = media.hint ? blurhashDataUrl(media.hint) : undefined
  const busy = st.s === 'busy'
  const frostState = foreign ? 'foreign' : st.s === 'error' ? 'failed' : busy ? 'unlocking' : 'locked'
  const action = useFrostAction(thread.gate, frostState, foreign ? `v${gate?.version}` : st.s === 'error' ? st.msg : undefined, `${env.havenDappUrl}/watch?v=${encodeURIComponent(thread.key)}`)
  const locked = !entitled && !foreign

  const progress =
    st.s === 'busy' && st.phase.s === 'fetching' ? (
      <span>
        {' '}
        · fetching · {st.phase.total ? `${formatBytes(st.phase.received)} of ${formatBytes(st.phase.total)}` : formatBytes(st.phase.received)}
        {cancel && (
          <>
            {' '}
            ·{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), cancel())}>
              cancel
            </a>
          </>
        )}
      </span>
    ) : st.s === 'busy' && st.phase.s === 'opening' ? (
      <span>
        {' '}
        · opening · {st.phase.chunk} of {st.phase.chunks}
        {cancel && (
          <>
            {' '}
            ·{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), cancel())}>
              cancel
            </a>
          </>
        )}
      </span>
    ) : st.s === 'error' ? (
      <span className="error">
        {' '}
        · {st.msg} ·{' '}
        <a href="#" onClick={(e) => (e.preventDefault(), attach())}>
          retry
        </a>
      </span>
    ) : null

  // ── Opened: inline preview (thumbnail / ready player), click to expand ──
  if (st.s === 'open') {
    if (expanded) {
      if (kind === 'comic') {
        return (
          <div className="media-open" ref={ref}>
            <div className="file-info">
              {label} · <a href={st.url} download={media.name ?? 'comic.cbz'}>download</a>
            </div>
            <ComicReader bytes={st.bytes} threadKey={thread.key} {...(media.name ? { name: media.name } : {})} onClose={() => setExpanded(false)} />
          </div>
        )
      }
      return (
        <div className="media-open" ref={ref}>
          <div className="file-info">
            {label} ·{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), setExpanded(false))}>
              close
            </a>{' '}
            · <a href={st.url} download={media.name ?? 'file'}>download</a>
          </div>
          {kind === 'image' && <img src={st.url} alt={media.name ?? ''} onClick={() => setExpanded(false)} />}
          {kind === 'video' && <video src={st.url} controls autoPlay preload="auto" />}
          {kind === 'audio' && <audio src={st.url} controls autoPlay />}
          {kind === 'pdf' && <iframe src={st.url} title={media.name ?? 'pdf'} />}
          {kind === 'text' && <pre>{new TextDecoder().decode(st.bytes)}</pre>}
          {kind === 'comic-rar' && (
            <div className="muted">
              CBR (RAR) archives are not read in the browser. <a href={st.url} download={media.name ?? 'comic.cbr'}>Download</a> and convert to CBZ to read inline.
            </div>
          )}
          {kind === 'file' && <a href={st.url} download={media.name ?? 'file'}>Download {media.name ?? 'file'}</a>}
        </div>
      )
    }
    // Collapsed but ready: the real thing, small. No extra click to load anything.
    return (
      <div ref={ref}>
        <div className="file-info">
          File: {label} ·{' '}
          <a href="#" onClick={(e) => (e.preventDefault(), setExpanded(true))}>
            {kind === 'image' ? 'expand' : kind === 'video' || kind === 'audio' ? 'fullsize' : 'open'}
          </a>{' '}
          · <a href={st.url} download={media.name ?? 'file'}>download</a>
        </div>
        <div className={compact ? undefined : 'file'}>
          {kind === 'image' && <img className="thumb" src={st.url} alt={media.name ?? ''} onClick={() => setExpanded(true)} />}
          {kind === 'video' && <video className="thumb" src={st.url} controls preload="metadata" />}
          {kind === 'audio' && <audio src={st.url} controls preload="metadata" />}
          {(kind === 'pdf' || kind === 'text' || kind === 'comic' || kind === 'comic-rar' || kind === 'file') && (
            <div className="tile ready" onClick={() => setExpanded(true)} role="button" title="Open">
              {hint ? <img src={hint} alt="" style={{ filter: 'none', transform: 'none' }} /> : <span>{mimeLabel(media.mime) || 'file'} · ready</span>}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Not opened yet: tile (frosted if not entitled) ─────────────────────
  const tile = (
    <div
      className={`tile${locked || busy ? ' frost' : ''}${busy ? ' shimmer' : ''}`}
      onClick={locked ? action.run : busy ? undefined : open}
      style={{ cursor: busy ? 'default' : 'pointer' }}
      title={locked ? action.label : busy ? 'Loading' : 'Open'}
      role="button"
    >
      {hint ? <img src={hint} alt="" /> : <span>{mimeLabel(media.mime) || 'file'}</span>}
      {locked && <span className="lock"><Lock /></span>}
      {foreign && <span className="lock">↗</span>}
    </div>
  )

  return (
    <div ref={ref} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="file-info">
        File: {label}
        {progress}
      </div>
      <div className={compact ? undefined : 'file'}>
        {tile}
        {(locked || foreign) && <FrostCaptionLine action={action} />}
      </div>
      {ENUM_TO_MIME[media.mime] === undefined && media.mime !== 0 && <div className="file-info">unknown type {media.mime}</div>}
    </div>
  )
}
