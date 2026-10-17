'use client'

import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { CHAIN_LABEL, VARIANT_TO_EIP155, type BoardGate } from '@fairhaven/board-core'
import { useMyMembership, useUnlock } from '@/hooks/useBoard'
import { useMounted } from '@/hooks/useMounted'
import { tokenIdentity } from '@/lib/evm'
import { env } from '@/lib/env'
import { modal } from '@/lib/wallet'

export interface FrostAction {
  /** One line under the frost, e.g. "Members only · hold ≥ 1 BACK on Base · connect wallet". */
  label: string
  /** What clicking the frost does. */
  run: () => void
  /** Short verb for the trailing link. */
  verb: string
}

/**
 * Explains a frosted element to whoever is looking at it, and turns the frost
 * itself into the next step: connect, unlock, or acquire. One hook, used by
 * sealed text and sealed media alike, so the message is identical everywhere.
 */
export function useFrostAction(gate: BoardGate, state: 'locked' | 'unlocking' | 'failed' | 'foreign', reason?: string, foreignHref?: string): FrostAction {
  const { isConnected } = useAccount()
  const mounted = useMounted()
  const me = useMyMembership(gate)
  const { unlock, busy, canUnlock } = useUnlock(gate)
  const chainId = VARIANT_TO_EIP155[gate.chain]
  const ident = useQuery({ queryKey: ['ident', chainId, gate.tokenAddress], queryFn: () => tokenIdentity(chainId, gate.tokenAddress), staleTime: Infinity })
  const token = ident.data?.symbol || ident.data?.name || `${gate.tokenAddress.slice(0, 6)}…${gate.tokenAddress.slice(-4)}`
  const need = `hold ≥ ${gate.threshold.toString()} ${token} on ${CHAIN_LABEL[gate.chain]}`
  const toGate = () => document.getElementById('gate')?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  // Static until mounted: connection state differs between SSR and browser.
  if (!mounted) {
    return { label: 'Members only', verb: '', run: () => undefined }
  }
  if (state === 'foreign') {
    return { label: `Sealed by another Haven app (${reason ?? 'other protocol version'})`, verb: 'open in haven-dapp', run: () => window.open(foreignHref ?? env.havenDappUrl, '_blank', 'noreferrer') }
  }
  if (state === 'failed') {
    return { label: `Could not open: ${reason ?? 'unknown error'}`, verb: 'retry', run: () => unlock() }
  }
  if (state === 'unlocking' || busy) {
    return { label: busy ?? 'Opening…', verb: '', run: () => undefined }
  }
  if (!isConnected) {
    return { label: `Members only · ${need}`, verb: 'connect wallet', run: () => (modal ? modal.open() : toGate()) }
  }
  if (me.isLoading) {
    return { label: `Members only · ${need}`, verb: 'checking…', run: toGate }
  }
  if (me.data?.member) {
    return { label: 'Members only · you hold the token', verb: canUnlock ? 'sign to unlock (no gas, once a month)' : 'unlock', run: () => unlock() }
  }
  return { label: `Members only · you hold ${me.data?.balance.toString() ?? '0'} of ${gate.threshold.toString()} ${token}`, verb: `get ${token}`, run: toGate }
}

export function FrostCaptionLine({ action }: { action: FrostAction }) {
  return (
    <div className="frost-caption">
      🔒 {action.label}
      {action.verb && (
        <>
          {' · '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              action.run()
            }}
          >
            {action.verb}
          </a>
        </>
      )}
    </div>
  )
}
