'use client'

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  EMPTY_FILTERS,
  filtersFromJson,
  filtersToJson,
  muteAddress,
  muteCommunity,
  unmuteAddress,
  unmuteCommunity,
  type BoardGate,
  type PersonalFilters,
} from '@fairhaven/board-core'

/**
 * Personal moderation lists. localStorage only; never leaves the device,
 * never on-chain. Thresholds are bigint, so we serialize through the
 * board-core JSON helpers rather than letting zustand stringify directly.
 */
interface FiltersState {
  filters: PersonalFilters
  muteAddress(a: string): void
  unmuteAddress(a: string): void
  muteCommunity(g: BoardGate): void
  unmuteCommunity(g: BoardGate): void
  setHideClear(v: boolean): void
  setShowStubs(v: boolean): void
  clear(): void
}

export const useFilters = create<FiltersState>()(
  persist(
    (set) => ({
      filters: EMPTY_FILTERS,
      muteAddress: (a) => set((s) => ({ filters: muteAddress(s.filters, a) })),
      unmuteAddress: (a) => set((s) => ({ filters: unmuteAddress(s.filters, a) })),
      muteCommunity: (g) => set((s) => ({ filters: muteCommunity(s.filters, g) })),
      unmuteCommunity: (g) => set((s) => ({ filters: unmuteCommunity(s.filters, g) })),
      setHideClear: (v) => set((s) => ({ filters: { ...s.filters, hideClear: v } })),
      setShowStubs: (v) => set((s) => ({ filters: { ...s.filters, showStubs: v } })),
      clear: () => set({ filters: EMPTY_FILTERS }),
    }),
    {
      name: 'fairhaven-filters',
      storage: createJSONStorage(() => localStorage, {
        replacer: (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      }),
      partialize: (s) => ({ filters: filtersToJson(s.filters) }) as unknown as FiltersState,
      merge: (persisted, current) => {
        const p = persisted as { filters?: unknown } | undefined
        return { ...current, filters: filtersFromJson(p?.filters) }
      },
    },
  ),
)
