'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { cookieToInitialState, WagmiProvider, type Config } from 'wagmi'
import { connect, disconnect, getConnection } from '@wagmi/core'
import { injected } from '@wagmi/connectors'
import { wagmiConfig } from '@/lib/wallet'
import { forgetKeys } from '@/lib/aol'
import { useSession } from '@/store/session'
import { loadPersisted, persistQueryCache } from '@/lib/persist'

function getClientCookies(): string | null {
  if (typeof document !== 'undefined') return document.cookie || null
  return null
}

/**
 * Connects Fairhaven to the parent Haven OS runtime (`haven-os:v1`) when
 * embedded in an iframe (same-origin or cross-site `*.pinme.dev`), sharing
 * the OS wallet and VetKD epoch keyring with zero extra popups.
 */
function HavenOsBridgeSync() {
  useEffect(() => {
    let cancelled = false
    let unsubAccounts: (() => void) | undefined
    let unsubKeyring: (() => void) | undefined

    ;(async () => {
      const { registerHavenOsBridge } = await import('haven-aol')
      const bridge = registerHavenOsBridge({ appId: 'fairhaven' })
      if (!bridge || cancelled) return

      const syncWallet = async (addr: string | null) => {
        if (cancelled) return
        const conn = getConnection(wagmiConfig as Config)
        if (addr) {
          if (conn.address?.toLowerCase() === addr.toLowerCase()) return
          const connector = injected({
            target: () => ({
              id: 'haven-os-bridge',
              name: 'Haven OS Shared Wallet',
              provider: bridge.provider as never,
            }),
          })
          await connect(wagmiConfig as Config, { connector }).catch(() => undefined)
        } else if (conn.isConnected && conn.connector?.id === 'haven-os-bridge') {
          forgetKeys()
          await disconnect(wagmiConfig as Config).catch(() => undefined)
        }
      }

      const welcome = await bridge.waitForWelcome()
      if (cancelled || !welcome) return
      if (welcome.wallet.address && !welcome.wallet.watchOnly) {
        await syncWallet(welcome.wallet.address)
      }
      if (welcome.unlockedGates.length > 0) {
        useSession.getState().bumpUnlock()
      }

      unsubAccounts = bridge.onEvent('accountsChanged', (accounts) => {
        const list = Array.isArray(accounts) ? accounts : []
        const next = typeof list[0] === 'string' ? list[0] : null
        void syncWallet(next)
      })
      unsubKeyring = bridge.onEvent('keyringChanged', () => {
        useSession.getState().bumpUnlock()
      })
    })()

    return () => {
      cancelled = true
      unsubAccounts?.()
      unsubKeyring?.()
    }
  }, [])
  return null
}

export function Providers({ children }: { children: ReactNode }) {
  // Never retry a 429 (it only burns more anonymous quota); one retry otherwise.
  const [qc] = useState(() => { const c = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: (count, e) => count < 1 && !(e instanceof Error && (e.name === 'RateLimitError' || /\b429\b|ANON_COST_LIMITED/.test(e.message))) } } }); loadPersisted(c); return c })
  const [initialState] = useState(() => cookieToInitialState(wagmiConfig as Config, getClientCookies()))
  useEffect(() => persistQueryCache(qc), [qc])
  const theme = useSession((s) => s.theme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  return (
    <WagmiProvider config={wagmiConfig as Config} initialState={initialState}>
      <QueryClientProvider client={qc}>
        <HavenOsBridgeSync />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
