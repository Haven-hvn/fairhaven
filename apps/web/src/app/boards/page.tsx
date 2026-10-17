'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CHAIN_LABEL, parseGateSpec } from '@fairhaven/board-core'
import { useBoards } from '@/hooks/useBoard'

export default function BoardsPage() {
  const boards = useBoards()
  const router = useRouter()
  const [gateSpec, setGateSpec] = useState('')
  const valid = parseGateSpec(gateSpec) !== undefined

  return (
    <div>
      <h2 className="subject" style={{ margin: '8px 0 4px' }}>
        Boards
      </h2>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        A board is a Haven gate. Hold the token, read and post everything; otherwise see what members made public. Anything other Haven apps publish under a gate shows up as a thread. The <Link href="/">front page</Link> is every board at once.
      </p>
      {boards.isLoading && <div className="muted">Loading from Arkiv…</div>}
      {boards.error && <div className="error">Could not reach Arkiv: {String(boards.error)}</div>}
      {boards.data && boards.data.length === 0 && <div className="muted">No board definitions yet. Open a gate below or define one.</div>}
      {boards.data && boards.data.length > 0 && (
        <table className="boards">
          <thead>
            <tr>
              <th>Board</th>
              <th>Title</th>
              <th>Gate</th>
              <th>Threads/page</th>
              <th>Bump limit</th>
            </tr>
          </thead>
          <tbody>
            {boards.data.map((b) => (
              <tr key={b.key}>
                <td>
                  <Link href={`/board?b=${encodeURIComponent(b.board)}`}>/{b.board}/</Link>
                </td>
                <td>{b.title}</td>
                <td className="muted" title={b.gate.tokenAddress}>
                  ≥ {b.gate.threshold.toString()} of {b.gate.tokenAddress.slice(0, 8)}… on {CHAIN_LABEL[b.gate.chain]}
                </td>
                <td>{b.pageSize}</td>
                <td>{b.bumpLimit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <hr />
      <div>
        <b>Open any gate</b> <span className="muted">(no definition needed; defaults apply)</span>
        <br />
        <input type="text" style={{ width: 420, maxWidth: '100%' }} placeholder="gate:8453:0xTOKEN…:1" value={gateSpec} onChange={(e) => setGateSpec(e.target.value)} />{' '}
        <button disabled={!valid} onClick={() => router.push(`/board?b=${encodeURIComponent(gateSpec.trim())}`)}>
          Open
        </button>
      </div>
      <p className="muted">
        Or <Link href="/new">define a board</Link> for a gate you hold.
      </p>
    </div>
  )
}
