import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  // Neutral: WebCrypto (`globalThis.crypto.subtle`) is the only runtime
  // dependency, present in browsers and Node ≥ 20.
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
})
