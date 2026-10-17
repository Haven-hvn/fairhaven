'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { cookieToInitialState, WagmiProvider, type Config } from 'wagmi'
import { wagmiConfig } from '@/lib/wallet'
import { useSession } from '@/store/session'

function getClientCookies(): string | null {
  if (typeof document !== 'undefined') return document.cookie || null
  return null
}

export function Providers({ children }: { children: ReactNode }) {
  // Never retry a 429 (it only burns more anonymous quota); one retry otherwise.
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: (count, e) => count < 1 && !(e instanceof Error && (e.name === 'RateLimitError' || /\b429\b|ANON_COST_LIMITED/.test(e.message))) } } }))
  const [initialState] = useState(() => cookieToInitialState(wagmiConfig as Config, getClientCookies()))
  const theme = useSession((s) => s.theme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  return (
    <WagmiProvider config={wagmiConfig as Config} initialState={initialState}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
