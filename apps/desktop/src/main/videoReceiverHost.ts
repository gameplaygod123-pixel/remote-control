import { ChildProcess, fork } from 'child_process'
import { join } from 'path'
import { logVideoReceiver, resetVideoReceiverLog } from './videoReceiverLog'
import type {
  MainToVideoReceiver,
  VideoReceiverCallbacks,
  VideoReceiverHost,
  VideoReceiverToMain
} from '../video-native/shared/ipc'

// Spawns and supervises the Mac controller's native VIDEO RECEIVER helper -- a
// pure-Node child (ELECTRON_RUN_AS_NODE=1, no Chromium) that answers the agent's
// native offer on channel:'video-native', receives the H.264 RTP track via
// node-datachannel, and depacketizes to Annex-B. It then streams the compressed
// access units back to MAIN (evt:'au'), which pushes them into the in-process
// render surface (main/nativeRenderSurface.ts -> librvr.dylib) so the video
// composites INSIDE the Electron window -- no separate render process/window
// anymore (native-video-plan §3a fix). A deliberate mirror of
// videoSenderHost.ts / inputHelperHost.ts: fork-as-Node, respawn on crash,
// ping/pong liveness, SDP/ICE relayed through main. The helper lives in its own
// process so an ndc/depacketize crash respawns instead of taking down the
// Electron UI, and the caller can fall back to the WebRTC <video> path via
// isReady().
//
// Receiver-specific vs the sender: it consumes remote-OFFER and emits an ANSWER
// (the agent is still the offerer, as today); it forwards each reassembled AU to
// main; and it surfaces first-frame so the renderer can drop its "connecting..."
// overlay.

const RESPAWN_DELAY_MS = 2_000
const PING_INTERVAL_MS = 10_000
const PONG_TIMEOUT_MS = 5_000

export function startVideoReceiverHost(callbacks: VideoReceiverCallbacks): VideoReceiverHost {
  resetVideoReceiverLog()
  const log = (message: string): void => logVideoReceiver('HOST', message)

  let child: ChildProcess | null = null
  let ready = false
  let destroyed = false
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let pongTimeout: ReturnType<typeof setTimeout> | undefined
  let lastPingSentAt = 0
  // A receiver session has no config (the agent dictates format via its offer),
  // but we remember that a session is active so a mid-session respawn re-arms the
  // helper's peer connection without waiting on the caller. The fresh OFFER needed
  // to actually re-negotiate comes from the agent over signaling (the caller
  // drives that via onDown -> re-pair).
  let sessionActive = false

  function clearTimers(): void {
    if (pingTimer) clearInterval(pingTimer)
    if (pongTimeout) clearTimeout(pongTimeout)
    pingTimer = undefined
    pongTimeout = undefined
  }

  function markDown(): void {
    if (!ready && !child) return // already down, avoid duplicate onDown()
    ready = false
    clearTimers()
    log('markDown (onDown callback firing)')
    callbacks.onDown()
  }

  function sendToChild(msg: MainToVideoReceiver): void {
    child?.send(msg)
  }

  function spawn(): void {
    if (destroyed) return
    const helperPath = join(__dirname, 'video-receiver.js')
    log(`spawning helper at ${helperPath}`)
    const proc = fork(helperPath, [], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // 'advanced' (v8 structured clone) so the per-frame { evt:'au', data:Buffer }
      // transfers the Buffer efficiently instead of JSON-inflating it to a number[].
      serialization: 'advanced',
      silent: false
    })
    log(`spawned, pid=${proc.pid}`)
    child = proc

    proc.on('message', (msg: VideoReceiverToMain) => {
      switch (msg.evt) {
        case 'ready':
          ready = true
          log(`ready, pid=${proc.pid}`)
          pingTimer = setInterval(() => {
            lastPingSentAt = Date.now()
            proc.send({ cmd: 'ping' } satisfies MainToVideoReceiver)
            pongTimeout = setTimeout(() => {
              log(`PONG TIMEOUT after ${Date.now() - lastPingSentAt}ms -- killing pid=${proc.pid}`)
              proc.kill()
            }, PONG_TIMEOUT_MS)
          }, PING_INTERVAL_MS)
          // A respawn mid-session re-arms the helper's peer connection (ready to
          // answer the agent's next offer).
          if (sessionActive) {
            log('respawn: re-arming start-session')
            sendToChild({ cmd: 'start-session' })
          }
          break
        case 'pong':
          if (pongTimeout) clearTimeout(pongTimeout)
          break
        case 'answer':
          log(`answer from helper, sdp length=${msg.sdp.length}`)
          callbacks.onAnswer(msg.sdp)
          break
        case 'ice':
          callbacks.onIce(msg.candidate, msg.sdpMid, msg.sdpMLineIndex)
          break
        case 'au':
          callbacks.onAu(msg.data)
          break
        case 'first-frame':
          log('first-frame decoded + on screen')
          callbacks.onFirstFrame()
          break
        case 'stats':
          callbacks.onStats(msg.stats)
          break
        case 'bitrate':
          callbacks.onBitrate(msg.kbps)
          break
        case 'fatal':
          log(`fatal from helper: ${msg.message}`)
          console.error('[video-receiver] fatal:', msg.message)
          break
      }
    })

    proc.on('exit', (code, signal) => {
      log(`exit, pid=${proc.pid}, code=${code}, signal=${signal}`)
      child = null
      markDown()
      if (!destroyed) setTimeout(spawn, RESPAWN_DELAY_MS)
    })
  }

  spawn()

  return {
    isReady: () => ready,
    startSession: () => {
      log('startSession()')
      sessionActive = true
      sendToChild({ cmd: 'start-session' })
    },
    remoteOffer: (sdp) => {
      log(`remoteOffer() sdp length=${sdp.length}`)
      sendToChild({ cmd: 'remote-offer', sdp })
    },
    remoteIce: (candidate, sdpMid, sdpMLineIndex) => {
      sendToChild({ cmd: 'remote-ice', candidate, sdpMid, sdpMLineIndex })
    },
    stopSession: () => {
      log('stopSession()')
      sessionActive = false
      sendToChild({ cmd: 'stop-session' })
    },
    destroy: () => {
      destroyed = true
      sessionActive = false
      clearTimers()
      child?.kill()
      child = null
    }
  }
}
