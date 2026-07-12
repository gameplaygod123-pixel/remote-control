// Auto-reapply the patched (NACK-emitting) node-datachannel after `pnpm install`
// (which restores the stock prebuilt and would silently disable silent loss repair).
// Chained after electron-builder install-app-deps in the desktop postinstall.
//
// SAFETY: darwin-arm64 ONLY (the patch is the Mac receiver's; the Windows agent uses
// stock ndc). Everywhere else -> no-op. NEVER throws / always exits 0 so it can't break
// `pnpm install` on Windows or a machine without codesign. Mirrors install.sh but is
// installer-safe (no load-verify, which could SIGKILL the installer on a bad binary).

import { createRequire } from 'node:module'
import { existsSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    process.exit(0) // Windows agent / other: keep stock ndc
  }
  const src = join(here, 'bin', 'node_datachannel.darwin-arm64.node')
  if (!existsSync(src)) {
    console.log('[ndc-nack] no committed binary, skip')
    process.exit(0)
  }
  // Resolve the actually-installed ndc native binary (robust to pnpm path layout).
  // Resolve the JS entry (package.json is often exports-blocked), then walk up to the
  // dir that holds build/Release/node_datachannel.node.
  const require = createRequire(import.meta.url)
  let entry
  try {
    entry = require.resolve('node-datachannel')
  } catch {
    console.log('[ndc-nack] node-datachannel not resolvable, skip')
    process.exit(0)
  }
  let dest = ''
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const cand = join(dir, 'build', 'Release', 'node_datachannel.node')
    if (existsSync(cand)) {
      dest = cand
      break
    }
  }
  if (!dest) {
    console.log('[ndc-nack] ndc native binary not found, skip')
    process.exit(0)
  }
  // Skip if already the patched one (same size as our committed binary).
  const backup = dest + '.orig-prebuilt'
  if (!existsSync(backup)) copyFileSync(dest, backup) // keep the stock for revert

  rmSync(dest, { force: true })
  copyFileSync(src, dest)
  try {
    // Re-codesign or macOS SIGKILLs on dlopen (Code Signature Invalid).
    execFileSync('codesign', ['--force', '--sign', '-', dest], { stdio: 'ignore' })
  } catch (e) {
    copyFileSync(backup, dest) // codesign failed -> restore stock so nothing crashes
    console.log('[ndc-nack] codesign failed, reverted to stock:', e?.message || e)
    process.exit(0)
  }
  console.log('[ndc-nack] patched node-datachannel installed (NACK-emitting)')
} catch (e) {
  console.log('[ndc-nack] skipped:', e?.message || e) // never fail the install
}
process.exit(0)
