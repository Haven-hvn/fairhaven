'use client'

/**
 * Wallet wiring: the AppKit networks list, the wagmi adapter, and the wagmi
 * config. Covers every gate chain (mainnet, Base, Optimism, Arbitrum,
 * Sepolia) so membership checks and signatures never force a network the
 * user's wallet does not have.
 */

import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { mainnet, base, optimism, arbitrum, sepolia } from '@reown/appkit/networks'
import type { AppKitNetwork } from '@reown/appkit/networks'
import { env } from './env'

export const networks = [base, mainnet, optimism, arbitrum, sepolia] as [AppKitNetwork, ...AppKitNetwork[]]

export const wagmiAdapter = new WagmiAdapter({
  ssr: true,
  projectId: env.walletConnectProjectId || 'unset',
  networks,
})

export const wagmiConfig = wagmiAdapter.wagmiConfig
