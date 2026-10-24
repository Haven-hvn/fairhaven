'use client'

import { useEffect, useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { TEXT_MAX_BYTES, SUBJECT_MAX_BYTES, utf8Bytes, type ResolvedBoard, type ThreadRecord } from '@fairhaven/board-core'
import { useMyMembership } from '@/hooks/useBoard'
import { submitReply, submitThread, writeProgressLabel, type WriteProgress } from '@/lib/post'
import { useSession } from '@/store/session'
import { Lock } from './Icons'

export interface PostFormProps {
  board: ResolvedBoard
  /** Present for replies. */
  root?: ThreadRecord
  currentBlock?: number
  /** Key to quote (set by clicking a post number). */
  quote?: string | null
  onQuoteConsumed?: () => void
  onPosted?: (key: string) => void
}

export function PostForm({ board, root, currentBlock, quote, onQuoteConsumed, onPosted }: PostFormProps) {
  const { address, isConnected } = useAccount()
  const { data: wc } = useWalletClient()
  const me = useMyMembership(board.ref.gate)
  const addPending = useSession((s) => s.addPending)
  const setPendingStage = useSession((s) => s.setPendingStage)
  const resolvePending = useSession((s) => s.resolvePending)
  const failPending = useSession((s) => s.failPending)

  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [sealText, setSealText] = useState(board.defaults.sealText)
  const [sealMedia, setSealMedia] = useState(board.defaults.sealMedia)
  const [noBump, setNoBump] = useState(false)
  const [progress, setProgress] = useState<WriteProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [parentKey, setParentKey] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (quote) {
      setText((t) => `${t}${t && !t.endsWith('\n') ? '\n' : ''}>>${quote.slice(2, 10)}\n`)
      setParentKey(quote)
      onQuoteConsumed?.()
    }
  }, [quote])

  const isReply = !!root
  const textBytes = utf8Bytes(text)
  const subjBytes = utf8Bytes(subject)
  const canPost = isConnected && !!wc && me.data?.member && text.trim().length > 0 && textBytes <= TEXT_MAX_BYTES && (isReply || (subject.trim().length > 0 && subjBytes <= SUBJECT_MAX_BYTES)) && !progress

  const submit = async () => {
    if (!canPost || !wc) return
    setError(null)
    const tempId = crypto.randomUUID()
    addPending({ tempId, board: board.ref.slug, ...(root ? { root: root.key } : {}), ...(subject ? { subject } : {}), text, sealedText: sealText, createdAtMs: Date.now() })
    const onProgress = (p: WriteProgress) => {
      setProgress(p)
      setPendingStage(tempId, p.stage)
    }
    try {
      const res = isReply
        ? await submitReply({ wallet: wc as never, board, root: root!, ...(parentKey ? { parentKey } : {}), text, sealText, noBump, ...(currentBlock !== undefined ? { currentBlock } : {}), onProgress })
        : await submitThread({ wallet: wc as never, board, subject, text, sealText, ...(file ? { file } : {}), sealMedia, onProgress })
      resolvePending(tempId, res.key)
      setText('')
      setSubject('')
      setFile(null)
      setNoBump(false)
      setParentKey(undefined)
      onPosted?.(res.key)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      failPending(tempId, msg)
      setError(msg)
    } finally {
      setProgress(null)
    }
  }

  const exposure = (
    <div className="exposure">
      {!isReply && (
        <>
          Subject · <b>public</b> &nbsp;·&nbsp;{' '}
        </>
      )}
      Text · <b>{sealText ? 'members' : 'public'}</b>
      {!isReply && file && (
        <>
          {' '}
          &nbsp;·&nbsp; File · <b>{sealMedia ? 'members' : 'public'}</b>
        </>
      )}
      {' '}&nbsp;·&nbsp; Posted as <b>{address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—'}</b>
    </div>
  )

  return (
    <table className="form">
      <tbody>
        {!isReply && (
          <tr>
            <td>Subject</td>
            <td>
              <input type="text" value={subject} maxLength={128} onChange={(e) => setSubject(e.target.value)} placeholder="public, ≤128 bytes" />
              {subjBytes > SUBJECT_MAX_BYTES && <span className="error"> too long</span>}
            </td>
          </tr>
        )}
        <tr>
          <td>
            Comment
            <label className="lock">
              <input type="checkbox" checked={sealText} onChange={(e) => setSealText(e.target.checked)} /> <Lock />
            </label>
          </td>
          <td>
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={isReply ? 'Reply. Quote with >>12345678. Lines starting with > are green.' : 'Say something.'} />
            <div className="exposure">
              {textBytes}/{TEXT_MAX_BYTES} bytes
            </div>
          </td>
        </tr>
        {!isReply && (
          <tr>
            <td>
              File
              <label className="lock">
                <input type="checkbox" checked={sealMedia} onChange={(e) => setSealMedia(e.target.checked)} /> <Lock />
              </label>
            </td>
            <td>
              <input type="file" accept="image/*,video/*,audio/*,.pdf,.txt,.md,.cbz,.cbr" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              {file && <span className="muted"> {file.name} ({Math.round(file.size / 1024)} KB, pinned to Filecoin via your wallet)</span>}
            </td>
          </tr>
        )}
        {isReply && (
          <tr>
            <td>Options</td>
            <td>
              <label>
                <input type="checkbox" checked={noBump} onChange={(e) => setNoBump(e.target.checked)} /> no bump
              </label>
              {parentKey && parentKey !== root?.key && <span className="muted"> · replying to {`>>${parentKey.slice(2, 10)}`}</span>}
            </td>
          </tr>
        )}
        <tr>
          <td></td>
          <td>
            {exposure}
            <button onClick={submit} disabled={!canPost}>
              {progress ? writeProgressLabel(progress) : isReply ? 'Reply' : 'Post'}
            </button>
            {!isConnected && <span className="muted"> connect a wallet to post</span>}
            {isConnected && me.data && !me.data.member && <span className="muted"> you do not hold the gate token</span>}
            {error && <div className="error">{error}</div>}
          </td>
        </tr>
      </tbody>
    </table>
  )
}
