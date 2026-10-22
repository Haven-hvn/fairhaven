import { describe, expect, it } from 'vitest'
import { filecoinChainIdForGate, filbeamUrl } from '../src/lib/sealed-fetch'

const OWNER = '0x5C32469325d4093AB142dDDC1305F91d76e45141'

describe('sealed-fetch scoping', () => {
  it('maps testnet gates to calibration, mainnet gates to mainnet', () => {
    expect(filecoinChainIdForGate('EthSepolia')).toBe(314159)
    expect(filecoinChainIdForGate('EthMainnet')).toBe(314)
    expect(filecoinChainIdForGate('BaseMainnet')).toBe(314)
    expect(filecoinChainIdForGate(undefined)).toBe(314159)
  })
  it('builds owner-keyed FilBeam URLs per network', () => {
    expect(filbeamUrl(OWNER, 'baga123', 314159)).toBe('https://0x5c32469325d4093ab142dddc1305f91d76e45141.calibration.filbeam.io/baga123')
    expect(filbeamUrl(OWNER, 'baga123', 314)).toBe('https://0x5c32469325d4093ab142dddc1305f91d76e45141.filbeam.io/baga123')
  })
  it('rejects non-address owners', () => {
    expect(filbeamUrl('not-an-address', 'baga123', 314)).toBeUndefined()
  })
})
