'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Theme = 'daybreak' | 'parchment'

export interface PendingPost {
  /** Temporary id until the entity key is known. */
  tempId: string
  board: string
  root?: string
  subject?: string
  text: string
  sealedText: boolean
  createdAtMs: number
  key?: string
  error?: string
}

interface SessionState {
  theme: Theme
  setTheme(t: Theme): void
  /** Bumps whenever an epoch is unlocked so views re-open sealed fields. */
  unlockVersion: number
  bumpUnlock(): void
  pending: PendingPost[]
  addPending(p: PendingPost): void
  resolvePending(tempId: string, key: string): void
  failPending(tempId: string, error: string): void
  dropPending(tempId: string): void
}

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      theme: 'daybreak',
      setTheme: (theme) => set({ theme }),
      unlockVersion: 0,
      bumpUnlock: () => set((s) => ({ unlockVersion: s.unlockVersion + 1 })),
      pending: [],
      addPending: (p) => set((s) => ({ pending: [...s.pending, p] })),
      resolvePending: (tempId, key) => set((s) => ({ pending: s.pending.map((p) => (p.tempId === tempId ? { ...p, key } : p)) })),
      failPending: (tempId, error) => set((s) => ({ pending: s.pending.map((p) => (p.tempId === tempId ? { ...p, error } : p)) })),
      dropPending: (tempId) => set((s) => ({ pending: s.pending.filter((p) => p.tempId !== tempId) })),
    }),
    { name: 'fairhaven-session', partialize: (s) => ({ theme: s.theme }) },
  ),
)
