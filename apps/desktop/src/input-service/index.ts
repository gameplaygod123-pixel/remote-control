// injector-in-session entry point. Runs as SYSTEM (high integrity) INSIDE the
// interactive session, spawned by the session-0 launcher (service.ts) via
// CreateProcessAsUser. Started with ELECTRON_RUN_AS_NODE=1 like the input-helper.
//
// PIPE ROLE (Fix A, docs/input-elevation-plan.md): the medium input-helper HOSTS
// the pipe; THIS SYSTEM injector CONNECTS to it. Rationale from the Phase 2 e2e
// round: a SYSTEM process that hosts a libuv/net pipe gets a default DACL
// (SYSTEM+Admins only) that DENIES the medium helper. Inverting roles fixes it --
// SYSTEM can open any user-owned pipe, so we connect to the helper's pipe with no
// custom SDDL. (Fix B, the injector owning the pipe via CreateNamedPipeW+SDDL, is
// Phase 4.)
//
// Data still flows helper -> injector: the helper WRITES RemoteInputMessages onto
// the connection, we READ them, follow the active desktop, and inject via raw
// SendInput. Because both mouse and keyboard go through the same thread's
// SendInput after SetThreadDesktop, injection lands on Task Manager / elevated
// apps (high integrity) and the Winlogon secure desktop (UAC / lock).

import net from 'node:net'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PIPE_NAME, FrameDecoder } from './protocol'
import { injectRaw } from './rawInject'
import { syncInputDesktop } from './win32Session'

const LOG = join(tmpdir(), 'input-service.log')
// Reconnect backoff: start fast so the first input after a spawn isn't lost to
// the startup race (injector up before the helper hosts the pipe -> a short
// burst of ENOENT), then ease off. Reset to fast on every successful connect.
const RECONNECT_MIN_MS = 200
const RECONNECT_MAX_MS = 1000
let reconnectMs = RECONNECT_MIN_MS

function log(msg: string): void {
  try {
    appendFileSync(LOG, `[injector ${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* logging must never crash injection */
  }
}

let sock: net.Socket | null = null
let connecting = false

function connect(): void {
  if (connecting || sock) return
  connecting = true
  const s = net.connect(PIPE_NAME)
  const decoder = new FrameDecoder()
  s.on('connect', () => {
    connecting = false
    sock = s
    reconnectMs = RECONNECT_MIN_MS // reset backoff; a future drop reconnects fast
    log('connected to helper pipe')
  })
  s.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      try {
        // Follow the input desktop first — cheap, and only re-binds when it
        // actually flipped (Default <-> Winlogon around UAC/lock). Pass log so
        // the Default->Winlogon flip (and any SetThreadDesktop failure on the
        // secure desktop) is visible in the injector log for Phase 3.
        syncInputDesktop(log)
        injectRaw(message)
      } catch (e) {
        // A single bad inject must not kill the loop. (A koffi/native segfault
        // would take the process down regardless — that's golden rule #1's
        // whole point; catch is only for JS-level errors.)
        log(`inject error: ${(e as Error).message}`)
      }
    }
  })
  s.on('error', (e) => {
    // Helper not hosting yet (agent without PR_INPUT_SERVICE, or helper still
    // starting / restarting). The 'close' handler schedules the retry.
    log(`pipe connect error: ${e.message}`)
    if (sock === s) sock = null
    connecting = false
    s.destroy()
  })
  s.on('close', () => {
    if (sock === s) sock = null
    connecting = false
    // The helper is the persistent host; reconnect to it (it survives our
    // respawns and we survive its restarts). Back off so a helper that's down
    // for a while doesn't get hammered.
    setTimeout(connect, reconnectMs)
    reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS)
  })
}

function start(): void {
  log(`injector starting (pid ${process.pid})`)
  connect()

  // Belt-and-suspenders: if the parent launcher dies we should too (no orphaned
  // SYSTEM injector left behind). The launcher also kills us on session change.
  process.on('disconnect', () => process.exit(0))
}

start()
