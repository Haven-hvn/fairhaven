'use client'

import Link from 'next/link'
import { useAccount, useDisconnect } from 'wagmi'
import { useAppKit } from '@reown/appkit/react'
import { shortAddress } from '@fairhaven/board-core'
import { useBoards } from '@/hooks/useBoard'
import { useSession } from '@/store/session'
import { forgetKeys } from '@/lib/aol'
import { clearOpened } from '@/lib/open-cache'
import { env } from '@/lib/env'

export function Navbar() {
  const boards = useBoards()
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const theme = useSession((s) => s.theme)
  const setTheme = useSession((s) => s.setTheme)
  const appkit = env.walletConnectProjectId ? useAppKit() : null

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
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault()
            setTheme(theme === 'daybreak' ? 'parchment' : 'daybreak')
          }}
        >
          {theme === 'daybreak' ? 'parchment' : 'daybreak'}
        </a>
        ]
      </span>
      <span>
        [
        {isConnected && address ? (
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
        ) : appkit ? (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              appkit.open()
            }}
          >
            connect wallet
          </a>
        ) : (
          <span className="muted" title="Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID">
            wallet unavailable
          </span>
        )}
        ]
      </span>
    </div>
  )
}
