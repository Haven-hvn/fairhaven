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

import { describeError, PREFETCH_MAX_BYTES } from '../src/lib/prefetch'

describe('open failure reporting and prefetch policy', () => {
  it('names DOMExceptions with empty messages instead of printing a blank reason', () => {
    expect(describeError(new DOMException('', 'OperationError'))).toBe('OperationError')
    expect(describeError(new Error('boom'))).toBe('boom')
  })
  it('caps background prefetch at 8 MiB', () => {
    expect(PREFETCH_MAX_BYTES).toBe(8 * 1024 * 1024)
  })
})

import { comparePageOrder, PREFETCH_CONCURRENCY } from '../src/lib/prefetch'

describe('prefetch ordering', () => {
  it('runs one at a time and sorts top-to-bottom', () => {
    expect(PREFETCH_CONCURRENCY).toBe(1)
    const jobs = [{ top: 900 }, { top: 100 }, { top: 500 }].sort(comparePageOrder)
    expect(jobs.map((j) => j.top)).toEqual([100, 500, 900])
  })
})
