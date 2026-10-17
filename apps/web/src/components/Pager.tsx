'use client'

import Link from 'next/link'

export function Pager({ board, page, pages, view }: { board: string; page: number; pages: number; view: 'index' | 'catalog' }) {
  const href = (p: number) => `/board?b=${encodeURIComponent(board)}&p=${p}${view === 'catalog' ? '&view=catalog' : ''}`
  return (
    <div className="pager">
      {page > 1 ? <Link href={href(page - 1)}>Previous</Link> : <span className="muted">Previous</span>}
      {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (p === page ? <b key={p}>[{p}]</b> : <Link key={p} href={href(p)}>[{p}]</Link>))}
      {page < pages ? <Link href={href(page + 1)}>Next</Link> : <span className="muted">Next</span>}
      {' · '}
      <Link href={`/board?b=${encodeURIComponent(board)}${view === 'index' ? '&view=catalog' : ''}`}>{view === 'index' ? 'Catalog' : 'Index'}</Link>
    </div>
  )
}
