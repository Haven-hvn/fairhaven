'use client'

/**
 * Last-resort error page for the static export. Replaces Next's generic
 * "couldn't load" screen with the board's own voice and a way back.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" data-theme="daybreak">
      <body>
        <div className="container">
          <div className="notice">
            <h1 className="subject">The board misprinted this page</h1>
            <p className="muted">Something broke while rendering. Your wallet, filters, and drafts on this device are untouched.</p>
            <p>
              <button onClick={() => reset()}>Try again</button> <a href="/">Back to all boards</a>
            </p>
          </div>
        </div>
      </body>
    </html>
  )
}
