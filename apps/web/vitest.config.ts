import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Web specs. Separate from the root config because these need web-only deps
 * (viem, `@arkiv-network/sdk`) that the packages-only CI job does not
 * install; the web CI job runs this config after a full install.
 * `@fairhaven/board-core` resolves to source, same as the root config.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@fairhaven/board-core': fileURLToPath(new URL('../../packages/board-core/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
