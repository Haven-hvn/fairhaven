'use client'

/**
 * Browser env for the Fairhaven web client. Every value comes from a
 * `NEXT_PUBLIC_*` variable (see `apps/web/.env.local.example`); each has a
 * mainnet/testnet default so a bare checkout still reads and builds.
 */

function str(name: string, fallback: string): string {
  const v = process.env[name]
  return v !== undefined && v !== '' ? v : fallback
}

export interface Env {
  walletConnectProjectId: string
  appUrl: string
  arkivRpcUrl: string
  icpHost: string
  havenAolCanisterId: string
  eip712ChainId: bigint
  eip712VerifyingContract: string
  fetchRootKey: boolean
  /** EVM RPC per EIP-155 chain id, for membership `balanceOf` checks. */
  rpcUrls: Record<number, string>
  synapseChainId: number
  synapseEnableCdn: boolean
  /** Gateway for clear UnixFS roots (`fcid`). Empty = link out instead. */
  ipfsGateway: string
  havenDappUrl: string
}

const rpcUrls: Record<number, string> = {
  1: str('NEXT_PUBLIC_RPC_1', 'https://ethereum-rpc.publicnode.com'),
  8453: str('NEXT_PUBLIC_RPC_8453', 'https://base-rpc.publicnode.com'),
  10: str('NEXT_PUBLIC_RPC_10', 'https://optimism-rpc.publicnode.com'),
  42161: str('NEXT_PUBLIC_RPC_42161', 'https://arbitrum-one-rpc.publicnode.com'),
  11155111: str('NEXT_PUBLIC_RPC_11155111', 'https://ethereum-sepolia-rpc.publicnode.com'),
}

export const env: Env = {
  walletConnectProjectId: str('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', ''),
  appUrl: str('NEXT_PUBLIC_APP_URL', 'https://fairhaven.local'),
  arkivRpcUrl: str('NEXT_PUBLIC_ARKIV_RPC_URL', 'https://rpc.tiramisu.db-chain.testnet.arkiv.network'),
  icpHost: str('NEXT_PUBLIC_ICP_HOST', 'https://icp-api.io'),
  havenAolCanisterId: str('NEXT_PUBLIC_HAVEN_AOL_CANISTER_ID', 'gny6k-fqaaa-aaaab-ag3ra-cai'),
  eip712ChainId: BigInt(str('NEXT_PUBLIC_EIP712_CHAIN_ID', '1')),
  eip712VerifyingContract: str('NEXT_PUBLIC_EIP712_VERIFYING_CONTRACT', '0x0000000000000000000000000000000000000000'),
  fetchRootKey: str('NEXT_PUBLIC_HAVEN_AOL_FETCH_ROOT_KEY', 'false') === 'true',
  rpcUrls,
  synapseChainId: Number(str('NEXT_PUBLIC_SYNAPSE_CHAIN_ID', '8453')),
  synapseEnableCdn: str('NEXT_PUBLIC_SYNAPSE_ENABLE_CDN', 'true') === 'true',
  ipfsGateway: str('NEXT_PUBLIC_IPFS_GATEWAY', '').replace(/\/+$/, ''),
  havenDappUrl: str('NEXT_PUBLIC_HAVEN_DAPP_URL', 'https://haven.video'),
}
