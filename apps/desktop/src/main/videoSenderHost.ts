import { ChildProcess, fork } from 'child_process'
import { join } from 'path'
import { logVideoSender, resetVideoSenderLog } from './videoSenderLog'
import type {
  MainToVideoSender,
  VideoSenderCallbacks,
  VideoSenderHost,
  VideoSenderToMain
} from '../video-native/shared/ipc'
import type { VideoConfig } from '../video-native/shared/contract'

// Spawns and supervises the agent's native VIDEO SENDER helper -- a pure-Node
// child (ELECTRON_RUN_AS_NODE=1, no Chromium) that owns DXGI capture + ffmpeg
// hardware encode + the outbound H.264 RTP media track. Deliberately a copy of
// inputHelperHost.ts's proven mechanics (fork-as-Node, respawn on crash,
// ping/pong liveness, SDP/ICE relayed through main) -- see that file and
// docs/native-video-plan.md §3.5. The helper runs in its own process so an
// ffmpeg/native crash respawns instead of taking down the Electron UI, and the
// caller can fall back to the WebRTC path when the helper is down (isReady()).

const RESPAWN_DELAY_MS = 2_000
const PING_INTERVAL_MS = 10_000
const PONG_TIMEOUT_MS = 5_000

export function startVideoSenderHost(callbacks: VideoSenderCallbacks): VideoSenderHost {
  resetVideoSenderLog()
  const log = (message: string): void => logVideoSender('HOST', message)

  let child: ChildProcess | null = null
  let ready = false
  let destroyed = false
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let pongTimeout: ReturnType<typeof setTimeout> | undefined
  let lastPingSentAt = 0
  // Remember the last requested config so a mid-session respawn can restart
  // capture without waiting for the caller to re-issue start-session.
  let activeConfig: VideoConfig | null = null

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

  function sendToChild(msg: MainToVideoSender): void {
    child?.send(msg)
  }

  function spawn(): void {
    if (destroyed) return
    const helperPath = join(__dirname, 'video-sender.js')
    log(`spawning helper at ${helperPath}`)
    const proc = fork(helperPath, [], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      silent: false
    })
    log(`spawned, pid=${proc.pid}`)
    child = proc

    proc.on('message', (msg: VideoSenderToMain) => {
      switch (msg.evt) {
        case 'ready':
          ready = true
          log(`ready, pid=${proc.pid}`)
          pingTimer = setInterval(() => {
            lastPingSentAt = Date.now()
            proc.send({ cmd: 'ping' } satisfies MainToVideoSender)
            pongTimeout = setTimeout(() => {
              log(`PONG TIMEOUT after ${Date.now() - lastPingSentAt}ms -- killing pid=${proc.pid}`)
              proc.kill()
            }, PONG_TIMEOUT_MS)
          }, PING_INTERVAL_MS)
          // A respawn mid-session restarts capture with the last config so the
          // stream self-heals (the caller sees continuity via the same host).
          if (activeConfig) {
            log('respawn: re-issuing start-session with the last config')
            sendToChild({ cmd: 'start-session', config: activeConfig })
          }
          break
        case 'pong':
          if (pongTimeout) clearTimeout(pongTimeout)
          break
        case 'offer':
          log(`offer from helper, sdp length=${msg.sdp.length}`)
          callbacks.onOffer(msg.sdp)
          break
        case 'ice':
          callbacks.onIce(msg.candidate, msg.sdpMid, msg.sdpMLineIndex)
          break
        case 'stats':
          callbacks.onStats(msg.stats)
          break
        case 'fatal':
          log(`fatal from helper: ${msg.message}`)
          console.error('[video-sender] fatal:', msg.message)
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
    startSession: (config: VideoConfig) => {
      log(`startSession() ${config.width}x${config.height}@${config.fps} codec=${config.codec}`)
      activeConfig = config
      sendToChild({ cmd: 'start-session', config })
    },
    remoteAnswer: (sdp) => {
      log(`remoteAnswer() sdp length=${sdp.length}`)
      sendToChild({ cmd: 'remote-answer', sdp })
    },
    remoteIce: (candidate, sdpMid, sdpMLineIndex) => {
      sendToChild({ cmd: 'remote-ice', candidate, sdpMid, sdpMLineIndex })
    },
    setBitrate: (kbps) => {
      log(`setBitrate() ${kbps}kbps`)
      sendToChild({ cmd: 'set-bitrate', kbps })
    },
    stopSession: () => {
      log('stopSession()')
      activeConfig = null
      sendToChild({ cmd: 'stop-session' })
    },
    destroy: () => {
      destroyed = true
      activeConfig = null
      clearTimers()
      child?.kill()
      child = null
    }
  }
}
