// Automated check for the re-pair watchdog (../repairWatchdog.ts) -- proves it
// recovers a session stranded by a pair message lost during reconnect flapping,
// WITHOUT any lid-close cycling. Bundles the TS module with esbuild and drives it
// with a fake clock so every scenario is deterministic and runs in ~1s.
//
// Run from apps/desktop:
//   node src/renderer/src/controller/dev/verify-repair-watchdog.mjs

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const CONTROLLER = resolve(__dirname, '..') // controller/

let failures = 0
function check(name, cond) {
  console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}  ${name}`)
  if (!cond) failures++
}

async function bundle() {
  const viteRequire = createRequire(require.resolve('vite'))
  const esbuild = viteRequire('esbuild')
  const outfile = join(CONTROLLER, '../../../..', '.verify-tmp', 'repair-watchdog.cjs')
  mkdirSync(dirname(outfile), { recursive: true })
  const entry = `
    export { shouldNudgeRepair, startRepairWatchdog, REPAIR_WATCHDOG_INTERVAL_MS }
      from ${JSON.stringify(join(CONTROLLER, 'repairWatchdog.ts'))}
  `
  await esbuild.build({
    stdin: { contents: entry, resolveDir: CONTROLLER, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    logLevel: 'error'
  })
  return require(outfile)
}

// Deterministic fake clock: setIntervalFn/clearIntervalFn register callbacks that
// only fire when we explicitly tick(), so no real time passes.
function makeClock() {
  let nextId = 0
  const timers = new Map()
  return {
    setIntervalFn: (fn) => {
      const id = ++nextId
      timers.set(id, fn)
      return id
    },
    clearIntervalFn: (id) => timers.delete(id),
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) for (const fn of [...timers.values()]) fn()
    }
  }
}

const base = { pcConnected: false, inputConnected: false, signalingOpen: true, pendingApproval: false }

bundle()
  .then((m) => {
    const { shouldNudgeRepair, startRepairWatchdog, REPAIR_WATCHDOG_INTERVAL_MS } = m

    // ── Pure predicate truth table ──
    console.log('shouldNudgeRepair (predicate)')
    check('stuck (disconnected, WS up, no approval) -> nudge', shouldNudgeRepair(base) === true)
    check('pcConnected -> no nudge', shouldNudgeRepair({ ...base, pcConnected: true }) === false)
    check('inputConnected -> no nudge', shouldNudgeRepair({ ...base, inputConnected: true }) === false)
    check('WS down -> no nudge', shouldNudgeRepair({ ...base, signalingOpen: false }) === false)
    check('approval pending -> no nudge', shouldNudgeRepair({ ...base, pendingApproval: true }) === false)

    // ── Loop: keeps nudging while stuck, stops once connected ──
    console.log('startRepairWatchdog (loop)')
    {
      const clock = makeClock()
      const state = { ...base }
      let nudges = 0
      const wd = startRepairWatchdog({
        getState: () => state,
        sendPairRequest: () => nudges++,
        setIntervalFn: clock.setIntervalFn,
        clearIntervalFn: clock.clearIntervalFn
      })
      clock.tick(3)
      check('nudges every tick while stuck (3)', nudges === 3)
      state.pcConnected = true // paired
      clock.tick(3)
      check('stops nudging once connected', nudges === 3)
      wd.stop()
      state.pcConnected = false // stuck again, but watchdog stopped
      clock.tick(3)
      check('stop() halts the loop', nudges === 3)
    }

    // ── Never spams a human-approval wait / a down WS ──
    console.log('gating')
    {
      const clock = makeClock()
      const state = { ...base, pendingApproval: true }
      let nudges = 0
      startRepairWatchdog({
        getState: () => state,
        sendPairRequest: () => nudges++,
        setIntervalFn: clock.setIntervalFn,
        clearIntervalFn: clock.clearIntervalFn
      })
      clock.tick(3)
      check('no nudge while approval pending', nudges === 0)
      state.pendingApproval = false
      state.signalingOpen = false
      clock.tick(3)
      check('no nudge while WS down', nudges === 0)
    }

    // ── THE BUG REPRO: pair-request lost in a flap, agent registered but the
    //    controller got no reactive trigger. The watchdog must keep nudging until
    //    a nudge lands and pairs -- the old code stranded here for minutes. ──
    console.log('bug repro: lost pair-request during flap')
    {
      const clock = makeClock()
      const state = { ...base } // connected to signaling, NOT paired
      let agentOnline = false
      let nudges = 0
      startRepairWatchdog({
        getState: () => state,
        // A nudge only pairs once the agent is actually back (before that the
        // server answers "unknown device id" and nothing changes).
        sendPairRequest: () => {
          nudges++
          if (agentOnline) state.pcConnected = true
        },
        setIntervalFn: clock.setIntervalFn,
        clearIntervalFn: clock.clearIntervalFn
      })
      clock.tick(3) // agent still offline -> 3 nudges, still stranded
      check('keeps retrying while agent offline (3)', nudges === 3 && state.pcConnected === false)
      agentOnline = true
      clock.tick(1) // this nudge finally pairs
      check('recovers on the first nudge after agent returns', state.pcConnected === true)
      clock.tick(5) // no further nudges once paired
      check('quiesces after recovery (no runaway)', nudges === 4)
    }

    check('interval is 6s (sanity)', REPAIR_WATCHDOG_INTERVAL_MS === 6000)

    console.log(
      failures === 0
        ? '\nALL PASS ✅  re-pair watchdog recovers a lost-message strand (no lid needed)'
        : `\n${failures} FAILED ❌`
    )
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('verify-repair-watchdog crashed:', err)
    process.exit(1)
  })
