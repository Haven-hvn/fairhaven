'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createAppKit } from '@reown/appkit/react'
import { useEffect, useState, type ReactNode } from 'react'
import { WagmiProvider, type Config } from 'wagmi'
import { env } from '@/lib/env'
import { networks, wagmiAdapter, wagmiConfig } from '@/lib/wallet'
import { useSession } from '@/store/session'

if (typeof window !== 'undefined' && env.walletConnectProjectId) {
  createAppKit({
    adapters: [wagmiAdapter],
    projectId: env.walletConnectProjectId,
    networks,
    metadata: { name: 'Fairhaven', description: 'Gated, pseudonymous, ephemeral boards.', url: env.appUrl, icons: [] },
    themeMode: 'light',
    features: { analytics: false },
  })
}

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } }))
  const theme = useSession((s) => s.theme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  return (
    <WagmiProvider config={wagmiConfig as Config}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
