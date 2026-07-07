// Helper-side client for the elevated input service. The input-helper stays the
// network endpoint (owns the WebRTC input pc); when the elevated injector is
// available it FORWARDS each RemoteInputMessage over the named pipe instead of
// injecting locally, so input reaches high-integrity windows (Task Manager) and
// the secure desktop.
//
// PIPE ROLE (Fix A, docs/input-elevation-plan.md): the medium helper HOSTS the
// pipe; the SYSTEM injector-in-session CONNECTS to it. Rationale from the Phase 2
// e2e round: a SYSTEM process that hosts a libuv/net pipe gets a default DACL
// (SYSTEM+Admins only) that DENIES the medium helper ("Access is denied", node
// mangles it to ENOENT). Inverting the roles fixes it — SYSTEM can open any
// user-owned pipe, so the injector connects to the helper's pipe with no custom
// SDDL. (Fix B — the injector owning the pipe via CreateNamedPipeW+SDDL — is the
// correct trust model and is deferred to Phase 4. Residual same-user info-leak /
// squat on this medium-hosted pipe is accepted for a sole-user home tool and
// documented in the plan.)
//
// Data still flows helper -> injector: the helper WRITES frames onto the accepted
// connection; the injector READS + injects. This module never reads back.
//
// SAFETY BAR: gated entirely behind PR_INPUT_SERVICE=1. Default build never
// touches the pipe -- startServiceClient() is a no-op and maybeForwardInput()
// returns false, so the helper's existing local injection path runs unchanged
// (byte-identical behavior). Flip the env only once the service is installed +
// verified on real hardware.

import net from 'node:net'
import { PIPE_NAME, encodeFrame } from '../input-service/protocol'
import type { RemoteInputMessage } from '../renderer/src/shared/input/inputProtocol'

const ENABLED = process.env.PR_INPUT_SERVICE === '1'
const RELISTEN_MS = 2000

let server: net.Server | null = null
// The connected SYSTEM injector, if one has connected. null => nobody is there,
// so maybeForwardInput() falls back to local injection.
let sock: net.Socket | null = null

function listen(): void {
  if (!ENABLED || server) return
  const srv = net.createServer((s) => {
    // The SYSTEM injector connected. Only one injector runs at a time (the
    // session-0 launcher keeps a single instance); if a stale socket lingers,
    // prefer the newest connection.
    if (sock && !sock.destroyed) sock.destroy()
    sock = s
    // We never read from the injector -- data is one-way (helper -> injector).
    // Drain any bytes it might send so the socket doesn't buffer forever.
    s.resume()
    s.on('error', () => {
      if (sock === s) sock = null
      s.destroy()
    })
    s.on('close', () => {
      if (sock === s) sock = null
    })
  })
  srv.on('error', (e) => {
    // EADDRINUSE => a stale pipe from a previous helper/injector (e.g. an upgrade
    // in flight). Tear down and retry listening; the injector keeps retrying its
    // connect, so we converge. Never throw into the helper.
    server = null
    try {
      srv.close()
    } catch {
      /* ignore */
    }
    if (ENABLED) setTimeout(listen, RELISTEN_MS)
    void e
  })
  srv.listen(PIPE_NAME)
  server = srv
}

/** Begin hosting the injector pipe (no-op unless PR_INPUT_SERVICE=1). */
export function startServiceClient(): void {
  if (!ENABLED) return
  listen()
}

/**
 * Forward one input message to the elevated injector. Returns true if it was
 * written to the pipe (caller should then SKIP local injection); false means
 * "no injector connected -- inject locally as before". Backpressure is ignored on
 * purpose: input frames are tiny and must not be delayed; if the pipe ever
 * genuinely backs up, dropping the write and falling back is the safer choice.
 */
export function maybeForwardInput(message: RemoteInputMessage): boolean {
  if (!ENABLED) return false
  const s = sock
  if (!s || s.destroyed || !s.writable) return false
  try {
    s.write(encodeFrame(message))
    return true
  } catch {
    return false
  }
}
