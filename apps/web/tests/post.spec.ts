import { describe, expect, it } from 'vitest'
import { encodeEventTopics, parseAbi } from 'viem'
import { pendingProgressLabel, submitReply, writeProgressLabel, type BrowserWallet, type WriteProgress } from '../src/lib/post'

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
    const wallet = { account: { address: OWNER }, transport: { value: provider } } as unknown as BrowserWallet
    const gate = { chain: 'EthMainnet', tokenAddress: '0x5555555555555555555555555555555555555555', threshold: 1n } as const
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

    expect(res).toEqual({ key: ENTITY_KEY, txHash: TX_HASH })
    // The wallet was actually asked to switch and to send the Arkiv tx.
    expect(methods).toContain('wallet_switchEthereumChain')
    expect(methods).toContain('eth_sendTransaction')
    expect(String(sentTx.to).toLowerCase()).toBe(ARKIV_ADDRESS)
    // A public reply never seals, and every stage names its real step.
    expect(stages).toEqual(['preparing', 'switching', 'signing', 'done'])
    expect(writeProgressLabel({ stage: 'preparing' })).not.toMatch(/sealing/i)
    expect(pendingProgressLabel('signing')).toMatch(/confirm in your wallet/)
    expect(pendingProgressLabel(undefined)).toMatch(/not posted yet/)
  })
})
