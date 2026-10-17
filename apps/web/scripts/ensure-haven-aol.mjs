import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// `haven-aol` is not published to npm; like haven-dapp we alias a git checkout
// at ./haven-aol (clone https://github.com/Haven-hvn/haven-aol there, or
// symlink ../../../haven-aol-main) and build its TypeScript package.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sdkDir = join(root, 'haven-aol', 'packages', 'typescript')

if (!existsSync(join(sdkDir, 'package.json'))) {
  console.log('fairhaven-web: haven-aol SDK not found. Clone https://github.com/Haven-hvn/haven-aol to apps/web/haven-aol (or symlink an existing checkout).')
  process.exit(0)
}

execSync('npm ci', { cwd: sdkDir, stdio: 'inherit' })
