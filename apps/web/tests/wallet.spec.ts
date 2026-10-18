import { describe, expect, it } from 'vitest'
import { arkivNetwork, networks } from '../src/lib/wallet'

/**
 * Regression: the write path switches the wallet to the Arkiv chain, so that
 * chain must be one of the app's configured AppKit/wagmi networks. Without
 * it, AppKit answered the switch with "this app doesn't support your current
 * network" and the reply died before the entity signing prompt.
 */
describe('wallet networks', () => {
  it('include the Arkiv chain the write path switches to', () => {
    // Default RPC is the Arkiv tiramisu testnet (see `lib/env`).
    expect(arkivNetwork.id).toBe(7738577)
    expect(networks.map((n) => n.id)).toContain(arkivNetwork.id)
  })
})
