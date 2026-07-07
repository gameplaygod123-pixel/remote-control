// Track-2 STEP D / Phase 3 proof — secure-desktop FOLLOW. This validates the one
// thing STEP D added (the injector re-binding its thread to Winlogon around
// UAC/lock) WITHOUT needing a real paired agent: it just hosts the helper pipe
// (Fix A role split — medium host, SYSTEM injector connects) and forwards a
// harmless heartbeat move forever. Every forwarded frame makes the injector call
// syncInputDesktop(); when you LOCK the screen, its next call sees the input
// desktop flip to 'Winlogon', re-binds, and LOGS it — that log line is the proof.
//
//   serviceClient (HOST \\.\pipe\personal-remote-input, this process)
//     <- connect - SYSTEM injector (spawned by the installed task)
//   heartbeat move -> injector -> syncInputDesktop() [-> 'Winlogon'] -> SendInput
//
// HOW TO USE (run ELEVATED, with the SYSTEM task already installed via
// scripts/track2-e2e.ps1 so the injector is running):
//   1. run this; wait for "connected to live injector pipe".
//   2. press the PHYSICAL Win+L on the real keyboard to lock (don't fight the
//      cursor with the mouse — the heartbeat parks it at center). No password
//      needed: even a passwordless account shows the Winlogon secure desktop.
//   3. wait ~4s on the lock screen, then press any physical key / sign back in.
//   4. Ctrl+C here, then read C:\Windows\Temp\input-service.log and look for:
//        input desktop -> 'Winlogon' (was 'Default')      = PASS (followed in)
//        input desktop -> 'Default'  (was 'Winlogon')     = followed back out
//        SetThreadDesktop('Winlogon') failed, GetLastError=...  = the one to debug
//
// PR_INPUT_SERVICE=1 must be set BEFORE this loads (serviceClient reads it at
// import time). Run via tsx like the other harnesses.

import { startServiceClient, maybeForwardInput } from '../../input-helper/serviceClient'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  console.log(`[phase3] PR_INPUT_SERVICE=${process.env.PR_INPUT_SERVICE}`)
  if (process.env.PR_INPUT_SERVICE !== '1') {
    console.log('[phase3] FAIL: set PR_INPUT_SERVICE=1 before running (host is a no-op otherwise).')
    process.exit(2)
  }

  // Host the pipe and wait for the injector the installed SYSTEM task spawned.
  startServiceClient()
  let connected = false
  for (let i = 0; i < 50; i++) {
    if (maybeForwardInput({ t: 'move', x: 0.5, y: 0.5 })) {
      connected = true
      break
    }
    await sleep(200)
  }
  if (!connected) {
    console.log('[phase3] FAIL: injector never connected to \\\\.\\pipe\\personal-remote-input.')
    console.log('[phase3]   -> is the SYSTEM task running? install it with scripts\\track2-e2e.ps1 first.')
    process.exit(3)
  }

  console.log('[phase3] connected to live injector pipe.')
  console.log('[phase3] >>> NOW PRESS THE PHYSICAL Win+L KEY TO LOCK THE SCREEN. <<<')
  console.log('[phase3]     (use the real keyboard, not the mouse — the heartbeat parks the')
  console.log('[phase3]      cursor at center. No password needed to prove the follow.)')
  console.log('[phase3]     Wait ~4s locked, press any physical key to come back, then Ctrl+C')
  console.log('[phase3]     and read C:\\Windows\\Temp\\input-service.log for the Winlogon flip.')
  console.log('[phase3] forwarding a heartbeat every 750ms (cursor parks at center)...')

  // Park the cursor at the SAME center point each beat: the injector still calls
  // syncInputDesktop() before every inject (that's the whole point), but the
  // cursor doesn't jitter, so the physical Win+L / sign-in isn't disrupted.
  let n = 0
  for (;;) {
    const ok = maybeForwardInput({ t: 'move', x: 0.5, y: 0.5 })
    n++
    if (n % 2 === 0) {
      process.stdout.write(`\r[phase3] heartbeats sent: ${n}  forwarding=${ok}   `)
    }
    await sleep(750)
  }
}

main().catch((e) => {
  console.error('[phase3] ERROR', e)
  process.exit(4)
})
