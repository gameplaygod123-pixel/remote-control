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

import { appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getActiveSessionId, spawnInjectorInSession } from './win32Session'
import { SERVICE_LOG } from './protocol'

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

function tick(): void {
  const sid = getActiveSessionId()
  if (sid === NO_SESSION || sid === 0) {
    if (currentSessionId !== NO_SESSION) {
      log(`no interactive session (was ${currentSessionId})`)
      currentSessionId = NO_SESSION
      // TODO(win): kill the previous injector process here (keep its handle
      // from spawnInjectorInSession) so it doesn't linger on a dead session.
    }
    return
  }
  if (sid !== currentSessionId) {
    log(`active session -> ${sid}; (re)spawning injector`)
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
  // TODO(win): also detect the injector having EXITED (watch its process
  // handle) and respawn even when the session id is unchanged.
}

log(`service starting (pid ${process.pid}); injector=${injectorScript}`)
setInterval(tick, POLL_MS)
tick()
