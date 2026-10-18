import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Workspace test runner. Specs live in `<package>/tests/**` and are named
 * `*.spec.ts` (same convention as the dsh web3 stack). `@fairhaven/board-core`
 * resolves to source so specs run before any `tsdown` build.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@fairhaven/board-core': fileURLToPath(new URL('./packages/board-core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // Web specs live under `apps/web/tests` but need web-only deps (viem, the
    // Arkiv SDK), which the packages-only CI job does not install. They run
    // in the web CI job via `apps/web/vitest.config.ts` instead.
    include: ['packages/*/tests/**/*.spec.ts'],
    environment: 'node',
  },
})
