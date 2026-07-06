// injector-in-session entry point. Runs as SYSTEM (high integrity) INSIDE the
// interactive session, spawned by service.ts (session 0) via CreateProcessAsUser.
// Started with ELECTRON_RUN_AS_NODE=1 like the input-helper. UNTESTED handoff
// code (docs/input-elevation-plan.md, phase 1-3).
//
// It hosts the named pipe, receives RemoteInputMessages from the medium-
// integrity input-helper, follows the active desktop, and injects via raw
// SendInput. Because BOTH mouse and keyboard go through the same thread's
// SendInput after SetThreadDesktop, injection lands on Task Manager / elevated
// apps (high integrity) and on the Winlogon secure desktop (UAC / lock).

import net from 'node:net'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PIPE_NAME, FrameDecoder } from './protocol'
import { injectRaw } from './rawInject'
import { syncInputDesktop } from './win32Session'

const LOG = join(tmpdir(), 'input-service.log')
function log(msg: string): void {
  try {
    appendFileSync(LOG, `[injector ${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* logging must never crash injection */
  }
}

function handleConnection(sock: net.Socket): void {
  log('helper connected to pipe')
  const decoder = new FrameDecoder()
  sock.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      try {
        // Follow the input desktop first — cheap, and only re-binds when it
        // actually flipped (Default <-> Winlogon around UAC/lock).
        syncInputDesktop()
        injectRaw(message)
      } catch (e) {
        // A single bad inject must not kill the loop. (A koffi/native segfault
        // would take the process down regardless — that's golden rule #1's
        // whole point; catch is only for JS-level errors.)
        log(`inject error: ${(e as Error).message}`)
      }
    }
  })
  sock.on('error', (e) => log(`pipe socket error: ${e.message}`))
  sock.on('close', () => log('helper disconnected'))
}

function start(): void {
  log(`injector starting (pid ${process.pid})`)
  const server = net.createServer(handleConnection)
  server.on('error', (e) => {
    // EADDRINUSE => a stale pipe/instance. Log and exit so the service respawns
    // us cleanly rather than two injectors racing on one pipe.
    log(`server error: ${e.message}; exiting for respawn`)
    process.exit(1)
  })
  server.listen(PIPE_NAME, () => log(`listening on ${PIPE_NAME}`))

  // Belt-and-suspenders: if the parent service dies we should too (no orphaned
  // SYSTEM injector left behind). The service also kills us on session change.
  process.on('disconnect', () => process.exit(0))
}

start()
