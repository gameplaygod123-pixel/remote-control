// Phase 1 harness — prove the elevated-input TRANSPORT + FRAMING + FALLBACK
// while still medium integrity, before any token/SYSTEM work (plan phase 1).
//
// It uses the REAL helper client (input-helper/serviceClient: maybeForwardInput/
// startServiceClient — the exact functions input-helper/index.ts calls) and
// spawns the REAL built injector (out/main/input-injector.js), so this exercises
// production transport code, not a copy. Verification is automated via
// GetCursorPos: when the injector is up the harness does NOT inject locally, so
// any cursor movement proves the message travelled helper --pipe--> injector -->
// SendInject. Mirrors the helper's fallback contract: if maybeForwardInput()
// returns false, inject locally.
//
// Run (from apps/desktop, PR_INPUT_SERVICE=1 is set by the launcher):
//   scripts\phase1.ps1 decoder|forward|fallback|framing|all
//
// Stages:
//   decoder  — offline FrameDecoder unit test (partial / coalesced / corrupt).
//   forward  — spawn injector, forward moves, verify the injector moved the cursor.
//   fallback — spawn injector, forward, KILL it mid-stream, verify local inject
//              keeps the cursor alive (the critical SAFETY test).
//   framing  — live rapid drag (forces pipe coalescing), verify no desync.

import koffi from 'koffi'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startServiceClient, maybeForwardInput } from '../../input-helper/serviceClient'
import { injectRaw } from '../rawInject'
import { FrameDecoder, encodeFrame } from '../protocol'
import type { RemoteInputMessage } from '../../renderer/src/shared/input/inputProtocol'

if (process.platform !== 'win32') {
  console.error('Windows only.')
  process.exit(1)
}
if (process.env.PR_INPUT_SERVICE !== '1') {
  console.error('PR_INPUT_SERVICE must be 1 (the launcher sets it). Aborting.')
  process.exit(1)
}

const INJECTOR = resolve(process.cwd(), 'out/main/input-injector.js')
const INJECTOR_LOG = join(tmpdir(), 'input-service.log')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---- read-only cursor probe (own struct name; no rawInject registry clash) ----
/* eslint-disable @typescript-eslint/no-explicit-any */
let getCursorPos: any = null
let getSystemMetrics: any = null
function ensureProbe(): void {
  if (getCursorPos) return
  const user32 = koffi.load('user32.dll')
  koffi.struct('POINT_P1', { x: 'int32', y: 'int32' })
  getCursorPos = user32.func('bool GetCursorPos(_Out_ POINT_P1 *pt)')
  getSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)')
}
function vdesk(): { x: number; y: number; w: number; h: number } {
  ensureProbe()
  return {
    x: getSystemMetrics(76),
    y: getSystemMetrics(77),
    w: getSystemMetrics(78),
    h: getSystemMetrics(79)
  }
}
function cursor(): { x: number; y: number } {
  ensureProbe()
  const pt = { x: 0, y: 0 }
  getCursorPos(pt)
  return pt
}
const move = (x: number, y: number): RemoteInputMessage => ({ t: 'move', x, y }) as RemoteInputMessage

function injectorLogTail(n = 12): string {
  try {
    const lines = readFileSync(INJECTOR_LOG, 'utf8').trimEnd().split(/\r?\n/)
    return lines.slice(-n).map((l) => '    | ' + l).join('\n')
  } catch {
    return '    | (no injector log yet)'
  }
}

// Spawn the built injector as a normal user-session process (Phase 1 = medium
// integrity; koffi loads inside it on the first message). Returns the child.
function spawnInjector(): ChildProcess {
  const child = spawn(process.execPath, [INJECTOR], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  })
  child.stdout?.on('data', (d) => process.stdout.write(`    [injector stdout] ${d}`))
  child.stderr?.on('data', (d) => process.stdout.write(`    [injector stderr] ${d}`))
  child.on('exit', (code, sig) => console.log(`    [injector exited code=${code} signal=${sig}]`))
  return child
}

// -------------------------------------------------------------------- decoder
function stageDecoder(): void {
  console.log('\n=== STAGE: FrameDecoder (offline, deterministic) ===')
  const msgs: RemoteInputMessage[] = [
    move(0.1, 0.2),
    { t: 'down', button: 'left' } as RemoteInputMessage,
    { t: 'up', button: 'left' } as RemoteInputMessage,
    { t: 'wheel', dy: 3 } as RemoteInputMessage,
    { t: 'keydown', code: 'ControlLeft' } as RemoteInputMessage,
    { t: 'keyup', code: 'KeyC' } as RemoteInputMessage,
    { t: 'text', text: 'สวัสดี hello 123!' } as RemoteInputMessage
  ]
  const whole = Buffer.concat(msgs.map(encodeFrame))
  let pass = 0
  let fail = 0
  const expect = JSON.stringify(msgs)

  // A) one push
  {
    const d = new FrameDecoder()
    const got = d.push(whole)
    const ok = JSON.stringify(got) === expect
    console.log(`  A one-shot push: ${ok ? 'PASS' : 'FAIL'} (${got.length}/${msgs.length})`)
    ok ? pass++ : fail++
  }
  // B) byte-by-byte (partial-tail path)
  {
    const d = new FrameDecoder()
    const got: RemoteInputMessage[] = []
    for (const b of whole) got.push(...d.push(Buffer.from([b])))
    const ok = JSON.stringify(got) === expect
    console.log(`  B byte-by-byte: ${ok ? 'PASS' : 'FAIL'} (${got.length}/${msgs.length})`)
    ok ? pass++ : fail++
  }
  // C) random splits, 200 iterations
  {
    let allOk = true
    for (let it = 0; it < 200; it++) {
      const d = new FrameDecoder()
      const got: RemoteInputMessage[] = []
      let i = 0
      while (i < whole.length) {
        const n = 1 + Math.floor(Math.random() * 7)
        got.push(...d.push(whole.subarray(i, i + n)))
        i += n
      }
      if (JSON.stringify(got) !== expect) {
        allOk = false
        break
      }
    }
    console.log(`  C random splits x200: ${allOk ? 'PASS' : 'FAIL'}`)
    allOk ? pass++ : fail++
  }
  // D) coalesced pair then a partial third
  {
    const d = new FrameDecoder()
    const two = Buffer.concat([encodeFrame(msgs[0]), encodeFrame(msgs[1])])
    const third = encodeFrame(msgs[2])
    const got = [...d.push(Buffer.concat([two, third.subarray(0, 2)])), ...d.push(third.subarray(2))]
    const ok = JSON.stringify(got) === JSON.stringify(msgs.slice(0, 3))
    console.log(`  D coalesced+split boundary: ${ok ? 'PASS' : 'FAIL'} (${got.length}/3)`)
    ok ? pass++ : fail++
  }
  // E) corrupt length prefix does not hang / wedge
  {
    const d = new FrameDecoder()
    const bad = Buffer.alloc(4)
    bad.writeUInt32LE(0x7fffffff, 0) // > MAX_FRAME
    const got = d.push(Buffer.concat([bad, encodeFrame(msgs[0])]))
    // decoder drops everything on a bad length; the point is it RETURNS (no hang)
    console.log(`  E corrupt length: returned ${got.length} msg(s), did not hang: PASS`)
    pass++
  }
  // F) malformed JSON frame is skipped, following frame survives
  {
    const d = new FrameDecoder()
    const junk = Buffer.from('not json', 'utf8')
    const badFrame = Buffer.allocUnsafe(4 + junk.length)
    badFrame.writeUInt32LE(junk.length, 0)
    junk.copy(badFrame, 4)
    const got = d.push(Buffer.concat([badFrame, encodeFrame(msgs[0])]))
    const ok = got.length === 1 && JSON.stringify(got[0]) === JSON.stringify(msgs[0])
    console.log(`  F malformed JSON skipped, next survives: ${ok ? 'PASS' : 'FAIL'}`)
    ok ? pass++ : fail++
  }
  console.log(`  decoder: ${pass} passed, ${fail} failed`)
}

// Wait until maybeForwardInput can actually write (socket connected).
async function waitConnected(timeoutMs = 4000): Promise<boolean> {
  const probe = move(0.5, 0.5)
  const deadline = Date.now() + timeoutMs
  startServiceClient()
  while (Date.now() < deadline) {
    if (maybeForwardInput(probe)) return true
    await sleep(100)
  }
  return false
}

// -------------------------------------------------------------------- forward
async function stageForward(): Promise<void> {
  console.log('\n=== STAGE: forward over pipe (injector moves the cursor) ===')
  const vd = vdesk()
  const child = spawnInjector()
  await sleep(900)
  const connected = await waitConnected()
  if (!connected) {
    console.log('  FAIL — helper never connected to the injector pipe.')
    child.kill()
    return
  }
  console.log('  helper connected. Forwarding moves (NO local fallback in this stage)...')
  const pts: Array<[number, number]> = [
    [0.5, 0.5],
    [0.2, 0.3],
    [0.8, 0.7],
    [0.35, 0.85],
    [0.65, 0.15]
  ]
  let ok = 0
  for (const [nx, ny] of pts) {
    const forwarded = maybeForwardInput(move(nx, ny))
    await sleep(140) // let the injector read + inject
    const c = cursor()
    const ex = vd.x + Math.round(nx * (vd.w - 1))
    const ey = vd.y + Math.round(ny * (vd.h - 1))
    const hit = Math.abs(c.x - ex) <= 3 && Math.abs(c.y - ey) <= 3
    console.log(
      `    move(${nx},${ny}) forwarded=${forwarded} -> cursor (${c.x},${c.y}) exp (${ex},${ey}) ${hit ? 'OK' : 'MISS'}`
    )
    if (forwarded && hit) ok++
  }
  console.log(`  ${ok}/${pts.length} moves crossed the pipe AND landed. Injector log:`)
  console.log(injectorLogTail())
  console.log(ok === pts.length ? '  PASS — transport + inject on a normal window works.' : '  CHECK — see misses above.')
  child.kill()
  await sleep(200)
}

// ------------------------------------------------------------------- fallback
async function stageFallback(): Promise<void> {
  console.log('\n=== STAGE: fallback on injector kill (SAFETY — mouse must not die) ===')
  const vd = vdesk()
  const child = spawnInjector()
  await sleep(900)
  if (!(await waitConnected())) {
    console.log('  FAIL — never connected; cannot test fallback.')
    child.kill()
    return
  }
  // Helper's REAL contract: forward, else inject locally.
  const drive = (nx: number, ny: number): 'pipe' | 'local' => {
    const m = move(nx, ny)
    if (maybeForwardInput(m)) return 'pipe'
    injectRaw(m)
    return 'local'
  }
  const verify = async (nx: number, ny: number): Promise<boolean> => {
    await sleep(140)
    const c = cursor()
    const ex = vd.x + Math.round(nx * (vd.w - 1))
    const ey = vd.y + Math.round(ny * (vd.h - 1))
    return Math.abs(c.x - ex) <= 3 && Math.abs(c.y - ey) <= 3
  }

  console.log('  BEFORE kill: driving 3 moves (expect path=pipe)...')
  for (const [nx, ny] of [[0.3, 0.3], [0.5, 0.5], [0.7, 0.6]] as Array<[number, number]>) {
    const path = drive(nx, ny)
    const hit = await verify(nx, ny)
    console.log(`    (${nx},${ny}) path=${path} landed=${hit}`)
  }

  console.log('  >>> KILLING injector mid-stream <<<')
  child.kill()
  // Let serviceClient notice the closed pipe (socket close -> sock=null).
  await sleep(400)

  console.log('  AFTER kill: driving 6 moves (expect path=local, cursor still alive)...')
  let localHits = 0
  let deadFrames = 0
  const afterPts: Array<[number, number]> = [
    [0.4, 0.4],
    [0.6, 0.55],
    [0.25, 0.7],
    [0.75, 0.35],
    [0.5, 0.8],
    [0.45, 0.5]
  ]
  for (const [nx, ny] of afterPts) {
    const path = drive(nx, ny)
    const hit = await verify(nx, ny)
    if (path === 'local' && hit) localHits++
    if (!hit) deadFrames++
    console.log(`    (${nx},${ny}) path=${path} landed=${hit}`)
  }
  // Allow at most the first post-kill frame to be lost to the dying socket
  // (written into a buffer the injector never read). The rest must be local hits.
  const pass = localHits >= afterPts.length - 1 && deadFrames <= 1
  console.log(
    `  local-inject hits after kill: ${localHits}/${afterPts.length}, dead frames: ${deadFrames}`
  )
  console.log(
    pass
      ? '  PASS — killing the injector fell back to local inject; the mouse never died.'
      : '  FAIL — too many frames were lost after the injector died (mouse would stall).'
  )
  child.kill()
  await sleep(200)
}

// -------------------------------------------------------------------- framing
async function stageFraming(): Promise<void> {
  console.log('\n=== STAGE: rapid drag framing (pipe coalescing must not desync) ===')
  const vd = vdesk()
  const child = spawnInjector()
  await sleep(900)
  if (!(await waitConnected())) {
    console.log('  FAIL — never connected.')
    child.kill()
    return
  }
  // 240 moves along a diagonal, blasted with no per-message await so the pipe
  // coalesces many frames per chunk — the exact stress that breaks a naive
  // reader. The injector's FrameDecoder must split them cleanly.
  const N = 240
  console.log(`  blasting ${N} moves back-to-back...`)
  let forwarded = 0
  let lastN: [number, number] = [0.5, 0.5]
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1)
    const nx = 0.15 + t * 0.7
    const ny = 0.85 - t * 0.7
    lastN = [nx, ny]
    if (maybeForwardInput(move(nx, ny))) forwarded++
    // tiny yield every 40 to avoid starving the event loop / socket flush
    if (i % 40 === 39) await sleep(4)
  }
  console.log(`  forwarded ${forwarded}/${N}. Draining...`)
  await sleep(700)
  const c = cursor()
  const ex = vd.x + Math.round(lastN[0] * (vd.w - 1))
  const ey = vd.y + Math.round(lastN[1] * (vd.h - 1))
  const hit = Math.abs(c.x - ex) <= 3 && Math.abs(c.y - ey) <= 3
  console.log(`  final cursor (${c.x},${c.y}) expected last-move (${ex},${ey}) ${hit ? 'OK' : 'MISS'}`)
  console.log('  injector log tail:')
  console.log(injectorLogTail())
  const noErr = !injectorLogTail(40).includes('inject error')
  console.log(
    hit && noErr
      ? '  PASS — framing survived a rapid drag; final position exact, no inject errors.'
      : '  CHECK — final position off or injector logged an error (possible desync).'
  )
  child.kill()
  await sleep(200)
}

async function main(): Promise<void> {
  const stage = (process.argv[2] || 'all').toLowerCase()
  console.log(`Phase 1 pipe harness — stage: ${stage}`)
  console.log(`injector: ${INJECTOR}`)
  try {
    switch (stage) {
      case 'decoder':
        stageDecoder()
        break
      case 'forward':
        await stageForward()
        break
      case 'fallback':
        await stageFallback()
        break
      case 'framing':
        await stageFraming()
        break
      case 'all':
        stageDecoder()
        await stageForward()
        await stageFraming()
        await stageFallback()
        break
      default:
        console.error(`unknown stage "${stage}" — decoder|forward|fallback|framing|all`)
        process.exit(1)
    }
  } catch (err) {
    console.error('\nHarness error (JS-level):', err)
    process.exit(1)
  }
  console.log('\nStage complete.')
  process.exit(0)
}

void main()
