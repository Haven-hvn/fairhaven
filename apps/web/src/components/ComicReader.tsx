'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { unzip } from 'fflate'
import { orderComicPages, pageMime } from '@fairhaven/board-core'

interface Page {
  name: string
  url: string
}

/**
 * In-browser CBZ reader. Unzips once, renders pages as object URLs, single or
 * double page, arrows / tap zones / keys, remembers the last page per thread
 * on this device. Nothing leaves the tab.
 */
export function ComicReader({ bytes, threadKey, name, onClose }: { bytes: Uint8Array; threadKey: string; name?: string; onClose: () => void }) {
  const [pages, setPages] = useState<Page[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const storageKey = `fairhaven-comic:${threadKey}`
  const [index, setIndex] = useState(() => {
    if (typeof window === 'undefined') return 0
    const saved = Number(localStorage.getItem(storageKey) ?? '0')
    return Number.isFinite(saved) ? saved : 0
  })
  const [spread, setSpread] = useState(false)
  const [rtl, setRtl] = useState(false)
  const [fit, setFit] = useState<'height' | 'width'>('height')
  const urls = useRef<string[]>([])

  useEffect(() => {
    let cancelled = false
    unzip(bytes, (err, files) => {
      if (cancelled) return
      if (err) {
        setError(`Could not unzip: ${err.message}`)
        return
      }
      const names = orderComicPages(Object.keys(files))
      if (names.length === 0) {
        setError('No image pages in this archive.')
        return
      }
      const out = names.map((n) => {
        const url = URL.createObjectURL(new Blob([files[n] as BlobPart], { type: pageMime(n) }))
        urls.current.push(url)
        return { name: n, url }
      })
      setPages(out)
      setIndex((i) => Math.min(i, out.length - 1))
    })
    return () => {
      cancelled = true
      for (const u of urls.current) URL.revokeObjectURL(u)
      urls.current = []
    }
  }, [bytes])

  useEffect(() => {
    if (pages) localStorage.setItem(storageKey, String(index))
  }, [index, pages, storageKey])

  const step = spread ? 2 : 1
  const last = pages ? pages.length - 1 : 0
  const next = useCallback(() => setIndex((i) => Math.min(last, i + step)), [last, step])
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - step)), [step])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') (rtl ? prev : next)()
      else if (e.key === 'ArrowLeft') (rtl ? next : prev)()
      else if (e.key === 'Escape') onClose()
      else if (e.key === 'Home') setIndex(0)
      else if (e.key === 'End') setIndex(last)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev, rtl, last, onClose])

  const visible = useMemo(() => {
    if (!pages) return []
    const a = pages[index]
    const b = spread ? pages[index + 1] : undefined
    const pair = [a, b].filter((p): p is Page => p !== undefined)
    return rtl ? pair.reverse() : pair
  }, [pages, index, spread, rtl])

  if (error) return <div className="error">{error}</div>
  if (!pages) return <div className="muted">Unpacking {name ?? 'archive'}…</div>

  return (
    <div className="comic">
      <div className="comic-bar">
        <a href="#" onClick={(e) => (e.preventDefault(), onClose())}>close</a>
        {' · '}
        <a href="#" onClick={(e) => (e.preventDefault(), prev())}>‹</a> <b>{index + 1}{spread && index + 1 < pages.length ? `–${index + 2}` : ''}</b> / {pages.length}{' '}
        <a href="#" onClick={(e) => (e.preventDefault(), next())}>›</a>
        {' · '}
        <a href="#" onClick={(e) => (e.preventDefault(), setSpread((s) => !s))}>{spread ? 'single' : 'double'}</a>
        {' · '}
        <a href="#" onClick={(e) => (e.preventDefault(), setRtl((r) => !r))}>{rtl ? 'right-to-left' : 'left-to-right'}</a>
        {' · '}
        <a href="#" onClick={(e) => (e.preventDefault(), setFit((f) => (f === 'height' ? 'width' : 'height')))}>fit {fit}</a>
        {' · '}
        <input type="range" min={0} max={last} value={index} onChange={(e) => setIndex(Number(e.target.value))} style={{ width: 160, verticalAlign: 'middle' }} />
      </div>
      <div className={`comic-stage fit-${fit}`}>
        <div className="comic-zone left" onClick={rtl ? next : prev} />
        {visible.map((p) => (
          <img key={p.name} src={p.url} alt={p.name} />
        ))}
        <div className="comic-zone right" onClick={rtl ? prev : next} />
      </div>
    </div>
  )
}
