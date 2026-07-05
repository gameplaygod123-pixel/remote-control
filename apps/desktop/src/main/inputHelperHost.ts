import { ChildProcess, fork } from 'child_process'
import { join } from 'path'

// Spawns and supervises the agent's input-helper: a pure-Node child process
// (no Chromium, no Electron main-process message pump) that owns the WebRTC
// input data channels and injects mouse/keyboard directly via nut.js. See
// input-helper/index.ts and docs/native-input-plan.md for why this exists --
// in short, the Electron main process itself gets throttled along with the
// renderer when the agent window is hidden, so input has to live somewhere
// that throttling can't reach.
//
// execPath/env below is the same "run the Electron binary as plain Node"
// trick verified during investigation: it keeps native modules (node-
// datachannel, nut.js) on Electron's own ABI -- no separate Node toolchain or
// rebuild -- while getting a real, unthrottled Node process.

type HelperToMain =
  | { evt: 'ready' }
  | { evt: 'offer'; sdp: string }
  | { evt: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { evt: 'pong' }
  | { evt: 'fatal'; message: string }

export interface InputHelperCallbacks {
  onOffer: (sdp: string) => void
  onIce: (candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void
  // Fired when the helper crashes, hangs (misses a liveness ping), or fails
  // to ever report ready. Callers should treat any in-flight helper-backed
  // session as dead and fall back to the renderer input-channel path for the
  // next pairing -- see AgentView.tsx's use of isReady().
  onDown: () => void
}

const RESPAWN_DELAY_MS = 2_000
const PING_INTERVAL_MS = 10_000
const PONG_TIMEOUT_MS = 5_000

export interface InputHelperHost {
  isReady(): boolean
  startSession(): void
  stopSession(): void
  remoteAnswer(sdp: string): void
  remoteIce(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): void
  destroy(): void
}

export function startInputHelperHost(callbacks: InputHelperCallbacks): InputHelperHost {
  let child: ChildProcess | null = null
  let ready = false
  let destroyed = false
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let pongTimeout: ReturnType<typeof setTimeout> | undefined

  function clearTimers(): void {
    if (pingTimer) clearInterval(pingTimer)
    if (pongTimeout) clearTimeout(pongTimeout)
    pingTimer = undefined
    pongTimeout = undefined
  }

  function markDown(): void {
    if (!ready && !child) return // already down, avoid duplicate onDown() calls
    ready = false
    clearTimers()
    callbacks.onDown()
  }

  function spawn(): void {
    if (destroyed) return
    const helperPath = join(__dirname, 'input-helper.js')
    const proc = fork(helperPath, [], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      silent: false
    })
    child = proc

    proc.on('message', (msg: HelperToMain) => {
      switch (msg.evt) {
        case 'ready':
          ready = true
          pingTimer = setInterval(() => {
            proc.send({ cmd: 'ping' })
            pongTimeout = setTimeout(() => {
              // No pong within the window -- treat as hung, not just slow.
              proc.kill()
            }, PONG_TIMEOUT_MS)
          }, PING_INTERVAL_MS)
          break
        case 'pong':
          if (pongTimeout) clearTimeout(pongTimeout)
          break
        case 'offer':
          callbacks.onOffer(msg.sdp)
          break
        case 'ice':
          callbacks.onIce(msg.candidate, msg.sdpMid, msg.sdpMLineIndex)
          break
        case 'fatal':
          console.error('[input-helper] fatal:', msg.message)
          break
      }
    })

    proc.on('exit', () => {
      child = null
      markDown()
      if (!destroyed) setTimeout(spawn, RESPAWN_DELAY_MS)
    })
  }

  spawn()

  return {
    isReady: () => ready,
    startSession: () => child?.send({ cmd: 'start-session' }),
    stopSession: () => child?.send({ cmd: 'stop-session' }),
    remoteAnswer: (sdp) => child?.send({ cmd: 'remote-answer', sdp }),
    remoteIce: (candidate, sdpMid, sdpMLineIndex) =>
      child?.send({ cmd: 'remote-ice', candidate, sdpMid, sdpMLineIndex }),
    destroy: () => {
      destroyed = true
      clearTimers()
      child?.kill()
      child = null
    }
  }
}
