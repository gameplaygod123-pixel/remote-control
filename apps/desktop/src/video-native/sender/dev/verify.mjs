// End-to-end verification of the REAL production sender helper (dev-only).
//
// Bundles src/video-native/sender/index.ts with esbuild (node-datachannel left
// external), forks it exactly as main/videoSenderHost.ts would, and drives it
// against dev/verify-receiver.mjs. The parent relays SDP/ICE using the FROZEN
// ipc.ts message shapes (evt:'offer'/'ice'/'stats' out; cmd:'start-session'/
// 'remote-answer'/'remote-ice' in), so this also checks the helper honours the
// contract. VIDEO_FAKE_SOURCE=1 substitutes synthetic frames so the whole ndc/
// RTP/PLI/stats path is provable on a machine without the (uncommitted) ffmpeg
// binary — the ffmpeg capture stage itself is already proven in phase0-B/phase1.
//
// Asserts: negotiation reaches connected, frames flow ~100%, the helper emits
// per-second stats, and a receiver PLI reaches the helper (item A) — confirmed by
// the helper's own log line "forcing IDR".
//
// Run from apps/desktop:  node src/video-native/sender/dev/verify.mjs

import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const DESKTOP = resolve(__dirname, '../../../..') // apps/desktop
const DURATION_MS = 5000

// Matches shared/contract.ts DEFAULT_VIDEO_CONFIG (inlined — this is a .mjs).
const CONFIG = {
  width: 1920, height: 1080, fps: 60, codec: 'h264',
  minBitrateKbps: 6000, startBitrateKbps: 20000, maxBitrateKbps: 30000,
  cursor: 'composited'
}

async function bundleHelper() {
  // esbuild is a transitive dep (via vite) — not resolvable directly from
  // apps/desktop, so borrow vite's resolution context to find it.
  const viteRequire = createRequire(require.resolve('vite'))
  const esbuild = viteRequire('esbuild')
  const outfile = join(DESKTOP, '.verify-tmp', 'video-sender.cjs')
  mkdirSync(dirname(outfile), { recursive: true })
  await esbuild.build({
    entryPoints: [join(DESKTOP, 'src/video-native/sender/index.ts')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    outfile, external: ['node-datachannel'], logLevel: 'error'
  })
  return outfile
}

function main(helperPath) {
  const logPath = join(tmpdir(), 'video-sender.log')
  // The helper only APPENDS; in production main/videoSenderHost.ts truncates the
  // log on spawn. This harness forks the helper directly, so it must do the same
  // -- otherwise stale lines from a previous run inflate the forced-IDR count.
  writeFileSync(logPath, '')
  console.log('[verify] forking real helper (VIDEO_FAKE_SOURCE=1) + receiver…')

  const helper = fork(helperPath, [], {
    execPath: process.execPath,
    env: { ...process.env, VIDEO_FAKE_SOURCE: '1', NDC_LOG_LEVEL: 'Error' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })
  const receiver = fork(join(__dirname, 'verify-receiver.mjs'), [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })

  const stats = []
  let lastProgress = { frames: 0, packets: 0 }
  let ready = false
  let report = null

  helper.on('message', (m) => {
    switch (m?.evt) {
      case 'ready':
        ready = true
        console.log('[verify] helper ready -> start-session')
        helper.send({ cmd: 'start-session', config: CONFIG })
        break
      case 'offer':
        receiver.send({ t: 'sig', kind: 'sdp', sdp: m.sdp, type: 'offer' })
        break
      case 'ice':
        receiver.send({ t: 'sig', kind: 'ice', candidate: m.candidate, mid: m.sdpMid })
        break
      case 'stats':
        stats.push(m.stats)
        break
      case 'fatal':
        console.error('[verify] helper FATAL:', m.message)
        break
    }
  })

  receiver.on('message', (m) => {
    if (m?.t === 'sig' && m.kind === 'sdp') helper.send({ cmd: 'remote-answer', sdp: m.sdp })
    else if (m?.t === 'sig' && m.kind === 'ice')
      helper.send({ cmd: 'remote-ice', candidate: m.candidate, sdpMid: m.mid, sdpMLineIndex: null })
    else if (m?.t === 'log') console.log('   ', m.line)
    else if (m?.t === 'progress') lastProgress = m
    else if (m?.t === 'report') report = m
  })

  setTimeout(() => receiver.send({ t: 'report-now' }), DURATION_MS)

  setTimeout(() => {
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const forcedCount = (log.match(/-> forcing IDR/g) ?? []).length
    const coalescedCount = (log.match(/coalesced/g) ?? []).length
    const r = report ?? lastProgress
    const lastStats = stats[stats.length - 1]

    const gates = {
      'helper booted + ready': ready,
      'negotiated + frames delivered': (r.frames ?? 0) >= 60, // ~1s @ 60fps min
      'helper emitted per-second stats': stats.length >= 3 && !!lastStats && lastStats.fps > 0,
      'PLI reached helper -> forced IDR (item A)': forcedCount >= 1 && (report?.pliTrue ?? 0) > 0,
      // MUST FIX: the in-cooldown PLI (frame 45) is coalesced, the two spaced ones
      // (40, 90) are honoured -> exactly 2 forced, >=1 coalesced.
      'PLI debounce: in-cooldown coalesced, spaced honoured': forcedCount === 2 && coalescedCount >= 1
    }

    console.log('\n================ SENDER HELPER VERIFY ================')
    console.log(`frames delivered      : ${r.frames}  (packets ${r.packets})`)
    console.log(`stats msgs from helper: ${stats.length}` + (lastStats ? `  last: ${lastStats.fps}fps ${lastStats.kbps}kbps ${lastStats.width}x${lastStats.height} codec=${lastStats.codec} captureMs=${lastStats.captureMs}` : ''))
    console.log(`receiver PLI calls    : ${report?.pliCalls ?? '?'} (returned true: ${report?.pliTrue ?? '?'})`)
    console.log(`helper forced IDRs    : ${forcedCount}  |  coalesced PLIs: ${coalescedCount}`)
    console.log('----')
    let pass = true
    for (const [name, ok] of Object.entries(gates)) {
      console.log(`  ${ok ? 'PASS ✅' : 'FAIL ❌'}  ${name}`)
      if (!ok) pass = false
    }
    console.log(`\nOVERALL: ${pass ? 'PASS ✅' : 'FAIL ❌'}  (log: ${logPath})`)
    console.log('=====================================================\n')

    helper.send({ cmd: 'stop-session' })
    helper.kill()
    receiver.kill()
    setTimeout(() => process.exit(pass ? 0 : 1), 150)
  }, DURATION_MS + 800)
}

bundleHelper()
  .then(main)
  .catch((e) => {
    console.error('[verify] setup failed:', e)
    process.exit(2)
  })
