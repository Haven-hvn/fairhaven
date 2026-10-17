import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { realpathSync } from 'fs'

// Mirrors haven-dapp's build glue: static export, webpack (not Turbopack) so
// resolve.fallback applies to client bundles only, haven-aol SDK resolved from
// a git checkout, ethers' ws provider stubbed, RN async-storage stubbed.

const __dirname = dirname(fileURLToPath(import.meta.url))

const havenAolReal = (() => {
  try {
    return realpathSync(join(__dirname, 'haven-aol'))
  } catch {
    return join(__dirname, 'haven-aol')
  }
})()

function ethersWsAliasPaths(ethersRoot) {
  return [join(ethersRoot, 'lib.esm', 'providers', 'ws.js'), join(ethersRoot, 'lib.commonjs', 'providers', 'ws.js')]
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: true },
  productionBrowserSourceMaps: false,
  transpilePackages: ['haven-aol', '@icp-sdk/core', '@filoz/synapse-sdk', '@filoz/synapse-core', '@web3-storage/data-segment', '@fairhaven/board-core'],
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        path: false,
        os: false,
        crypto: false,
        stream: false,
        url: false,
        http: false,
        https: false,
        zlib: false,
        assert: false,
        buffer: false,
        events: false,
        util: false,
        ws: false,
      }
    }
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^ws$/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@base-org\/account/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@x402(\/.*)?$/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@walletconnect\/ethereum-provider/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@metamask\/connect-evm/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@solana\// }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@solana-program\// }),
    )
    const wsAliasEntries = {}
    for (const base of [join(__dirname, 'haven-aol'), havenAolReal]) {
      for (const p of ethersWsAliasPaths(join(base, 'packages', 'typescript', 'node_modules', 'ethers'))) wsAliasEntries[p] = join(__dirname, 'src/mocks/ws.js')
    }
    for (const p of ethersWsAliasPaths(join(__dirname, 'node_modules', 'ethers'))) wsAliasEntries[p] = join(__dirname, 'src/mocks/ws.js')
    config.resolve.alias = {
      ...config.resolve.alias,
      'haven-aol': join(__dirname, 'haven-aol/packages/typescript/src/index.ts'),
      '@': join(__dirname, 'src'),
      '@react-native-async-storage/async-storage': join(__dirname, 'src/mocks/react-native-async-storage.js'),
      ws: join(__dirname, 'src/mocks/ws.js'),
      ...wsAliasEntries,
    }
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.ts', '.js'] }
    console.error('WS ALIAS:', config.resolve.alias?.ws, 'isServer:', isServer)
    return config
  },
}

export default nextConfig
