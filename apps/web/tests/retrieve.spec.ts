import { describe, expect, it } from 'vitest'
import { fetchResumable, withRetry } from '../src/lib/retrieve'

/**
 * Large clear files must survive a flaky gateway: resume from the last
 * byte via Range, restart cleanly when Range is ignored, and never
 * retry past an abort.
 */
const bytes = (...xs: number[]) => new Uint8Array(xs)

function streamOf(parts: Uint8Array[], failAfter?: number): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(c) {
      if (failAfter !== undefined && i === failAfter) {
        c.error(new Error('connection dropped'))
        return
      }
      if (i >= parts.length) {
        c.close()
        return
      }
      c.enqueue(parts[i++]!)
    },
  })
}

function fakeFetch(handler: (call: number, init?: RequestInit) => unknown): typeof fetch {
  let call = 0
  return (async (_url: unknown, init?: RequestInit) => handler(call++, init)) as typeof fetch
}

describe('fetchResumable', () => {
  it('resumes from the last byte after a dropped connection', async () => {
    const ranges: Array<string | undefined> = []
    const fetchFn = fakeFetch((call, init) => {
      ranges.push(new Headers(init?.headers).get('range') ?? undefined)
      if (call === 0) return { ok: true, status: 200, headers: new Headers({ 'content-length': '6' }), body: streamOf([bytes(1, 2), bytes(3, 4)], 1) }
      return { ok: true, status: 206, headers: new Headers({ 'content-length': '4' }), body: streamOf([bytes(3, 4, 5, 6)]) }
    })
    const out = await fetchResumable('https://gw/ipfs/x', { fetchFn, attempts: 3 })
    expect([...out]).toEqual([1, 2, 3, 4, 5, 6])
    expect(ranges[1]).toBe('bytes=2-')
  })

  it('restarts when the gateway ignores Range', async () => {
    const fetchFn = fakeFetch((call) =>
      call === 0
        ? { ok: true, status: 200, headers: new Headers({ 'content-length': '4' }), body: streamOf([bytes(9, 9)], 1) }
        : { ok: true, status: 200, headers: new Headers({ 'content-length': '4' }), body: streamOf([bytes(1, 2, 3, 4)]) },
    )
    await expect(fetchResumable('https://gw/ipfs/x', { fetchFn, attempts: 2 })).resolves.toEqual(bytes(1, 2, 3, 4))
  })

  it('does not retry a 4xx or past an abort', async () => {
    let calls = 0
    const fetchFn = fakeFetch(() => {
      calls++
      return { ok: false, status: 404, headers: new Headers(), body: null }
    })
    await expect(fetchResumable('https://gw/ipfs/x', { fetchFn, attempts: 3 })).rejects.toThrow(/404/)
    expect(calls).toBe(1)
    const ctl = new AbortController()
    ctl.abort()
    await expect(fetchResumable('https://gw/ipfs/x', { fetchFn, attempts: 3, signal: ctl.signal })).rejects.toThrow(/cancelled/)
  })
})

describe('withRetry', () => {
  it('retries once and surfaces the last error when exhausted', async () => {
    let n = 0
    await expect(
      withRetry(async () => {
        n++
        if (n < 2) throw new Error('flaky')
        return 7
      }),
    ).resolves.toBe(7)
    await expect(withRetry(async () => { throw new Error('down') }, { attempts: 2 })).rejects.toThrow(/down/)
  })
})
