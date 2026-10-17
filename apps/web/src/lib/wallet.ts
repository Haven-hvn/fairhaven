'use client'

/**
 * Wallet wiring: the AppKit networks list, the wagmi adapter/config, and the
 * shared modal instance. Mirrors haven-dapp's `config` + `context`: the modal
 * is created once at module level and components call `modal?.open()` —
 * they never subscribe via `useAppKit()`, whose server/client snapshots
 * diverge during hydration.
 */

import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { mainnet, base, optimism, arbitrum, sepolia } from '@reown/appkit/networks'
import type { AppKitNetwork } from '@reown/appkit/networks'
import { createAppKit } from '@reown/appkit/react'
import { env } from './env'

export const networks = [base, mainnet, optimism, arbitrum, sepolia] as [AppKitNetwork, ...AppKitNetwork[]]

export const wagmiAdapter = new WagmiAdapter({
  ssr: true,
  projectId: env.walletConnectProjectId || 'unset',
  networks,
})

export const wagmiConfig = wagmiAdapter.wagmiConfig

/** Shared modal instance (null when no WalletConnect project id is set). */
export const modal = env.walletConnectProjectId
  ? createAppKit({
      adapters: [wagmiAdapter],
      projectId: env.walletConnectProjectId,
      networks,
      metadata: { name: 'Fairhaven', description: 'Gated, pseudonymous, ephemeral boards.', url: env.appUrl, icons: [] },
      themeMode: 'light',
      features: { analytics: false },
    })
  : null
