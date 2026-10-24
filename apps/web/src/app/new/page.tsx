'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useWalletClient } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { CHAIN_VARIANTS, CHAIN_LABEL, VARIANT_TO_EIP155, isBoardSlug, type BoardGate, type ChainVariant } from '@fairhaven/board-core'
import { submitBoardDef, writeProgressLabel, type WriteProgress } from '@/lib/post'
import { membership } from '@/lib/evm'

const DAY = 86400

export default function NewBoardPage() {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const { data: wc } = useWalletClient()
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [about, setAbout] = useState('')
  const [chain, setChain] = useState<ChainVariant>('BaseMainnet')
  const [token, setToken] = useState('')
  const [threshold, setThreshold] = useState('1')
  const [bumpLimit, setBumpLimit] = useState('300')
  const [capacity, setCapacity] = useState('150')
  const [pageSize, setPageSize] = useState('15')
  const [sealText, setSealText] = useState(true)
  const [sealMedia, setSealMedia] = useState(true)
  const [threadDays, setThreadDays] = useState('14')
  const [postDays, setPostDays] = useState('7')
  const [boardDays, setBoardDays] = useState('30')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<WriteProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  const gate: BoardGate | undefined = /^0x[0-9a-fA-F]{40}$/.test(token) && /^\d+$/.test(threshold) && BigInt(threshold) > 0n ? { chain, tokenAddress: token.toLowerCase(), threshold: BigInt(threshold) } : undefined
  const holds = useQuery({
    queryKey: ['new-holds', gate?.tokenAddress, gate?.chain, address],
    queryFn: async () => (gate && address ? membership.balance(gate, address) : 0n),
    enabled: !!gate && !!address,
  })
  const ok = isConnected && !!wc && !!gate && isBoardSlug(slug) && title.trim().length > 0 && (holds.data ?? 0n) >= (gate?.threshold ?? 1n) && !busy

  const submit = async () => {
    if (!ok || !gate || !wc) return
    setBusy(true)
    setError(null)
    try {
      await submitBoardDef({
        wallet: wc as never,
        board: slug,
        title,
        about,
        gate,
        bumpLimit: Number(bumpLimit),
        capacity: Number(capacity),
        pageSize: Number(pageSize),
        sealText,
        sealMedia,
        threadTtlS: Number(threadDays) * DAY,
        postTtlS: Number(postDays) * DAY,
        expiresIn: Number(boardDays) * DAY,
        onProgress: setProgress,
      })
      router.push(`/board?b=${encodeURIComponent(slug)}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <div>
      <h1 className="subject" style={{ margin: '8px 0 4px' }}>
        Define a board
      </h1>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        A board already exists for every gate. A definition names it, sets its ordering constants and defaults, and gives it a lifetime. You must hold the gate token. One Arkiv transaction from your wallet.
      </p>
      <table className="form">
        <tbody>
          <tr>
            <td>Slug</td>
            <td>
              <input type="text" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="conference.backchannel" />
              {slug && !isBoardSlug(slug) && <span className="error"> lowercase dot hierarchy, 2–4 labels</span>}
            </td>
          </tr>
          <tr>
            <td>Title</td>
            <td>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={128} />
            </td>
          </tr>
          <tr>
            <td>About</td>
            <td>
              <textarea value={about} onChange={(e) => setAbout(e.target.value)} style={{ height: 50 }} />
            </td>
          </tr>
          <tr>
            <td>Gate</td>
            <td>
              <select value={chain} onChange={(e) => setChain(e.target.value as ChainVariant)}>
                {CHAIN_VARIANTS.map((c) => (
                  <option key={c} value={c}>
                    {CHAIN_LABEL[c]} ({VARIANT_TO_EIP155[c]})
                  </option>
                ))}
              </select>{' '}
              <input type="text" value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="0x token (ERC-20 or ERC-721)" style={{ width: 'min(340px, calc(100vw - 260px))' }} /> ≥{' '}
              <input type="text" value={threshold} onChange={(e) => setThreshold(e.target.value.trim())} style={{ width: 80 }} />
              <div className="exposure">
                Raw <b>balanceOf</b> units. For an 18-decimal ERC-20 “1 token” is 1000000000000000000; thresholds are written as u256, so 18-decimal amounts are fine.
                {gate && address && holds.data !== undefined && <> You hold <b>{holds.data.toString()}</b>.</>}
              </div>
            </td>
          </tr>
          <tr>
            <td>Ordering</td>
            <td>
              bump limit <input type="text" value={bumpLimit} onChange={(e) => setBumpLimit(e.target.value)} style={{ width: 60 }} /> · capacity <input type="text" value={capacity} onChange={(e) => setCapacity(e.target.value)} style={{ width: 60 }} /> · per page{' '}
              <input type="text" value={pageSize} onChange={(e) => setPageSize(e.target.value)} style={{ width: 60 }} />
            </td>
          </tr>
          <tr>
            <td>Defaults</td>
            <td>
              <label>
                <input type="checkbox" checked={sealText} onChange={(e) => setSealText(e.target.checked)} /> seal text
              </label>{' '}
              <label>
                <input type="checkbox" checked={sealMedia} onChange={(e) => setSealMedia(e.target.checked)} /> seal files
              </label>
              <div className="exposure">Posters can override per post.</div>
            </td>
          </tr>
          <tr>
            <td>Lifetimes</td>
            <td>
              threads <input type="text" value={threadDays} onChange={(e) => setThreadDays(e.target.value)} style={{ width: 50 }} /> d · replies <input type="text" value={postDays} onChange={(e) => setPostDays(e.target.value)} style={{ width: 50 }} /> d · board{' '}
              <input type="text" value={boardDays} onChange={(e) => setBoardDays(e.target.value)} style={{ width: 50 }} /> d
              <div className="exposure">Enforced by Arkiv BTL. The board disappears with its definition.</div>
            </td>
          </tr>
          <tr>
            <td></td>
            <td>
              <button disabled={!ok} onClick={submit}>
                {progress ? writeProgressLabel(progress) : busy ? 'Preparing…' : 'Create board'}
              </button>
              {!isConnected && <span className="muted"> connect a wallet</span>}
              {gate && holds.data !== undefined && holds.data < gate.threshold && <span className="muted"> you do not hold the gate token</span>}
              {error && <div className="error">{error}</div>}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
