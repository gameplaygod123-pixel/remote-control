// Phase 0 hardware harness for rawInject.ts — golden rule #1: verify the raw
// Win32 SendInput FFI on the real Windows machine BEFORE it goes near the
// pipe/service/token plumbing. A bad koffi struct/signature segfaults natively
// and JS try/catch can't catch it, so every stage prints "before"/"after"
// around each SendInput: if the process dies with no "after", that call is the
// culprit.
//
// Run (from apps/desktop):
//   node ../../node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/cli.mjs \
//        src/input-service/dev/phase0-rawinject.ts <stage>
// (a wrapper script scripts/phase0.ps1 does this for you)
//
// Stages: move | button | text | copy | wheel | all
//
// Auto-verified where possible: `move` reads back GetCursorPos; `copy` reads
// back the clipboard. `text`/`wheel`/`button` need the owner's eyes (that's the
// point — is the Thai text actually landing, which is where libnut went silent).

import koffi from 'koffi'
import { execFileSync } from 'node:child_process'
import {
  injectMouseMove,
  injectMouseButton,
  injectText,
  injectKey,
  injectWheel
} from '../rawInject'

if (process.platform !== 'win32') {
  console.error('This harness only runs on Windows (win32).')
  process.exit(1)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function countdown(seconds: number, msg: string): Promise<void> {
  console.log(`\n>>> ${msg}`)
  for (let s = seconds; s > 0; s--) {
    process.stdout.write(`    focusing in ${s}... \r`)
    await sleep(1000)
  }
  process.stdout.write('    GO                    \n')
}

// ---- read-only Win32 helpers for auto-verification (separate struct name from
// rawInject's INPUT_* so there's no koffi registry collision) ----
let getCursorPos: ((pt: { x: number; y: number }) => boolean) | null = null
let getSystemMetrics: ((n: number) => number) | null = null
function ensureProbe(): void {
  if (getCursorPos) return
  const user32 = koffi.load('user32.dll')
  koffi.struct('POINT_PROBE', { x: 'int32', y: 'int32' })
  getCursorPos = user32.func('bool GetCursorPos(_Out_ POINT_PROBE *pt)') as unknown as typeof getCursorPos
  getSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)') as unknown as typeof getSystemMetrics
}
// SM_*VIRTUALSCREEN — the whole multi-monitor bounding box (what VIRTUALDESK maps onto)
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79

function virtualDesktop(): { x: number; y: number; w: number; h: number } {
  ensureProbe()
  return {
    x: getSystemMetrics!(SM_XVIRTUALSCREEN),
    y: getSystemMetrics!(SM_YVIRTUALSCREEN),
    w: getSystemMetrics!(SM_CXVIRTUALSCREEN),
    h: getSystemMetrics!(SM_CYVIRTUALSCREEN)
  }
}
function cursor(): { x: number; y: number } {
  ensureProbe()
  const pt = { x: 0, y: 0 }
  getCursorPos!(pt)
  return pt
}

// ---- window helpers so the wheel stage can AUTO-verify scroll direction by
// reading classic Notepad's first-visible line (EM_GETFIRSTVISIBLELINE) instead
// of relying on eyeballing through a remote session ----
/* eslint-disable @typescript-eslint/no-explicit-any */
let findWindowW: ((cls: string | null, win: string | null) => any) | null = null
let findWindowExW: ((parent: any, after: any, cls: string | null, win: string | null) => any) | null =
  null
let sendMessageW: ((hwnd: any, msg: number, wParam: number, lParam: number) => number) | null = null
let setForegroundWindow: ((hwnd: any) => boolean) | null = null
let getWindowRect:
  | ((hwnd: any, r: { left: number; top: number; right: number; bottom: number }) => boolean)
  | null = null
function ensureWin(): void {
  if (findWindowW) return
  const user32 = koffi.load('user32.dll')
  koffi.struct('RECT_PROBE', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
  findWindowW = user32.func('void* FindWindowW(str16 c, str16 w)') as unknown as typeof findWindowW
  findWindowExW = user32.func(
    'void* FindWindowExW(void* p, void* a, str16 c, str16 w)'
  ) as unknown as typeof findWindowExW
  sendMessageW = user32.func(
    'intptr_t SendMessageW(void* h, uint32 m, uintptr_t wp, intptr_t lp)'
  ) as unknown as typeof sendMessageW
  setForegroundWindow = user32.func(
    'bool SetForegroundWindow(void* h)'
  ) as unknown as typeof setForegroundWindow
  getWindowRect = user32.func(
    'bool GetWindowRect(void* h, _Out_ RECT_PROBE* r)'
  ) as unknown as typeof getWindowRect
}
const EM_GETFIRSTVISIBLELINE = 0x00ce

// The clipboard can be transiently LOCKED by another process (Notepad just
// opening, Parsec's own sync, Explorer) → "Requested Clipboard operation did
// not succeed". Retry a few times. Force UTF-8 on the read so Thai comes back
// intact (the console's default OEM codepage would mangle it).
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
function getClipboard(): string {
  for (let i = 0; i < 5; i++) {
    try {
      return execFileSync(
        'powershell',
        ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'],
        { encoding: 'utf8' }
      ).replace(/\r?\n$/, '')
    } catch {
      sleepSync(150)
    }
  }
  return ''
}
function setClipboard(text: string): boolean {
  // clip.exe reads stdin and sets the clipboard (sentinel is ASCII, so codepage
  // is a non-issue); retry on the transient lock. Non-fatal — the sentinel only
  // helps distinguish "Ctrl+C didn't copy" from "copied the wrong thing".
  for (let i = 0; i < 5; i++) {
    try {
      execFileSync('clip', [], { input: text })
      return true
    } catch {
      sleepSync(150)
    }
  }
  console.log('  (warn) could not prime clipboard sentinel; continuing')
  return false
}

// ---------------------------------------------------------------------------

async function stageMove(): Promise<void> {
  console.log('\n=== STAGE: injectMouseMove (absolute + VIRTUALDESK) ===')
  const vd = virtualDesktop()
  console.log(`virtual desktop: origin (${vd.x},${vd.y}) size ${vd.w}x${vd.h}`)
  // A few normalized points; expected pixel = origin + round(n * (size-1)).
  const points: Array<[number, number, string]> = [
    [0.5, 0.5, 'CENTER'],
    [0.0, 0.0, 'TOP-LEFT'],
    [1.0, 1.0, 'BOTTOM-RIGHT'],
    [0.25, 0.75, 'quarter/three-quarter']
  ]
  for (const [nx, ny, label] of points) {
    const expX = vd.x + Math.round(nx * (vd.w - 1))
    const expY = vd.y + Math.round(ny * (vd.h - 1))
    process.stdout.write(`  move(${nx}, ${ny}) [${label}] -> SendInput... `)
    injectMouseMove(nx, ny)
    process.stdout.write('ok, ')
    await sleep(60)
    const c = cursor()
    const dx = Math.abs(c.x - expX)
    const dy = Math.abs(c.y - expY)
    // 3px tolerance absorbs Windows' 65535-grid rounding.
    const pass = dx <= 3 && dy <= 3
    console.log(
      `landed (${c.x},${c.y}) expected (${expX},${expY}) Δ(${dx},${dy}) ${pass ? 'PASS' : 'CHECK'}`
    )
    await sleep(500)
  }
  console.log('If CENTER passed, absolute + VIRTUALDESK mapping is correct.')
}

async function stageButton(): Promise<void> {
  console.log('\n=== STAGE: injectMouseButton ===')
  // Right-click at screen center pops a context menu = unambiguous visible proof
  // a button event landed and which button, and it is harmless. Then Escape.
  injectMouseMove(0.5, 0.5)
  await sleep(400)
  console.log('  RIGHT down -> up at center (a context menu should appear)')
  process.stdout.write('  right down... ')
  injectMouseButton('right', true)
  await sleep(60)
  process.stdout.write('right up... ')
  injectMouseButton('right', false)
  console.log('done')
  await sleep(1200)
  console.log('  dismiss menu with Escape')
  injectKey('Escape', true)
  await sleep(30)
  injectKey('Escape', false)
  await sleep(600)
  console.log('  LEFT down -> up at center')
  process.stdout.write('  left down... ')
  injectMouseButton('left', true)
  await sleep(60)
  process.stdout.write('left up... ')
  injectMouseButton('left', false)
  console.log('done')
  console.log('CONFIRM: did the right-click context menu appear at center?')
}

async function stageText(): Promise<void> {
  console.log('\n=== STAGE: injectText (Thai + English + digits + symbols) ===')
  const sample = 'สวัสดี hello 123!'
  await countdown(5, `Focus an EMPTY Notepad/text field. Typing: "${sample}"`)
  process.stdout.write('  injectText -> SendInput stream... ')
  injectText(sample)
  console.log('done')
  console.log(`CONFIRM: does the field now read exactly "${sample}"?`)
  console.log('(This is the exact spot libnut went silent — Thai must appear.)')
}

async function stageCopy(): Promise<void> {
  console.log('\n=== STAGE: Ctrl+C (held-modifier VK path) — auto-verified via clipboard ===')
  const sentinel = `__PHASE0_SENTINEL_${Date.now()}__`
  setClipboard(sentinel)
  console.log(`  clipboard primed with sentinel: ${sentinel}`)
  await countdown(5, 'Focus the Notepad that has text in it (I will Select-All then Ctrl+C).')

  // Select-all first so there's a selection to copy (Ctrl+A is a helper, not
  // under test). Then the exact spec'd Ctrl+C sequence.
  console.log('  Ctrl+A (select all)')
  injectKey('ControlLeft', true)
  await sleep(20)
  injectKey('KeyA', true)
  await sleep(20)
  injectKey('KeyA', false)
  await sleep(20)
  injectKey('ControlLeft', false)
  await sleep(150)

  console.log('  Ctrl+C: ControlLeft down, KeyC down, KeyC up, ControlLeft up')
  injectKey('ControlLeft', true)
  await sleep(20)
  injectKey('KeyC', true)
  await sleep(20)
  injectKey('KeyC', false)
  await sleep(20)
  injectKey('ControlLeft', false)
  await sleep(300)

  const now = getClipboard()
  if (now === sentinel) {
    console.log(`  clipboard STILL the sentinel -> Ctrl+C did NOT copy. FAIL`)
  } else {
    console.log(`  clipboard changed -> Ctrl+C worked. PASS`)
    console.log(`  copied text: "${now}"`)
  }
}

async function stageWheel(): Promise<void> {
  console.log('\n=== STAGE: injectWheel (manual watch) ===')
  await countdown(5, 'Focus a scrollable window (long web page / doc / Notepad).')
  // Contract (rawInject): positive dy = scroll DOWN (mirrors browser deltaY>0),
  // because mouseData = -dy*WHEEL_DELTA and negative wheelData = toward user = down.
  console.log('  injectWheel(3)  x3  -> scroll DOWN (content moves up)')
  for (let i = 0; i < 3; i++) {
    injectWheel(3)
    await sleep(200)
  }
  await sleep(1500)
  console.log('  injectWheel(-3) x3  -> scroll UP (content moves down)')
  for (let i = 0; i < 3; i++) {
    injectWheel(-3)
    await sleep(200)
  }
  console.log('CONFIRM by eye: (a) directions match the labels? (b) speed comfortable?')
}

// Auto-verified wheel: opens a 300-line file in classic Notepad and reads
// EM_GETFIRSTVISIBLELINE before/after each scroll — no eyeballing, works even
// through a remote session. (Classic Win32 Notepad only; the modern Store
// Notepad has no 'Edit' child, in which case we fall back to a manual watch.)
async function stageWheelVerify(): Promise<void> {
  console.log('\n=== STAGE: injectWheel — AUTO-verified via EM_GETFIRSTVISIBLELINE ===')
  ensureWin()
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { spawn } = await import('node:child_process')
  const file = path.join(os.tmpdir(), `phase0-scroll-${Date.now()}.txt`)
  fs.writeFileSync(
    file,
    Array.from({ length: 300 }, (_, i) => `line ${String(i + 1).padStart(3, '0')}`).join('\r\n')
  )
  const np = spawn('notepad', [file], { detached: true, stdio: 'ignore' })
  np.unref()
  await sleep(1500)

  const hwnd = findWindowW!('Notepad', null)
  const edit = hwnd ? findWindowExW!(hwnd, null, 'Edit', null) : null
  const firstVisible = (): number =>
    Number(sendMessageW!(edit, EM_GETFIRSTVISIBLELINE, 0, 0))

  if (!hwnd || !edit) {
    console.log('  could not find classic Notepad Edit control (modern Store Notepad?).')
    console.log('  Falling back to a manual watch — run `phase0.ps1 wheel` and eyeball it.')
    try {
      np.kill()
      fs.unlinkSync(file)
    } catch {
      /* best effort */
    }
    return
  }

  // Bring Notepad to the foreground so keyboard lands on it, then move the
  // cursor OVER the window and click — WM_MOUSEWHEEL routes to the window under
  // the pointer (Win10 "scroll inactive windows" default), so the cursor MUST
  // sit over Notepad or the wheel scrolls whatever else is underneath. Uses the
  // very move/click functions under test.
  setForegroundWindow!(hwnd)
  await sleep(200)
  const rect = { left: 0, top: 0, right: 0, bottom: 0 }
  getWindowRect!(hwnd, rect)
  const vd = virtualDesktop()
  const cx = (rect.left + rect.right) / 2
  const cy = (rect.top + rect.bottom) / 2
  console.log(`  notepad rect [${rect.left},${rect.top},${rect.right},${rect.bottom}] -> cursor (${Math.round(cx)},${Math.round(cy)})`)
  injectMouseMove((cx - vd.x) / (vd.w - 1), (cy - vd.y) / (vd.h - 1))
  await sleep(150)
  injectMouseButton('left', true); await sleep(40); injectMouseButton('left', false)
  await sleep(150)
  injectKey('ControlLeft', true)
  await sleep(15)
  injectKey('Home', true); await sleep(15); injectKey('Home', false) // Ctrl+Home -> top
  await sleep(15)
  injectKey('ControlLeft', false)
  await sleep(100)
  for (let i = 0; i < 6; i++) {
    injectKey('PageDown', true); await sleep(15); injectKey('PageDown', false); await sleep(40)
  }
  await sleep(200)

  const base = firstVisible()
  console.log(`  baseline first-visible line: ${base}`)

  console.log('  injectWheel(3) x3  (positive dy)...')
  for (let i = 0; i < 3; i++) { injectWheel(3); await sleep(120) }
  await sleep(200)
  const afterPos = firstVisible()

  console.log('  injectWheel(-3) x3 (negative dy)...')
  for (let i = 0; i < 3; i++) { injectWheel(-3); await sleep(120) }
  await sleep(200)
  const afterNeg = firstVisible()

  console.log(`  after injectWheel(+3)x3: first-visible ${base} -> ${afterPos} (Δ ${afterPos - base})`)
  console.log(`  after injectWheel(-3)x3: first-visible ${afterPos} -> ${afterNeg} (Δ ${afterNeg - afterPos})`)

  const posMoved = afterPos !== base
  const posDown = afterPos > base // higher first-visible line = scrolled DOWN
  if (!posMoved) {
    console.log('  FAIL/UNKNOWN — no scroll detected. Notepad likely was not foreground.')
  } else if (posDown && afterNeg < afterPos) {
    console.log('  PASS — positive dy scrolls DOWN, negative dy scrolls UP (matches browser deltaY).')
    // 3 calls × dy=3, and WHEEL_DELTA=120 means each dy-unit = one standard
    // wheel notch, so that's 9 notches total.
    const notches = 3 * 3
    const perNotch = Math.abs(afterPos - base) / notches
    console.log(
      `  feel: ${Math.abs(afterPos - base)} lines over ${notches} notches = ~${perNotch.toFixed(1)} lines/notch ` +
        `(Windows default is 3 — WHEEL_DELTA=120 gives one standard notch per dy-unit).`
    )
  } else {
    console.log('  CHECK — directions are not the expected (down for +dy). See deltas above.')
  }

  try {
    np.kill()
    fs.unlinkSync(file)
  } catch {
    /* best effort */
  }
}

// Combined, fully auto-verified: types the sample into a focused (empty) text
// field, then Select-All + Ctrl+C and reads the clipboard back — proving BOTH
// injectText (the Thai/Unicode path libnut silently no-op'd) AND the held-Ctrl
// VK path in one shot, with no eyeballing.
async function stageTextVerify(): Promise<void> {
  console.log('\n=== STAGE: injectText + Ctrl+C, AUTO-VERIFIED via clipboard ===')
  const sample = 'สวัสดี hello 123!'
  const sentinel = `__PHASE0_${Date.now()}__`
  setClipboard(sentinel)
  await countdown(5, 'Focus an EMPTY Notepad/text field (I clear it first, then type + copy).')

  // Clear whatever's there so the readback is exactly what we typed.
  injectKey('ControlLeft', true)
  await sleep(20)
  injectKey('KeyA', true); await sleep(20); injectKey('KeyA', false)
  await sleep(20)
  injectKey('ControlLeft', false)
  await sleep(50)
  injectKey('Delete', true); await sleep(20); injectKey('Delete', false)
  await sleep(150)

  process.stdout.write(`  injectText("${sample}") -> SendInput stream... `)
  injectText(sample)
  console.log('done')
  await sleep(300)

  injectKey('ControlLeft', true)
  await sleep(20)
  injectKey('KeyA', true); await sleep(20); injectKey('KeyA', false)
  await sleep(20)
  injectKey('KeyC', true); await sleep(20); injectKey('KeyC', false)
  await sleep(20)
  injectKey('ControlLeft', false)
  await sleep(300)

  const got = getClipboard()
  console.log(`  expected: ${JSON.stringify(sample)}`)
  console.log(`  clipboard:${JSON.stringify(got)}`)
  if (got === sample) {
    console.log('  PASS — Thai + English + digits + symbol all landed, and Ctrl+C copied them.')
  } else if (got === sentinel) {
    console.log('  FAIL — clipboard is still the sentinel: Ctrl+C did not copy (or field not focused).')
  } else {
    console.log('  MISMATCH — codepoint diff:')
    const max = Math.max(sample.length, got.length)
    for (let i = 0; i < max; i++) {
      const a = sample[i]
      const b = got[i]
      if (a !== b) {
        const ac = a ? 'U+' + a.charCodeAt(0).toString(16).padStart(4, '0') : '—'
        const bc = b ? 'U+' + b.charCodeAt(0).toString(16).padStart(4, '0') : '—'
        console.log(`    [${i}] expected ${JSON.stringify(a)}(${ac}) got ${JSON.stringify(b)}(${bc})`)
      }
    }
  }
}

async function main(): Promise<void> {
  const stage = (process.argv[2] || 'all').toLowerCase()
  console.log(`Phase 0 rawInject harness — stage: ${stage}`)
  try {
    switch (stage) {
      case 'move':
        await stageMove()
        break
      case 'button':
        await stageButton()
        break
      case 'text':
        await stageText()
        break
      case 'copy':
        await stageCopy()
        break
      case 'textv':
        await stageTextVerify()
        break
      case 'wheel':
        await stageWheel()
        break
      case 'wheelv':
        await stageWheelVerify()
        break
      case 'all':
        await stageMove()
        await stageButton()
        await stageText()
        await stageCopy()
        await stageWheel()
        break
      default:
        console.error(`unknown stage "${stage}" — use move|button|text|copy|wheel|all`)
        process.exit(1)
    }
  } catch (err) {
    console.error('\nHarness error (JS-level, NOT a segfault):', err)
    process.exit(1)
  }
  console.log('\nStage complete.')
}

void main()
