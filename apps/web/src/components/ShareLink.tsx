'use client'

import { useEffect, useState } from 'react'

/**
 * `[Share]`: native share sheet where available (phones), clipboard
 * otherwise, with a short "copied" confirmation. Same behavior as
 * haven-dapp's DripLockNotice / HandoffPanel. The URL is the plain static
 * route, so it works for anyone; non-holders land on the frosted view.
 */
export function ShareLink({ path, title, label = 'Share' }: { path: string; title: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(t)
  }, [state])

  const share = async () => {
    const url = `${window.location.origin}${path}`
    const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string; url?: string }) => Promise<void> }
    try {
      if (typeof nav.share === 'function') {
        await nav.share({ title, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setState('copied')
    } catch (e) {
      // User dismissed the sheet, or clipboard denied: fall back to a prompt they can copy from.
      if (e instanceof Error && e.name === 'AbortError') return
      try {
        await navigator.clipboard.writeText(url)
        setState('copied')
      } catch {
        window.prompt('Copy this link', url)
        setState('failed')
      }
    }
  }

  return (
    <span>
      [
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault()
          void share()
        }}
        title="Share a link to this"
      >
        {state === 'copied' ? 'copied' : state === 'failed' ? 'copy failed' : label}
      </a>
      ]
    </span>
  )
}

export function threadPath(board: string, key: string, post?: string): string {
  const base = `/thread?b=${encodeURIComponent(board)}&k=${key}`
  return post ? `${base}#p${post.slice(2, 10)}` : base
}
