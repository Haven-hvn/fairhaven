'use client'

/**
 * Browser env for the Fairhaven web client. Every value comes from a
 * `NEXT_PUBLIC_*` variable (see `apps/web/.env.local.example`); each has a
 * mainnet/testnet default so a bare checkout still reads and builds.
 *
 * NOTE: each variable MUST be referenced as a `process.env.NEXT_PUBLIC_*`
 * literal. A dynamic lookup (`process.env[name]`) defeats Next's static
 * inlining and the browser silently gets empty strings for everything.
 */

function str(value: string | undefined, fallback: string): string {
  return value !== undefined && value !== '' ? value : fallback
}

export interface Env {
  walletConnectProjectId: string
  appUrl: string
  arkivRpcUrl: string
  /**
   * Arkiv access key, sent as `X-API-KEY` on reads. Built from the `ARKIV_API_KEY`
   * repo secret into a `NEXT_PUBLIC_*` value, so it ships with the static bundle:
   * it raises the read quota, it does not protect a write. Empty = anonymous tier.
   */
  arkivApiKey: string
  icpHost: string
  havenAolCanisterId: string
  eip712ChainId: bigint
  eip712VerifyingContract: string
  fetchRootKey: boolean
  /** Pinned Haven-AOL attestation public key (64 hex). Empty = fetch once from the canister and cache. */
  attestPublicKeyHex: string
  /** EVM RPC per EIP-155 chain id: the connected wallet's own balance and community mutes only. Posts are verified by receipt, not RPC. */
  rpcUrls: Record<number, string>
  synapseChainId: number
  synapseEnableCdn: boolean
  /** Gateway for clear UnixFS roots (`fcid`). Empty = link out instead. */
  ipfsGateway: string
  havenDappUrl: string
}

export const env: Env = {
  walletConnectProjectId: str(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID, ''),
  appUrl: str(process.env.NEXT_PUBLIC_APP_URL, 'https://fairhaven.local'),
  arkivRpcUrl: str(process.env.NEXT_PUBLIC_ARKIV_RPC_URL, 'https://rpc.tiramisu.db-chain.testnet.arkiv.network'),
  arkivApiKey: str(process.env.NEXT_PUBLIC_ARKIV_API_KEY, ''),
  icpHost: str(process.env.NEXT_PUBLIC_ICP_HOST, 'https://icp-api.io'),
  havenAolCanisterId: str(process.env.NEXT_PUBLIC_HAVEN_AOL_CANISTER_ID, 'gny6k-fqaaa-aaaab-ag3ra-cai'),
  eip712ChainId: BigInt(str(process.env.NEXT_PUBLIC_EIP712_CHAIN_ID, '1')),
  eip712VerifyingContract: str(process.env.NEXT_PUBLIC_EIP712_VERIFYING_CONTRACT, '0x0000000000000000000000000000000000000000'),
  fetchRootKey: str(process.env.NEXT_PUBLIC_HAVEN_AOL_FETCH_ROOT_KEY, 'false') === 'true',
  attestPublicKeyHex: str(process.env.NEXT_PUBLIC_HAVEN_ATTEST_PUBKEY, '').toLowerCase().replace(/^0x/, ''),
  rpcUrls: {
    1: str(process.env.NEXT_PUBLIC_RPC_1, 'https://ethereum-rpc.publicnode.com'),
    8453: str(process.env.NEXT_PUBLIC_RPC_8453, 'https://base-rpc.publicnode.com'),
    10: str(process.env.NEXT_PUBLIC_RPC_10, 'https://optimism-rpc.publicnode.com'),
    42161: str(process.env.NEXT_PUBLIC_RPC_42161, 'https://arbitrum-one-rpc.publicnode.com'),
    11155111: str(process.env.NEXT_PUBLIC_RPC_11155111, 'https://ethereum-sepolia-rpc.publicnode.com'),
  },
  synapseChainId: Number(str(process.env.NEXT_PUBLIC_SYNAPSE_CHAIN_ID, '8453')),
  synapseEnableCdn: str(process.env.NEXT_PUBLIC_SYNAPSE_ENABLE_CDN, 'true') === 'true',
  ipfsGateway: str(process.env.NEXT_PUBLIC_IPFS_GATEWAY, '').replace(/\/+$/, ''),
  havenDappUrl: str(process.env.NEXT_PUBLIC_HAVEN_DAPP_URL, 'https://haven.video'),
}
