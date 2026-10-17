'use client'

import { isGreentext, segmentLine } from '@fairhaven/board-core'
import { useState } from 'react'

export interface QuoteTarget {
  key: string
  preview: string
  owner: string
}

/** Renders post text: greentext lines, >>quotes with hover preview, URLs. */
export function Body({ text, knownKeys, onQuoteHover, previewFor }: { text: string; knownKeys: Iterable<string>; onQuoteHover?: (key: string | null) => void; previewFor?: (key: string) => QuoteTarget | undefined }) {
  const keys = [...knownKeys]
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null)
  const lines = text.split('\n')
  return (
    <blockquote className="body" style={{ position: 'relative' }}>
      {lines.map((line, i) => {
        const segs = segmentLine(line, keys)
        const content = segs.map((s, j) => {
          if (s.kind === 'text') return <span key={j}>{s.text}</span>
          if (s.kind === 'url')
            return (
              <a key={j} href={s.href} target="_blank" rel="noreferrer noopener">
                {s.href}
              </a>
            )
          if (!s.key) return <span key={j} className="quote dead">{`>>${s.short}`}</span>
          return (
            <a
              key={j}
              className="quote"
              href={`#p${s.key.slice(2, 10)}`}
              onMouseEnter={(e) => {
                setHover({ key: s.key!, x: e.clientX, y: e.clientY })
                onQuoteHover?.(s.key!)
              }}
              onMouseLeave={() => {
                setHover(null)
                onQuoteHover?.(null)
              }}
            >{`>>${s.short}`}</a>
          )
        })
        return (
          <span key={i} className={isGreentext(line) ? 'green' : undefined}>
            {content}
            {i < lines.length - 1 ? '\n' : null}
          </span>
        )
      })}
      {hover && previewFor && <Preview target={previewFor(hover.key)} />}
    </blockquote>
  )
}

function Preview({ target }: { target: QuoteTarget | undefined }) {
  if (!target) return null
  return (
    <div className="reply" style={{ position: 'absolute', left: 0, top: '100%', zIndex: 2, maxWidth: 400 }}>
      <div className="meta">
        <span className="name">{target.owner}</span> <span className="postid">No.{target.key.slice(2, 10)}</span>
      </div>
      <div className="body">{target.preview}</div>
    </div>
  )
}
