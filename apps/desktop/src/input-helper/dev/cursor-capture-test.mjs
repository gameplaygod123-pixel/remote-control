// ISOLATION harness for cursorCapture.ts -- run on the REAL Windows agent to
// verify the koffi GetCursorInfo / LoadCursorW FFI BEFORE it ships live (golden
// rule #1: a bad koffi signature segfaults uncatchably, so prove it standalone,
// exactly like input-service/dev/phase2-spawn). It bundles the real module with
// esbuild (no separate reimplementation to drift) and prints every cursor-shape
// change for ~30s.
//
// Run from apps/desktop (needs koffi installed, i.e. a normal agent checkout):
//   node src/input-helper/dev/cursor-capture-test.mjs
//
// EXPECTED: hover different UI and watch the logged shape follow --
//   empty desktop / most UI -> default
//   a text field / editable text -> text
//   a hyperlink / button        -> pointer
//   a window edge (resize)      -> ew-resize / ns-resize / nwse-resize / nesw-resize
//   during a busy op            -> wait / progress
//   cursor hidden (some video/games) -> none
// If it prints shapes that track what you see, the FFI is good. If it CRASHES
// (segfault / exit with no error), the struct layout or a signature is wrong --
// do NOT ship; report the exact koffi error.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HELPER = resolve(__dirname, '..') // input-helper/

async function bundle() {
  const viteRequire = createRequire(require.resolve('vite'))
  const esbuild = viteRequire('esbuild')
  const outfile = join(HELPER, '../..', '.verify-tmp', 'cursor-capture.cjs')
  mkdirSync(dirname(outfile), { recursive: true })
  const entry = `export { startCursorCapture } from ${JSON.stringify(join(HELPER, 'cursorCapture.ts'))}`
  await esbuild.build({
    stdin: { contents: entry, resolveDir: HELPER, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // koffi is a native addon -- don't try to bundle it, require it at runtime.
    external: ['koffi'],
    outfile,
    logLevel: 'error'
  })
  return require(outfile)
}

bundle()
  .then(({ startCursorCapture }) => {
    console.log(`platform=${process.platform} -- starting cursor capture for 30s...`)
    if (process.platform !== 'win32') {
      console.log(
        'NOTE: non-win32 -> startCursorCapture is a no-op by design (nothing will print).'
      )
    }
    let count = 0
    const handle = startCursorCapture((shape) => {
      count++
      console.log(`  [${new Date().toISOString().slice(11, 23)}] shape -> ${shape}`)
    })
    setTimeout(() => {
      handle.stop()
      console.log(`\nDONE. ${count} shape change(s) observed.`)
      console.log(
        count > 0
          ? 'PASS ✅ (FFI ran, shapes tracked)'
          : 'NO CHANGES — did the cursor move over varied UI? (or the FFI silently no-opped)'
      )
      process.exit(0)
    }, 30_000)
  })
  .catch((e) => {
    console.error('setup failed:', e)
    process.exit(2)
  })
