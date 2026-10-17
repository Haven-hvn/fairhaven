import { BLOCK_TIME_S, EPOCH_LENGTH_SECONDS } from './constants.ts'

/** Haven-AOL epoch for a unix time (seconds). Advisory; the canister decides. */
export function epochOf(unixSeconds: number): number {
  return Math.floor(unixSeconds / EPOCH_LENGTH_SECONDS)
}

export function currentEpoch(now: () => number = Date.now): number {
  return epochOf(Math.floor(now() / 1000))
}

export function epochEndUnix(epoch: number): number {
  return (epoch + 1) * EPOCH_LENGTH_SECONDS
}

export interface BlockClock {
  currentBlock: number
  /** Unix seconds when `currentBlock` was observed. */
  observedAtUnix: number
  blockTimeS?: number
}

/** Estimate the unix time of a block height from a recent observation. */
export function blockToUnix(block: number, clock: BlockClock): number {
  const bt = clock.blockTimeS ?? BLOCK_TIME_S
  return Math.round(clock.observedAtUnix - (clock.currentBlock - block) * bt)
}

/** Seconds a record has left; ≤ 0 means expired. */
export function remainingSeconds(expiresAtBlock: number | undefined, clock: BlockClock): number | undefined {
  if (expiresAtBlock === undefined) return undefined
  const bt = clock.blockTimeS ?? BLOCK_TIME_S
  return (expiresAtBlock - clock.currentBlock) * bt
}

/** Clamp a reply TTL so it never outlives its root (and stays a block multiple). */
export function clampPostTtl(postTtlS: number, rootRemainingS: number | undefined): number {
  let s = postTtlS
  if (rootRemainingS !== undefined && rootRemainingS > 0 && rootRemainingS < s) s = rootRemainingS
  s = Math.max(BLOCK_TIME_S, s - (s % BLOCK_TIME_S))
  return s
}
