'use client'

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { parseGateSpec, shortAddress, type BoardGate, type HiddenReason } from '@fairhaven/board-core'
import { describeHidden, isAddressMuted } from '@fairhaven/board-core'
import { useFilters } from '@/store/filters'

/** `[Hide ▾]` on a post's meta line: mute the address, or mute a community its author belongs to. */
export function HideMenu({ owner, boardGate }: { owner: string; boardGate: BoardGate }) {
  const { address } = useAccount()
  const filters = useFilters((s) => s.filters)
  const mute = useFilters((s) => s.muteAddress)
  const unmute = useFilters((s) => s.unmuteAddress)
  const muteCommunity = useFilters((s) => s.muteCommunity)
  const [open, setOpen] = useState(false)
  const [spec, setSpec] = useState('')
  if (address && address.toLowerCase() === owner.toLowerCase()) return null
  const muted = isAddressMuted(filters, owner)
  const specGate = parseGateSpec(spec)
  const sameAsBoard = specGate && specGate.tokenAddress === boardGate.tokenAddress && specGate.chain === boardGate.chain

  return (
    <span style={{ position: 'relative' }}>
      {' '}
      [
      <a href="#" onClick={(e) => (e.preventDefault(), setOpen((o) => !o))}>
        {muted ? 'Unhide' : 'Hide'} ▾
      </a>
      ]
      {open && (
        <div className="reply" style={{ position: 'absolute', zIndex: 3, left: 0, top: '100%', margin: 0, whiteSpace: 'nowrap' }}>
          <div>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                muted ? unmute(owner) : mute(owner)
                setOpen(false)
              }}
            >
              {muted ? 'Unhide' : 'Hide all posts by'} {shortAddress(owner)}
            </a>
          </div>
          <div style={{ marginTop: 4 }}>
            Hide holders of another community:
            <br />
            <input type="text" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="gate:8453:0xTOKEN…:1" style={{ width: 300 }} />{' '}
            <button
              disabled={!specGate || !!sameAsBoard}
              onClick={() => {
                if (specGate) muteCommunity(specGate)
                setSpec('')
                setOpen(false)
              }}
            >
              Hide
            </button>
            {sameAsBoard && <div className="error">That is this board's own gate; it would hide everyone.</div>}
            <div className="exposure">Checked by balanceOf on that token. Stored on this device only.</div>
          </div>
          <div style={{ marginTop: 4 }}>
            <a href="/filters">Manage filters…</a>
          </div>
        </div>
      )}
    </span>
  )
}

/** One-line stub for a hidden post. */
export function HiddenStub({ reason, owner, onShow }: { reason: HiddenReason; owner: string; onShow?: () => void }) {
  return (
    <div className="omitted">
      Post by {shortAddress(owner)} hidden ({describeHidden(reason)}).{' '}
      {onShow && (
        <a href="#" onClick={(e) => (e.preventDefault(), onShow())}>
          Show
        </a>
      )}
    </div>
  )
}
