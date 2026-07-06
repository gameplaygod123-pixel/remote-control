// Phase 2 harness — the session-0 -> session-1 SYSTEM spawn (the riskiest FFI in
// the elevation feature). Tests win32Session's CreateProcessAsUserW plumbing one
// step at a time, per the plan: layout self-check -> session id -> spawn a benign
// PROBE into the active session (verify session id + integrity) -> spawn the real
// injector. Golden rule #1: a wrong struct/signature segfaults natively, so the
// layout check runs first and every Win32 call logs GetLastError.
//
// The privileged stages (probe/injector) MUST run as SYSTEM from session 0 — the
// real service's context. scripts/phase2.ps1 schedules this as a SYSTEM task for
// those; layout/session run fine as a normal user.
//
// Output goes to BOTH stdout and C:\Windows\Temp\phase2-harness.log (a SYSTEM
// scheduled task has no console we can read, so the log file is how we see it).

import { appendFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  getActiveSessionId,
  checkSpawnLayout,
  createProcessInSession,
  spawnInjectorInSession
} from '../win32Session'

const HARNESS_LOG = 'C:\\Windows\\Temp\\phase2-harness.log'
const CHILD_JSON = 'C:\\Windows\\Temp\\phase2-child.json'
const PROBE_PS1 = 'C:\\Windows\\Temp\\phase2-probe.ps1'
const INJECTOR = process.env.PHASE2_INJECTOR || resolve(process.cwd(), 'out/main/input-injector.js')
const ELECTRON = process.env.PHASE2_ELECTRON || process.execPath
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function log(msg: string): void {
  const line = `[phase2 ${new Date().toISOString()}] ${msg}`
  process.stdout.write(line + '\n')
  try {
    appendFileSync(HARNESS_LOG, line + '\n')
  } catch {
    /* ignore */
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function stageLayout(): boolean {
  const r = checkSpawnLayout()
  log(`layout ${r.ok ? 'OK' : 'BAD'}: ${r.detail}`)
  return r.ok
}

function stageSession(): number {
  const sid = getActiveSessionId()
  log(`active console session id = ${sid}`)
  return sid
}

// Spawn PowerShell into the active session; it writes its own session id +
// integrity + user to CHILD_JSON. That directly proves the child landed in the
// right session at the right integrity — the whole point of the SYSTEM-in-session
// token.
function stageProbe(): boolean {
  if (!stageLayout()) return false
  const sid = stageSession()
  if (sid === 0 || sid === 0xffffffff) {
    log('no interactive session; cannot probe')
    return false
  }
  const script = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$p=Get-Process -Id $PID',
    "$lbl=(whoami /groups | Select-String 'Mandatory Label').Line",
    '[pscustomobject]@{',
    '  pid=$PID; session=$p.SessionId; user=(whoami); integrity="$lbl";',
    '  desktop=$env:PHASE2_NONE',
    '} | ConvertTo-Json | Set-Content -Path "' + CHILD_JSON + '" -Encoding utf8'
  ].join('\n')
  writeFileSync(PROBE_PS1, script, 'utf8')
  rmSync(CHILD_JSON, { force: true })

  const cmd = `"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -File "${PROBE_PS1}"`
  log(`spawning probe: ${cmd}`)
  const res = createProcessInSession(POWERSHELL, cmd, sid, log)
  if (!res) {
    log('probe spawn FAILED (see GetLastError above)')
    return false
  }
  log(`probe spawned pid=${res.pid}; waiting for it to write ${CHILD_JSON}...`)
  for (let i = 0; i < 30 && !existsSync(CHILD_JSON); i++) sleepSync(200)
  if (!existsSync(CHILD_JSON)) {
    log('CHILD_JSON never appeared — child may not have run in the interactive session')
    return false
  }
  // PowerShell Set-Content -Encoding utf8 prepends a UTF-8 BOM; strip it (plus
  // any leading whitespace) or JSON.parse throws on the leading ﻿.
  const raw = readFileSync(CHILD_JSON, 'utf8').replace(/^﻿/, '').trim()
  log('child reported: ' + raw.replace(/\s+/g, ' ').trim())
  let ok = false
  try {
    const j = JSON.parse(raw) as { session: number; integrity: string; user: string }
    const sessionOk = j.session === sid
    const integrityOk = /System Mandatory Level|High Mandatory Level/i.test(j.integrity || '')
    log(`  session match: ${j.session} === ${sid} -> ${sessionOk}`)
    log(`  integrity: "${j.integrity}" -> ${integrityOk ? 'HIGH/SYSTEM (good for phase 3)' : 'TOO LOW'}`)
    log(`  running as: ${j.user}`)
    ok = sessionOk && integrityOk
  } catch (e) {
    log('could not parse child JSON: ' + (e as Error).message)
  }
  log(ok ? 'PROBE PASS — spawned into the right session at high integrity.' : 'PROBE CHECK — see above.')
  return ok
}

// Now the real thing: spawn the built injector as SYSTEM-in-session. It should
// host the named pipe from an elevated child. We confirm via the injector's own
// log (input-service.log) writing "listening" from a NEW pid.
function stageInjector(): boolean {
  if (!stageLayout()) return false
  const sid = stageSession()
  if (sid === 0 || sid === 0xffffffff) return false
  // The child runs as SYSTEM, so ITS os.tmpdir() is C:\Windows\Temp — that's
  // where the injector writes input-service.log (per the README note). Snapshot
  // the log, spawn, then diff to confirm a NEW elevated injector came up.
  const LOG_SYS = 'C:\\Windows\\Temp\\input-service.log'
  const before = existsSync(LOG_SYS) ? readFileSync(LOG_SYS, 'utf8') : ''
  log(`spawning injector: "${ELECTRON}" "${INJECTOR}" (ELECTRON_RUN_AS_NODE=1) into session ${sid}`)
  const ok = spawnInjectorInSession(ELECTRON, INJECTOR, sid, log)
  log(ok ? 'spawnInjectorInSession returned OK' : 'spawnInjectorInSession returned FALSE')
  if (!ok) return false

  for (let i = 0; i < 25; i++) {
    const now = existsSync(LOG_SYS) ? readFileSync(LOG_SYS, 'utf8') : ''
    if (now.length > before.length && /listening on/.test(now.slice(before.length))) break
    sleepSync(200)
  }
  const after = existsSync(LOG_SYS) ? readFileSync(LOG_SYS, 'utf8') : ''
  const fresh = after.slice(before.length).trim()
  log('new input-service.log lines from the elevated child:\n' + (fresh || '(none — child may not have started)'))
  const pidMatch = fresh.match(/injector starting \(pid (\d+)\)/)
  const listening = /listening on/.test(fresh)
  log(`elevated injector: started=${!!pidMatch} listening=${listening}`)
  // Clean up the test injector so it doesn't linger holding the pipe (we're
  // SYSTEM here, so we can kill a SYSTEM child).
  if (pidMatch) {
    try {
      process.kill(Number(pidMatch[1]))
      log(`cleaned up test injector pid ${pidMatch[1]}`)
    } catch (e) {
      log(`could not kill test injector pid ${pidMatch[1]}: ${(e as Error).message}`)
    }
  }
  return listening
}

function main(): void {
  const stage = (process.argv[2] || 'layout').toLowerCase()
  log(`==== phase2 stage: ${stage} ====`)
  log(`injector=${INJECTOR}`)
  log(`electron=${ELECTRON}`)
  try {
    switch (stage) {
      case 'layout':
        stageLayout()
        break
      case 'session':
        stageSession()
        break
      case 'probe':
        stageProbe()
        break
      case 'injector':
        stageInjector()
        break
      default:
        log(`unknown stage "${stage}" — layout|session|probe|injector`)
    }
  } catch (e) {
    log('HARNESS ERROR (JS-level): ' + (e as Error).stack)
  }
  log('==== stage complete ====')
}

main()
