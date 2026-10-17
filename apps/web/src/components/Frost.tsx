'use client'

import { frostLinesFor, type BoardGate } from '@fairhaven/board-core'
import { FrostCaptionLine, useFrostAction } from './FrostCaption'

/**
 * Frosted placeholder for sealed text. Height ∝ ciphertext bucket, so length
 * leaks only the bucket. The frost explains itself (why it is frosted, what
 * the viewer can do) and clicking it performs that step.
 */
export function FrostText({ sealedBytes, state, reason, gate }: { sealedBytes: number; state: 'locked' | 'unlocking' | 'failed' | 'foreign'; reason?: string; gate: BoardGate }) {
  const lines = frostLinesFor(sealedBytes)
  const action = useFrostAction(gate, state, reason)
  return (
    <div>
      <div
        className={`frost text${state === 'unlocking' ? ' shimmer' : ''}`}
        style={{ height: lines * 11, cursor: action.verb ? 'pointer' : 'default' }}
        title={action.label}
        aria-label={action.label}
        role="button"
        onClick={action.run}
      >
        <span className="lock">{state === 'failed' ? '✕' : state === 'foreign' ? '↗' : '🔒'}</span>
      </div>
      <FrostCaptionLine action={action} />
    </div>
  )
}
