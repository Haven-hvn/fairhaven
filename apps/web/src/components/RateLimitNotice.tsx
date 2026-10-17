'use client'

import { useEffect, useState } from 'react'
import { isRateLimitError } from '@fairhaven/board-core'

/** Rendered 429 state: quota is per-IP and shared, so say when it resets. */
export function RateLimitNotice({ error }: { error: unknown }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (!isRateLimitError(error)) return <div className="error">{error instanceof Error ? error.message : String(error)}</div>
  const resetsAt = error.resetsAt ?? (error.retryAfterS ? Date.now() + error.retryAfterS * 1000 : undefined)
  const secs = resetsAt ? Math.max(0, Math.ceil((resetsAt - now) / 1000)) : error.retryAfterS
  return (
    <div className="notice" role="alert">
      <h1>Rate limited</h1>
      <p>
        Arkiv&apos;s anonymous tier is shared per IP and is exhausted for now.
        {secs !== undefined ? <> It resets in {secs}s{resetsAt ? ` (${new Date(resetsAt).toLocaleTimeString()})` : ''}.</> : ' Try again shortly.'}
        {error.quotaUsedPercent !== undefined ? <> Quota used: {Math.round(error.quotaUsedPercent)}%.</> : null}
      </p>
    </div>
  )
}

export function isRateLimited(error: unknown): boolean {
  return isRateLimitError(error)
}
