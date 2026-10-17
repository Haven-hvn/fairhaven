import { describe, expect, it } from 'vitest'
import { computeBoardStats, computeMyStats, sparkline } from '../src/stats.ts'
import type { BoardGate, PostRecord, ThreadRecord } from '../src/types.ts'

const gate: BoardGate = { chain: 'BaseMainnet', tokenAddress: `0x${'a'.repeat(40)}`, threshold: 1n }
const ME = `0x${'1'.repeat(40)}`
const OTHER = `0x${'2'.repeat(40)}`
const NOW = 1_800_000_000
// Block clock: current block 1_000_000 observed at NOW, 2 s blocks.
const clock = { currentBlock: 1_000_000, observedAtUnix: NOW, blockTimeS: 2 }
const blockAgo = (seconds: number) => 1_000_000 - Math.floor(seconds / 2)

function root(key: string, owner: string, ageS: number, extra: Partial<ThreadRecord> = {}): ThreadRecord {
  return { kind: 'thread', key, owner, board: 'x.y', source: 'board', grp: 'haven.board.thread', subject: 's', gate, gateVersion: 0, mime: 0, sealed: 0, sha256Ct: '0'.repeat(64), createdAt: blockAgo(ageS), ...extra }
}
function reply(key: string, owner: string, rootRef: string, ageS: number, extra: Partial<PostRecord> = {}): PostRecord {
  return { kind: 'post', key, owner, board: 'x.y', rootRef, noBump: false, gate, sealed: 0, sha256Ct: '0'.repeat(64), createdAt: blockAgo(ageS), ...extra }
}

describe('board stats', () => {
  const roots = [
    root('0x01', ME, 3 * 86400, { sealed: 1, mime: 8 }),
    root('0x02', OTHER, 10 * 86400, { source: 'haven', grp: 'haven.video.full', mime: 1, sealed: 2, expiresAt: 1_000_000 + 1000 }),
    root('0x03', OTHER, 3600),
  ]
  const replies = [
    reply('0x11', OTHER, '0x01', 2 * 86400, { sealed: 1 }),
    reply('0x12', ME, '0x01', 1800, { noBump: true }),
    reply('0x13', ME, '0x02', 600),
  ]

  it('aggregates counts, shares, mix, recency, expiry', () => {
    const s = computeBoardStats(roots, replies, clock, { days: 14 })
    expect(s.threads).toBe(3)
    expect(s.replies).toBe(3)
    expect(s.posters).toBe(2)
    expect(s.havenRoots).toBe(1)
    expect(s.sealedTextShare).toBeCloseTo(2 / 6)
    expect(s.threadsWithMedia).toBe(2)
    expect(s.sealedMediaShare).toBe(0.5)
    expect(s.mediaMix).toEqual([
      { mime: 'video/mp4', count: 1 },
      { mime: 'image/jpeg', count: 1 },
    ])
    expect(s.repliesPerThread).toEqual({ median: 1, max: 2, silent: 1 })
    expect(s.last24h).toBe(3) // root 0x03 + replies 0x12, 0x13
    expect(s.last7d).toBe(5)
    expect(s.expiringSoon).toBe(1)
    expect(s.oldestThreadAgeS).toBe(10 * 86400)
    expect(s.byDay).toHaveLength(14)
    expect(s.byDay.at(-1)).toEqual({ day: new Date(NOW * 1000).toISOString().slice(0, 10), threads: 1, replies: 2 })
    expect(s.byDay.reduce((n, d) => n + d.threads + d.replies, 0)).toBe(6)
  })

  it('computes my stats without ranking anyone else', () => {
    const m = computeMyStats(ME.toUpperCase(), roots, replies, clock)
    expect(m.threads).toBe(1)
    expect(m.replies).toBe(2)
    expect(m.noBumpReplies).toBe(1)
    expect(m.sealedTextShare).toBeCloseTo(1 / 3)
    expect(m.repliesReceived).toBe(1)
    expect(m.threadsWithOthersReplies).toBe(1)
    expect(m.firstPostUnix).toBe(NOW - 3 * 86400)
    expect(m.lastPostUnix).toBe(NOW - 600)
    const none = computeMyStats(`0x${'f'.repeat(40)}`, roots, replies, clock)
    expect(none.threads + none.replies).toBe(0)
    expect(none.firstPostUnix).toBeUndefined()
  })

  it('sparkline scales', () => {
    expect(sparkline([0, 4, 8])).toBe('▁▅█')
    expect(sparkline([])).toBe('')
  })
})
