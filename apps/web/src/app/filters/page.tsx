'use client'

import { useState } from 'react'
import { CHAIN_LABEL, gateSpecOf, parseGateSpec, shortAddress } from '@fairhaven/board-core'
import { useFilters } from '@/store/filters'

export default function FiltersPage() {
  const { filters, unmuteAddress, muteAddress, unmuteCommunity, muteCommunity, setHideClear, setShowStubs, clear } = useFilters()
  const [addr, setAddr] = useState('')
  const [spec, setSpec] = useState('')
  const addrOk = /^0x[0-9a-fA-F]{40}$/.test(addr.trim())
  const specGate = parseGateSpec(spec)

  return (
    <div>
      <h2 className="subject" style={{ margin: '8px 0 4px' }}>
        Personal filters
      </h2>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        Nobody moderates a board for you. These lists hide posts on this device only. They are never published, never shared, and never change the order of threads: every reader still sees the same index, you just see less of it.
      </p>

      <table className="form">
        <tbody>
          <tr>
            <td>Addresses</td>
            <td>
              {filters.addresses.length === 0 && <span className="muted">none</span>}
              {filters.addresses.map((a) => (
                <div key={a}>
                  <span title={a}>{shortAddress(a)}</span>{' '}
                  <a href="#" onClick={(e) => (e.preventDefault(), unmuteAddress(a))}>
                    [unhide]
                  </a>
                </div>
              ))}
              <div style={{ marginTop: 4 }}>
                <input type="text" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" style={{ width: 340 }} />{' '}
                <button disabled={!addrOk} onClick={() => (muteAddress(addr.trim()), setAddr(''))}>
                  Hide
                </button>
              </div>
            </td>
          </tr>
          <tr>
            <td>Communities</td>
            <td>
              {filters.communities.length === 0 && <span className="muted">none</span>}
              {filters.communities.map((g) => (
                <div key={gateSpecOf(g)}>
                  holders of ≥ {g.threshold.toString()} of <span title={g.tokenAddress}>{g.tokenAddress.slice(0, 10)}…</span> on {CHAIN_LABEL[g.chain]}{' '}
                  <a href="#" onClick={(e) => (e.preventDefault(), unmuteCommunity(g))}>
                    [unhide]
                  </a>
                </div>
              ))}
              <div style={{ marginTop: 4 }}>
                <input type="text" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="gate:8453:0xTOKEN…:1" style={{ width: 340 }} />{' '}
                <button disabled={!specGate} onClick={() => (specGate && muteCommunity(specGate), setSpec(''))}>
                  Hide
                </button>
                <div className="exposure">Hides any poster whose balanceOf on that token meets the threshold. Checked live, cached a few minutes.</div>
              </div>
            </td>
          </tr>
          <tr>
            <td>Options</td>
            <td>
              <label>
                <input type="checkbox" checked={filters.hideClear} onChange={(e) => setHideClear(e.target.checked)} /> hide posts whose text is public (show members-only posts only)
              </label>
              <br />
              <label>
                <input type="checkbox" checked={filters.showStubs} onChange={(e) => setShowStubs(e.target.checked)} /> show a one-line stub where a post was hidden
              </label>
            </td>
          </tr>
          <tr>
            <td></td>
            <td>
              <button onClick={() => confirm('Clear all filters on this device?') && clear()}>Clear all</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
