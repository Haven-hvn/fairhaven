import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeEventTopics, parseAbi } from 'viem'
import { pendingProgressLabel, submitReply, writeProgressLabel, type BrowserWallet, type WriteProgress } from '../src/lib/post'

// Minting a receipt needs the Haven-AOL canister and a `signTypedData` wallet
// call, neither of which this write-path spec is about. Stub it so the spec
// covers the Arkiv transaction and the stage reporting around it.
const receipts = vi.hoisted(() => {
  const fake = { epoch: 679, at: 1_760_000_000, bal: '5', sig: 'ab'.repeat(64) }
  return { ensureReceipt: vi.fn(async () => fake) }
})
vi.mock('../src/lib/receipt', () => ({ ensureReceipt: receipts.ensureReceipt }))

const ARKIV_ADDRESS = '0x4400000000000000000000000000000000000044'
const OWNER = '0x1111111111111111111111111111111111111111' as `0x${string}`
const ENTITY_KEY = `0x${'22'.repeat(32)}` as `0x${string}`
const TX_HASH = `0x${'33'.repeat(32)}` as `0x${string}`

/**
 * Regression: a public (unsealed) reply must reach the wallet. It used to be
 * built on a plain viem wallet client, which has no Arkiv `createEntity`, so
 * no Arkiv transaction — and no signing prompt — ever happened, while the UI
 * sat on "Sealing…" (a step a public reply never performs).
 */
describe('submitReply (public)', () => {
  beforeEach(() => {
    receipts.ensureReceipt.mockClear()
  })

  it('switches to Arkiv, prompts for the entity tx, and reports honest stages', async () => {
    const methods: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sentTx: any
    const [topic0, topicKey, topicOwner] = encodeEventTopics({
      abi: parseAbi(['event EntityCreated(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt, uint8 creationFlags)']),
      eventName: 'EntityCreated',
      args: { entityKey: ENTITY_KEY, owner: OWNER },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any as [`0x${string}`, `0x${string}`, `0x${string}`]
    const receipt = {
      transactionHash: TX_HASH,
      transactionIndex: '0x0',
      blockHash: `0x${'44'.repeat(32)}`,
      blockNumber: '0x64',
      from: OWNER,
      to: ARKIV_ADDRESS,
      contractAddress: null,
      status: '0x1',
      gasUsed: '0x5208',
      cumulativeGasUsed: '0x5208',
      effectiveGasPrice: '0x1',
      type: '0x2',
      logs: [
        {
          address: ARKIV_ADDRESS,
          topics: [topic0, topicKey, topicOwner],
          // expiresAt (uint64) + creationFlags (uint8), ABI-encoded
          data: `0x${(200n).toString(16).padStart(64, '0')}${(0n).toString(16).padStart(64, '0')}`,
          blockHash: `0x${'44'.repeat(32)}`,
          blockNumber: '0x64',
          transactionHash: TX_HASH,
          transactionIndex: '0x0',
          logIndex: '0x0',
          removed: false,
        },
      ],
      logsBloom: `0x${'00'.repeat(256)}`,
    }
    const provider = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request: async ({ method, params }: any) => {
        methods.push(method)
        switch (method) {
          case 'wallet_switchEthereumChain':
            return null
          case 'eth_chainId':
            return '0x7614d1' // 7738577, Arkiv tiramisu
          case 'eth_blockNumber':
            return '0x64'
          case 'eth_getTransactionCount':
            return '0x0'
          case 'eth_estimateGas':
            return '0x30000'
          case 'eth_maxPriorityFeePerGas':
            return '0x1'
          case 'eth_gasPrice':
            return '0x1'
          case 'eth_feeHistory':
            return { baseFeePerGas: ['0x1', '0x1'], gasUsedRatio: [0.5], reward: [['0x1']], oldestBlock: '0x64' }
          case 'eth_call':
            return '0x'
          case 'eth_sendTransaction':
            sentTx = params[0]
            return TX_HASH
          case 'eth_getTransactionReceipt':
            return receipt
          default:
            throw new Error(`unexpected RPC method ${method}`)
        }
      },
    }
    const gate = { chain: 'EthMainnet', tokenAddress: '0x5555555555555555555555555555555555555555', threshold: 1n } as const

    // Two wallet shapes: a raw provider at `transport.value`, and the real
    // wagmi wallet-client shape — a resolved viem transport exposing only
    // `request`, with no injected `window.ethereum` (WalletConnect/AppKit).
    // The latter used to die with "wallet provider not available for signing".
    const shapes: Array<[string, BrowserWallet]> = [
      ['transport.value provider', { account: { address: OWNER }, transport: { value: provider } } as unknown as BrowserWallet],
      ['transport.request only (wagmi)', { account: { address: OWNER }, transport: { request: provider.request } } as unknown as BrowserWallet],
    ]
    for (const [name, wallet] of shapes) {
      methods.length = 0
      sentTx = undefined
      const stages: WriteProgress['stage'][] = []
      const res = await submitReply({
        wallet,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        board: { ref: { slug: 'test.board', gate }, postTtlS: 3600 } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        root: { kind: 'thread', key: `0x${'aa'.repeat(32)}`, owner: OWNER, board: 'test.board', subject: 'hi', gate } as any,
        text: 'hello',
        sealText: false,
        noBump: false,
        onProgress: (p) => stages.push(p.stage),
      })

      expect(res, name).toEqual({ key: ENTITY_KEY, txHash: TX_HASH })
      // The wallet was actually asked to switch and to send the Arkiv tx.
      expect(methods, name).toContain('wallet_switchEthereumChain')
      expect(methods, name).toContain('eth_sendTransaction')
      expect(String(sentTx.to).toLowerCase(), name).toBe(ARKIV_ADDRESS)
      // A public reply proves membership first (mocked receipt), then never
      // seals, and every stage names its real step.
      expect(receipts.ensureReceipt, name).toHaveBeenCalledWith(
        expect.objectContaining({ account: { address: OWNER } }),
        gate,
        expect.any(Function),
      )
      expect(stages, name).toEqual(['attesting', 'preparing', 'switching', 'signing', 'done'])
    }
    expect(writeProgressLabel({ stage: 'preparing' })).not.toMatch(/sealing/i)
    expect(pendingProgressLabel('signing')).toMatch(/confirm in your wallet/)
    expect(pendingProgressLabel(undefined)).toMatch(/not posted yet/)
  })

  it('restores the pre-write network after a write; a refused switch fails without stranding', async () => {
    const [topic0, topicKey, topicOwner] = encodeEventTopics({
      abi: parseAbi(['event EntityCreated(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt, uint8 creationFlags)']),
      eventName: 'EntityCreated',
      args: { entityKey: ENTITY_KEY, owner: OWNER },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any as [`0x${string}`, `0x${string}`, `0x${string}`]
    const receipt = {
      transactionHash: TX_HASH, transactionIndex: '0x0', blockHash: `0x${'44'.repeat(32)}`, blockNumber: '0x64',
      from: OWNER, to: ARKIV_ADDRESS, contractAddress: null, status: '0x1', gasUsed: '0x5208',
      cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', type: '0x2',
      logs: [{ address: ARKIV_ADDRESS, topics: [topic0, topicKey, topicOwner], data: `0x${(200n).toString(16).padStart(64, '0')}${(0n).toString(16).padStart(64, '0')}`, blockHash: `0x${'44'.repeat(32)}`, blockNumber: '0x64', transactionHash: TX_HASH, transactionIndex: '0x0', logIndex: '0x0', removed: false }],
      logsBloom: `0x${'00'.repeat(256)}`,
    }
    const gate = { chain: 'BaseMainnet', tokenAddress: '0x5555555555555555555555555555555555555555', threshold: 1n } as const

    for (const refuseSwitch of [false, true]) {
      // Wallet starts on Base (8453), an AppKit-supported gate chain.
      let currentChain = '0x2105'
      const switches: string[] = []
      const provider = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        request: async ({ method, params }: any) => {
          switch (method) {
            case 'eth_chainId': return currentChain
            case 'wallet_switchEthereumChain': {
              if (refuseSwitch) throw Object.assign(new Error('user rejected switch'), { code: 4001 })
              currentChain = params[0].chainId
              switches.push(params[0].chainId)
              return null
            }
            case 'eth_blockNumber': return '0x64'
            case 'eth_getTransactionCount': return '0x0'
            case 'eth_estimateGas': return '0x30000'
            case 'eth_maxPriorityFeePerGas': return '0x1'
            case 'eth_gasPrice': return '0x1'
            case 'eth_feeHistory': return { baseFeePerGas: ['0x1', '0x1'], gasUsedRatio: [0.5], reward: [['0x1']], oldestBlock: '0x64' }
            case 'eth_call': return '0x'
            case 'eth_sendTransaction': return TX_HASH
            case 'eth_getTransactionReceipt': return receipt
            default: throw new Error(`unexpected RPC method ${method}`)
          }
        },
      }
      const wallet = { account: { address: OWNER }, transport: { value: provider } } as unknown as BrowserWallet
      const attempt = submitReply({
        wallet,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        board: { ref: { slug: 'test.board', gate }, postTtlS: 3600 } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        root: { kind: 'thread', key: `0x${'aa'.repeat(32)}`, owner: OWNER, board: 'test.board', subject: 'hi', gate } as any,
        text: 'hello', sealText: false, noBump: false,
      })
      if (refuseSwitch) {
        // viem will not send a Tiramisu tx from Base, so a refused switch
        // must fail the post — but the wallet stays on Base, not stranded.
        await expect(attempt).rejects.toThrow(/did not switch to the Arkiv chain/)
        expect(currentChain).toBe('0x2105')
        continue
      }
      const res = await attempt
      expect(res).toEqual({ key: ENTITY_KEY, txHash: TX_HASH })
      // Switched to Arkiv for the tx, then back to Base — never left on a
      // chain AppKit does not support.
      expect(switches).toEqual(['0x7614d1', '0x2105'])
      expect(currentChain).toBe('0x2105')
    }
  })
})
