'use client'

import { useEffect, useState } from 'react'

/**
 * False on the server and on the client's first render, true after mount.
 * Wallet-dependent UI (connection state, AppKit modal) must render a static
 * placeholder until mounted: those states legitimately differ between SSR
 * and the browser, and rendering them early is a hydration mismatch (the
 * crash haven-dapp hit first — see its `useHydration` + mounted guards).
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  return mounted
}
