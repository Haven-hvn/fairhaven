/**
 * Resumable byte retrieval for large clear media. Gateways support HTTP
 * Range, so a dropped connection resumes from the last received byte
 * instead of restarting a multi-megabyte file; a gateway that ignores
 * Range (200 instead of 206) simply restarts that attempt. No integrity
 * check lives here: content is addressed by CID/piece, so the address
 * is the check. Retries are bounded and abort always wins.
 */

export interface FetchResumableOptions {
  signal?: AbortSignal
  onProgress?: (received: number, total?: number) => void
  /** Total attempts, including the first. Default 3. */
  attempts?: number
  fetchFn?: typeof fetch
}

function abortError(): DOMException {
  return new DOMException('Fetch cancelled', 'AbortError')
}

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')
}

export async function fetchResumable(url: string, opts: FetchResumableOptions = {}): Promise<Uint8Array> {
  const fetchFn = opts.fetchFn ?? fetch
  const attempts = Math.max(1, opts.attempts ?? 3)
  const chunks: Uint8Array[] = []
  let received = 0
  let total: number | undefined

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) throw abortError()
    try {
      const headers: Record<string, string> = {}
      if (received > 0) headers.Range = `bytes=${received}-`
      const res = await fetchFn(url, { ...(opts.signal ? { signal: opts.signal } : {}), headers })
      if (!res.ok || !res.body) {
        const err = new Error(`gateway ${res.status}`)
        if (res.status >= 400 && res.status < 500) throw Object.assign(err, { noRetry: true })
        throw err
      }
      if (received > 0 && res.status === 200) {
        // Range ignored: start this attempt over.
        chunks.length = 0
        received = 0
      }
      const len = Number(res.headers.get('content-length') ?? 0)
      if (Number.isFinite(len) && len > 0) total = res.status === 206 ? received + len : len
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        opts.onProgress?.(received, total)
      }
      const out = new Uint8Array(received)
      let off = 0
      for (const c of chunks) {
        out.set(c, off)
        off += c.length
      }
      return out
    } catch (e) {
      if (isAbort(e, opts.signal)) throw abortError()
      if ((e as { noRetry?: boolean })?.noRetry) throw e
      if (attempt === attempts - 1) throw e
      // Brief pause before resuming; abort during the pause still wins.
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
    }
  }
  throw new Error('unreachable')
}

/** Retry an opaque download (e.g. Synapse piece fetch) with backoff. Abort wins; the last error surfaces. */
export async function withRetry<T>(fn: () => Promise<T>, opts: { attempts?: number; signal?: AbortSignal } = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 2)
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) throw abortError()
    try {
      return await fn()
    } catch (e) {
      if (isAbort(e, opts.signal)) throw abortError()
      last = e
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  throw last
}
