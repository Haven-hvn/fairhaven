'use client'

import Link from 'next/link'
import { useAccount, useDisconnect } from 'wagmi'
import { shortAddress } from '@fairhaven/board-core'
import { useBoards } from '@/hooks/useBoard'
import { useMounted } from '@/hooks/useMounted'
import { useSession } from '@/store/session'
import { forgetKeys } from '@/lib/aol'
import { clearOpened } from '@/lib/open-cache'
import { modal } from '@/lib/wallet'

export function Navbar() {
  const boards = useBoards()
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const theme = useSession((s) => s.theme)
  const setTheme = useSession((s) => s.setTheme)
  // Wallet + theme state legitimately differ between SSR and the browser
  // (connection, modal, saved theme), so both render static placeholders
  // until mounted. See hooks/useMounted.
  const mounted = useMounted()

  return (
    <div className="nav">
      <span>
        [<Link href="/">all</Link>]
      </span>
      <span>
        [<Link href="/boards">boards</Link>]
      </span>
      {(boards.data ?? []).slice(0, 8).map((b) => (
        <span key={b.key}>
          [<Link href={`/board?b=${encodeURIComponent(b.board)}`}>{b.board}</Link>]
        </span>
      ))}
      <span>
        [<Link href="/new">new</Link>]
      </span>
      <span>
        [<Link href="/filters">filters</Link>]
      </span>
      <span className="spacer" />
      <span>
        [
        {mounted ? (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              setTheme(theme === 'daybreak' ? 'parchment' : 'daybreak')
            }}
          >
            {theme === 'daybreak' ? 'parchment' : 'daybreak'}
          </a>
        ) : (
          <span className="muted">theme</span>
        )}
        ]
      </span>
      <span>
        [
        {mounted && isConnected && address ? (
          <a
            href="#"
            title={address}
            onClick={(e) => {
              e.preventDefault()
              forgetKeys()
              clearOpened()
              disconnect()
            }}
          >
            {shortAddress(address)} · disconnect
          </a>
        ) : mounted && modal ? (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              modal?.open()
            }}
          >
            connect wallet
          </a>
        ) : (
          <span className="muted" title={mounted ? 'Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID' : undefined}>
            {mounted ? 'wallet unavailable' : 'connect wallet'}
          </span>
        )}
        ]
      </span>
    </div>
  )
}
