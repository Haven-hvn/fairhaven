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
import { localhost, tiramisu } from '@arkiv-network/sdk/chains'
import { env } from './env'

// The Arkiv chain must be a configured network, not just a chain the write
// path asks the wallet to switch to: after `wallet_switchEthereumChain`,
// AppKit/wagmi see a chain id they do not know and report "this app doesn't
// support your current network", killing the flow before the entity prompt.
// Which Arkiv chain is live follows the configured RPC, as in `lib/post`.
const localArkiv = env.arkivRpcUrl.includes('localhost') || env.arkivRpcUrl.includes('127.0.0.1')
export const arkivNetwork = (localArkiv ? localhost : tiramisu) as unknown as AppKitNetwork

export const networks = [base, mainnet, optimism, arbitrum, sepolia, arkivNetwork] as [AppKitNetwork, ...AppKitNetwork[]]

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
