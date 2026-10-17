'use client'

import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { applyFilters, filtersToJson, type Filterable, type HiddenReason } from '@fairhaven/board-core'
import { membership } from '@/lib/evm'
import { useFilters } from '@/store/filters'

/**
 * Hidden-reason map for a set of records under the reader's personal
 * filters. Keyed by record key; absent = visible. Re-evaluates when the
 * filter lists change (serialized into the query key).
 */
export function useHidden<T extends Filterable & { key: string }>(records: readonly T[] | undefined) {
  const filters = useFilters((s) => s.filters)
  const { address } = useAccount()
  const sig = JSON.stringify(filtersToJson(filters))
  const keys = (records ?? []).map((r) => `${r.key}:${r.owner}:${r.sealed}`).join('|')
  const q = useQuery({
    queryKey: ['hidden', sig, address ?? '', keys],
    queryFn: async () => {
      const out = new Map<string, HiddenReason>()
      if (!records) return out
      const annotated = await applyFilters(records, filters, { members: membership, ...(address ? { me: address } : {}) })
      for (const a of annotated) if (a.hidden) out.set(a.record.key, a.hidden)
      return out
    },
    enabled: !!records,
    staleTime: 60_000,
  })
  return { hidden: q.data ?? new Map<string, HiddenReason>(), showStubs: filters.showStubs }
}
