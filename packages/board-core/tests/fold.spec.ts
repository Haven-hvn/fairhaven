import { describe, expect, it } from 'vitest'
import { bumpOrder, pageOf, tailOf } from '../src/fold.ts'
import vectors from './fixtures/board-order-vectors.json'

describe('bumpOrder (fixture-pinned)', () => {
  for (const v of vectors.vectors) {
    it(v.name, () => {
      const out = bumpOrder(v.threads, v.posts, v.params)
      expect(out.map((t) => t.key)).toEqual(v.expected)
    })
  }

  it('reply bookkeeping is complete and ordered', () => {
    const out = bumpOrder(
      [{ key: '0xaa', createdAt: 1 }],
      [
        { key: '0x03', rootRef: '0xAA', noBump: false, createdAt: 5 },
        { key: '0x01', rootRef: '0xaa', noBump: true, createdAt: 2 },
        { key: '0x02', rootRef: '0xaa', noBump: false, createdAt: 2 },
      ],
      { bumpLimit: 300, capacity: 10 },
    )
    expect(out).toHaveLength(1)
    const t = out[0]!
    expect(t.replyCount).toBe(3)
    expect(t.replies).toEqual(['0x01', '0x02', '0x03'])
    expect(t.bumpKey).toBe('0x03')
    expect(tailOf(t, 2)).toEqual(['0x02', '0x03'])
  })

  it('is deterministic across shuffles', () => {
    const threads = Array.from({ length: 40 }, (_, i) => ({ key: `0x${(i + 1).toString(16).padStart(4, '0')}`, createdAt: 1000 + (i % 7) }))
    const posts = Array.from({ length: 400 }, (_, i) => ({
      key: `0xf${i.toString(16).padStart(5, '0')}`,
      rootRef: threads[(i * 7) % threads.length]!.key,
      noBump: i % 11 === 0,
      createdAt: 2000 + ((i * 13) % 50),
    }))
    const a = bumpOrder(threads, posts, { bumpLimit: 9, capacity: 30 }).map((t) => t.key)
    const shuffled = [...posts].reverse()
    const b = bumpOrder([...threads].reverse(), shuffled, { bumpLimit: 9, capacity: 30 }).map((t) => t.key)
    expect(b).toEqual(a)
    expect(a).toHaveLength(30)
  })
})

describe('pageOf', () => {
  it('clamps page and reports pages', () => {
    const items = Array.from({ length: 23 }, (_, i) => i)
    expect(pageOf(items, 10, 1).items).toEqual(items.slice(0, 10))
    expect(pageOf(items, 10, 3).items).toEqual([20, 21, 22])
    expect(pageOf(items, 10, 99).page).toBe(3)
    expect(pageOf(items, 10, 0).page).toBe(1)
    expect(pageOf([], 10, 1).pages).toBe(1)
  })
})
