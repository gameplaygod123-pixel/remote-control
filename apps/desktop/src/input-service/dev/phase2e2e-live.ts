// Phase 2 end-to-end LIVE proof. Unlike phase1 (which spawns its own injector)
// this connects the REAL helper serviceClient to the ALREADY-RUNNING injector
// that the installed PersonalRemoteInput service spawned into this session. It
// then forwards a couple of normalized 'move' messages over the pipe and reads
// GetCursorPos back to prove the full production chain is live:
//
//   serviceClient.maybeForwardInput  ->  \\.\pipe\personal-remote-input
//     ->  SYSTEM injector (session-in-session)  ->  SendInput  ->  real cursor
//
// PR_INPUT_SERVICE=1 must be set by the launcher BEFORE this loads (serviceClient
// reads it at import time). Run via scripts and tsx like the other dev harnesses.

import koffi from 'koffi'
import { startServiceClient, maybeForwardInput } from '../../input-helper/serviceClient'

const user32 = koffi.load('user32.dll')
// Registered by name so the GetCursorPos signature string can reference POINT*;
// koffi keeps it in its own registry, so we don't bind the return value.
koffi.struct('POINT', { x: 'long', y: 'long' })
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT* p)')
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int i)')

const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79

function cursor(): { x: number; y: number } {
  const p = {} as { x: number; y: number }
  GetCursorPos(p)
  return { x: p.x, y: p.y }
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const vx = GetSystemMetrics(SM_XVIRTUALSCREEN)
  const vy = GetSystemMetrics(SM_YVIRTUALSCREEN)
  const vw = GetSystemMetrics(SM_CXVIRTUALSCREEN)
  const vh = GetSystemMetrics(SM_CYVIRTUALSCREEN)
  console.log(`[e2e] PR_INPUT_SERVICE=${process.env.PR_INPUT_SERVICE}`)
  console.log(`[e2e] virtual desktop: origin(${vx},${vy}) size ${vw}x${vh}`)

  // Kick the connect and wait until the pipe is actually up (maybeForwardInput
  // returns false until then, which in production means "inject locally").
  startServiceClient()
  let connected = false
  for (let i = 0; i < 25; i++) {
    if (maybeForwardInput({ t: 'move', x: 0.5, y: 0.5 })) {
      connected = true
      break
    }
    await sleep(200)
  }
  if (!connected) {
    console.log('[e2e] FAIL: never connected to \\\\.\\pipe\\personal-remote-input (injector down?)')
    process.exit(2)
  }
  console.log('[e2e] connected to live injector pipe; forwarding moves...')

  const targets: Array<[number, number]> = [
    [0.25, 0.25],
    [0.75, 0.75],
    [0.5, 0.5]
  ]
  let allOk = true
  for (const [nx, ny] of targets) {
    const forwarded = maybeForwardInput({ t: 'move', x: nx, y: ny })
    await sleep(250)
    const got = cursor()
    const wantX = Math.round(vx + nx * vw)
    const wantY = Math.round(vy + ny * vh)
    // SendInput ABSOLUTE|VIRTUALDESK rounds through a 0..65535 grid, so allow a
    // couple px of quantization slop.
    const dx = Math.abs(got.x - wantX)
    const dy = Math.abs(got.y - wantY)
    const ok = forwarded && dx <= 3 && dy <= 3
    allOk = allOk && ok
    console.log(
      `[e2e] move(${nx},${ny}) forwarded=${forwarded} -> cursor(${got.x},${got.y}) ` +
        `want(${wantX},${wantY}) d(${dx},${dy}) ${ok ? 'OK' : 'MISS'}`
    )
  }
  console.log(allOk ? '[e2e] PASS — live service chain moves the real cursor.' : '[e2e] FAIL — see MISS above.')
  process.exit(allOk ? 0 : 1)
}

main().catch((e) => {
  console.error('[e2e] ERROR', e)
  process.exit(3)
})
