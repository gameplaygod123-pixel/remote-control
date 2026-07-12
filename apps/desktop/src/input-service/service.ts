// Session-0 launcher entry point (SYSTEM). Installed by
// scripts/install-input-service.ps1 as a Scheduled Task `/ru SYSTEM /rl HIGHEST`
// (NOT an SCM service -- this is plain-Node electron.exe with no
// StartServiceCtrlDispatcher, which trips SCM error 1053; the task avoids that
// while staying in session 0). Run as electron.exe with ELECTRON_RUN_AS_NODE=1.
//
// This process NEVER injects. Its only job is to keep exactly one
// injector-in-session (index.ts) running as SYSTEM inside the CURRENT
// interactive session, respawning it when it dies or when the active session
// changes (fast-user-switch, logon/logoff). All the desktop-following +
// SendInput happens in the child; session 0 can't reach the user's desktop
// itself (see the isolation note in the plan).

import { appendFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import net from 'node:net'
import { getActiveSessionId, spawnInjectorInSession, spawnCapturerInSession } from './win32Session'
import { SERVICE_LOG } from './protocol'
import { CAPTURER_SPAWN_PIPE, validateSpawnRequest } from './capturerSpawn'

const LOG = SERVICE_LOG
function log(msg: string): void {
  try {
    appendFileSync(LOG, `[service ${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* ignore */
  }
}

// 0xFFFFFFFF => no active console session (nobody logged in / at the secure
// desktop transiently); 0 is session 0 itself (never an interactive user).
const NO_SESSION = 0xffffffff

// The injector runs the same electron.exe as this service, ELECTRON_RUN_AS_NODE,
// pointing at the built injector sibling. process.execPath is electron.exe.
// NOTE: the electron-vite entry name is 'input-injector' (electron.vite.config),
// so the emitted file is out/main/input-injector.js next to this service.js.
const injectorScript = join(dirname(__filename), 'input-injector.js')

let currentSessionId = NO_SESSION
const POLL_MS = 2000

// ── secure-desktop SYSTEM capturer (Part 2b) ─────────────────────────────────
// The user-session sender HOSTS the request pipe (CAPTURER_SPAWN_PIPE) whenever the
// secure-desktop video path is active + writes a structured spawn request carrying a
// unique VIDEO pipe name. We poll-connect on the same ~2s tick, validate, and spawn
// capturer.exe as SYSTEM-in-session. Self-gating: no sender hosting => connect fails =>
// no-op (byte-identical to input-only Track 2).
//
// RE-SPAWN PER REQUEST (not once per Windows session): the sender re-creates its
// SystemCapturerFrameSource — and re-hosts a NEW video pipe — on every re-negotiation
// (a re-pair, which the Mac triggers when video stalls, e.g. during a lock/desktop
// switch). The OLD capturer dies on its broken pipe; we MUST spawn a fresh one for the
// new pipe or the sender times out (10s) and falls back to the in-session capturer, which
// can't follow the secure desktop -> permanent freeze + a re-pair loop (found in 2c e2e).
// So we dedup by the request's pipeName and spawn whenever it changes.
let lastSpawnedPipeName: string | null = null
let capturerConnectInFlight = false

// The capturer.exe the LAUNCHER resolves (never from the wire). Mirrors resolveCapturerPath()
// in the sender: CAPTURER_PATH env (dev/test), else resources/capturer/capturer.exe.
function resolveCapturerExe(): string | null {
  const env = process.env.CAPTURER_PATH
  if (env && existsSync(env)) return env
  const resDir = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    resDir ? join(resDir, 'capturer', 'capturer.exe') : null,
    // out/main/input-service.js -> ../../../capturer/capturer.exe (resources/capturer)
    join(dirname(__filename), '..', '..', '..', 'capturer', 'capturer.exe')
  ].filter((p): p is string => p != null)
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

// Read exactly ONE length-prefixed JSON frame (protocol.ts framing: 4-byte LE len + UTF-8
// JSON) off the connected request pipe, then hand back the parsed object.
function readOneRequest(sock: net.Socket, onRequest: (raw: unknown) => void): void {
  let buf: Buffer = Buffer.alloc(0)
  let done = false
  sock.on('data', (chunk: Buffer) => {
    if (done) return
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
    if (buf.length < 4) return
    const len = buf.readUInt32LE(0)
    if (len === 0 || len > 64 * 1024) {
      done = true
      sock.destroy()
      return
    } // desync/hostile
    if (buf.length < 4 + len) return
    const json = buf.subarray(4, 4 + len).toString('utf8')
    done = true
    sock.destroy() // one frame = one request
    try {
      onRequest(JSON.parse(json))
    } catch {
      log('capturer spawn request: malformed JSON -> skip')
    }
  })
}

function maybeSpawnCapturer(sid: number): void {
  if (capturerConnectInFlight) return
  capturerConnectInFlight = true
  const sock = net.connect(CAPTURER_SPAWN_PIPE)
  const finish = (): void => {
    capturerConnectInFlight = false
  }
  // Sender not hosting yet (feature off / not negotiated) => ENOENT/ECONNREFUSED => try next tick.
  sock.on('error', finish)
  sock.on('close', finish)
  sock.on('connect', () => {
    readOneRequest(sock, (raw) => {
      const req = validateSpawnRequest(raw)
      if (!req) {
        log('capturer spawn request invalid (squatter/garbage?) -> skip')
        return
      }
      // Dedup: the sender re-writes the same request on every poll-connect. Only (re)spawn
      // when the VIDEO pipe changed — i.e. a new SystemCapturerFrameSource (re-negotiation).
      if (req.pipeName === lastSpawnedPipeName) return
      const exe = resolveCapturerExe()
      if (!exe) {
        log('capturer.exe not found -> cannot spawn SYSTEM capturer')
        return
      }
      const res = spawnCapturerInSession(exe, req, sid, log)
      if (res) {
        lastSpawnedPipeName = req.pipeName
        log(`SYSTEM capturer spawned: pid ${res.pid}, session ${sid}, pipe ${req.pipeName}`)
      } else {
        log('spawnCapturerInSession failed (see GetLastError above)')
      }
    })
  })
}

function tick(): void {
  const sid = getActiveSessionId()
  if (sid === NO_SESSION || sid === 0) {
    if (currentSessionId !== NO_SESSION) {
      log(`no interactive session (was ${currentSessionId})`)
      currentSessionId = NO_SESSION
      lastSpawnedPipeName = null // capturer died with the session (broken video pipe)
      // TODO(win): kill the previous injector process here (keep its handle
      // from spawnInjectorInSession) so it doesn't linger on a dead session.
    }
    return
  }
  if (sid !== currentSessionId) {
    log(`active session -> ${sid}; (re)spawning injector`)
    lastSpawnedPipeName = null // new Windows session -> allow a fresh capturer spawn
    // TODO(win): kill any previous injector before spawning the new one.
    const ok = spawnInjectorInSession(process.execPath, injectorScript, sid, log)
    if (ok) {
      currentSessionId = sid
    } else {
      // Scaffold path today: spawnInjectorInSession returns false until the
      // CreateProcessAsUser plumbing is wired. Don't latch the session so the
      // next tick retries once it's implemented.
      log('spawnInjectorInSession not implemented yet (returned false)')
    }
  }
  // Secure-desktop video (2b): if the sender is hosting a spawn request, spawn the SYSTEM
  // capturer into this session. No-op when the feature is off (no request pipe to connect).
  maybeSpawnCapturer(sid)
  // TODO(win): also detect the injector having EXITED (watch its process
  // handle) and respawn even when the session id is unchanged.
}

log(`service starting (pid ${process.pid}); injector=${injectorScript}`)
setInterval(tick, POLL_MS)
tick()
