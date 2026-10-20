import { describe, expect, it } from 'vitest'
import { signTypedDataOnChain } from '../src/lib/aol'

/**
 * Regression: viem's `signTypedData` rejects when the EIP-712 domain's
 * `chainId` differs from the wallet's active chain ("Active chainId is
 * 0x2105 but received 0x1"). The wallet usually sits on the gate chain
 * (Base) while the Haven-AOL domain lives on the EIP-712 chain (mainnet by
 * default), so unlocks and membership receipts must switch there for the
 * signature and back afterwards.
 */
const args = { domain: { chainId: 1n }, types: {}, primaryType: 'T', message: {} }

function providerOn(startChain: string, opts: { refuseSwitch?: boolean; failRestore?: boolean } = {}) {
  const calls: Array<{ method: string; params?: unknown }> = []
  let current = startChain
  return {
    calls,
    current: () => current,
    request: async ({ method, params }: { method: string; params?: any }) => {
      calls.push({ method, params })
      if (method === 'eth_chainId') return current
      if (method === 'wallet_switchEthereumChain') {
        const next = params[0].chainId as string
        if (opts.refuseSwitch) throw Object.assign(new Error('user rejected switch'), { code: 4001 })
        if (opts.failRestore && next === startChain) throw new Error('restore failed')
        current = next
        return null
      }
      throw new Error(`unexpected ${method}`)
    },
  }
}

describe('signTypedDataOnChain', () => {
  it('switches from the gate chain to the domain chain, signs, and switches back', async () => {
    const provider = providerOn('0x2105')
    let signedOn: string | undefined
    const wallet = {
      account: { address: '0x0000000000000000000000000000000000000001' },
      transport: { value: provider },
      signTypedData: async () => {
        signedOn = provider.current()
        return '0x01'
      },
    }
    const sig = await signTypedDataOnChain(wallet, args, 1n)
    expect(sig).toBe('0x01')
    // Signed while on mainnet, wallet left back on Base.
    expect(signedOn).toBe('0x1')
    expect(provider.current()).toBe('0x2105')
    expect(provider.calls.map((c) => c.method)).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_switchEthereumChain',
    ])
  })

  it('does not switch when the wallet is already on the domain chain', async () => {
    const provider = providerOn('0x1')
    const wallet = {
      account: { address: '0x0000000000000000000000000000000000000001' },
      transport: { value: provider },
      signTypedData: async () => '0x01',
    }
    await signTypedDataOnChain(wallet, args, 1n)
    expect(provider.calls.map((c) => c.method)).toEqual(['eth_chainId'])
  })

  it('signs as-is when the wallet exposes no provider', async () => {
    const wallet = { account: { address: '0x1' }, signTypedData: async () => '0x01' }
    await expect(signTypedDataOnChain(wallet, args, 1n)).resolves.toBe('0x01')
  })

  it('fails the signature when the wallet refuses the switch, and keeps the chain', async () => {
    const provider = providerOn('0x2105', { refuseSwitch: true })
    const wallet = {
      account: { address: '0x0000000000000000000000000000000000000001' },
      transport: { value: provider },
      signTypedData: async () => '0x01',
    }
    await expect(signTypedDataOnChain(wallet, args, 1n)).rejects.toThrow(/did not switch to the signature chain/)
    expect(provider.current()).toBe('0x2105')
  })

  it('still returns the signature when switching back fails', async () => {
    const provider = providerOn('0x2105', { failRestore: true })
    const wallet = {
      account: { address: '0x0000000000000000000000000000000000000001' },
      transport: { value: provider },
      signTypedData: async () => '0x01',
    }
    await expect(signTypedDataOnChain(wallet, args, 1n)).resolves.toBe('0x01')
  })
})
