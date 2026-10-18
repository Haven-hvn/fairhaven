'use client'

import { useEffect, useRef } from 'react'
import type { MediaField, ThreadRecord } from '@fairhaven/board-core'
import { cancelIdle, prefetch } from '@/lib/prefetch'
import { useSession } from '@/store/session'

/**
 * Prefetch (and pre-open) a thread's media when its OP is near the viewport
 * and the viewer can already open it. Re-evaluates after an unlock. Hover
 * also triggers (1.5 s, like haven-dapp) for items outside the viewport
 * policy. Nothing is shown; the result lands in the open cache.
 */
export function usePrefetchMedia(thread: ThreadRecord, media: MediaField | undefined) {
  const ref = useRef<HTMLDivElement | null>(null)
  const version = useSession((s) => s.unlockVersion)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !media) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          // Viewport prefetch only for sealed media the viewer already unlocked;
          // clear media waits for hover intent (below) or an explicit click.
          if (e.isIntersecting) { if (media.piece !== undefined) prefetch(thread, media) }
          else cancelIdle(media)
        }
      },
      { rootMargin: '600px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [thread.key, media?.piece, media?.fcid, version])

  const onMouseEnter = () => {
    if (!media) return
    hoverTimer.current = setTimeout(() => prefetch(thread, media), 1500)
  }
  const onMouseLeave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }
  return { ref, onMouseEnter, onMouseLeave }
}
