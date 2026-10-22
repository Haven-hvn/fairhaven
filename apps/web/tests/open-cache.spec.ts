import { describe, expect, it } from 'vitest'
import { clearOpened, getSealed, setSealed } from '../src/lib/open-cache'

describe('sealed byte cache', () => {
  it('keeps fetched sealed bytes for an open retry and clears on disconnect', () => {
    const bytes = new Uint8Array([1, 2, 3])
    setSealed('baga-piece', bytes)
    expect(getSealed('baga-piece')).toBe(bytes)
    expect(getSealed('other')).toBeUndefined()
    clearOpened()
    expect(getSealed('baga-piece')).toBeUndefined()
  })
})
