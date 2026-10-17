'use client'

import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import type { ReactNode } from 'react'
import { CHAIN_LABEL, VARIANT_TO_EIP155, epochEndUnix, type ResolvedBoard } from '@fairhaven/board-core'
import { useMyMembership, useUnlock } from '@/hooks/useBoard'
import { useMounted } from '@/hooks/useMounted'
import { tokenIdentity } from '@/lib/evm'
import { modal } from '@/lib/wallet'
import { Mark } from './Mark'

export function GateCard({ board }: { board: ResolvedBoard }) {
  const gate = board.ref.gate
  const chainId = VARIANT_TO_EIP155[gate.chain]
  const { isConnected } = useAccount()
  const mounted = useMounted()
  const me = useMyMembership(gate)
  const { unlocked, epoch, busy, error, unlock, canUnlock } = useUnlock(gate)
  const ident = useQuery({ queryKey: ['ident', chainId, gate.tokenAddress], queryFn: () => tokenIdentity(chainId, gate.tokenAddress), staleTime: Infinity })
  const tokenName = ident.data?.symbol || ident.data?.name || `${gate.tokenAddress.slice(0, 6)}…${gate.tokenAddress.slice(-4)}`
  const until = new Date(epochEndUnix(epoch) * 1000).toLocaleDateString()

  let copy: ReactNode
  if (!mounted) {
    copy = (
      <>
        Members hold the gate token on {CHAIN_LABEL[gate.chain]}.
        <small>Anyone can read what members chose to make public.</small>
      </>
    )
  } else if (!isConnected) {
    copy = (
      <>
        Members hold at least <b>{gate.threshold.toString()} {tokenName}</b> on {CHAIN_LABEL[gate.chain]}.
        <small>Anyone can read what members chose to make public. Connect a wallet that holds the token to read and post everything.</small>
        {modal && <button onClick={() => modal?.open()}>Connect wallet</button>}
      </>
    )
  } else if (me.isLoading) {
    copy = <>Checking your balance…</>
  } else if (me.data?.member && unlocked) {
    copy = (
      <>
        Member · unlocked until {until}
        <small>{board.title}</small>
      </>
    )
  } else if (me.data?.member) {
    copy = (
      <>
        You hold {me.data.balance.toString()} {tokenName}. <button disabled={!canUnlock || !!busy} onClick={() => unlock()}>{busy ?? 'Unlock for 30 days'}</button>
        <small>This proves you control this wallet. No transaction, no gas. One signature per month.</small>
        {error && <small className="error">{error}</small>}
      </>
    )
  } else {
    copy = (
      <>
        You hold {me.data?.balance.toString() ?? '0'} of {gate.threshold.toString()} {tokenName} on {CHAIN_LABEL[gate.chain]}.
        <a href={`https://mint.club/token/${chainId === 8453 ? 'base' : chainId === 1 ? 'mainnet' : chainId === 10 ? 'optimism' : chainId === 42161 ? 'arbitrum' : 'sepolia'}/${gate.tokenAddress}`} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>
          Get {tokenName}
        </a>{' '}
        <button onClick={() => me.refetch()}>Check again</button>
        <small>Until then you see only the public parts of each post.</small>
      </>
    )
  }

  return (
    <div className="gate" id="gate">
      {ident.data?.image ? (
        <img src={ident.data.image} alt="" />
      ) : (
        <div className="tile mark" style={{ width: 32, height: 32 }}>
          <Mark size={26} title={tokenName} />
        </div>
      )}
      <div className="copy">{copy}</div>
    </div>
  )
}
