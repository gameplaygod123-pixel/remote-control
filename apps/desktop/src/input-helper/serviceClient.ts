// Helper-side client for the elevated input service. The input-helper stays the
// network endpoint (owns the WebRTC input pc); when the elevated injector is
// available it FORWARDS each RemoteInputMessage over the named pipe instead of
// injecting locally, so input reaches high-integrity windows (Task Manager) and
// the secure desktop. UNTESTED handoff code (docs/input-elevation-plan.md).
//
// SAFETY BAR: gated entirely behind PR_INPUT_SERVICE=1. Default build never
// touches the pipe -- maybeForwardInput() returns false, so the helper's
// existing local injection path runs unchanged (byte-identical behavior). Flip
// the env only once the service is installed + verified on real hardware.

import net from 'node:net'
import { PIPE_NAME, encodeFrame } from '../input-service/protocol'
import type { RemoteInputMessage } from '../renderer/src/shared/input/inputProtocol'

const ENABLED = process.env.PR_INPUT_SERVICE === '1'
const RECONNECT_MS = 2000

let sock: net.Socket | null = null
let connecting = false

function connect(): void {
  if (!ENABLED || connecting || sock) return
  connecting = true
  const s = net.connect(PIPE_NAME)
  s.on('connect', () => {
    connecting = false
    sock = s
  })
  s.on('error', () => {
    // Injector not up yet (no session / service still spawning it). Fall back
    // to local inject and retry — never throw into the input hot path.
    connecting = false
    s.destroy()
  })
  s.on('close', () => {
    if (sock === s) sock = null
    connecting = false
    if (ENABLED) setTimeout(connect, RECONNECT_MS)
  })
}

/** Begin trying to reach the injector (no-op unless PR_INPUT_SERVICE=1). */
export function startServiceClient(): void {
  if (!ENABLED) return
  connect()
}

/**
 * Forward one input message to the elevated injector. Returns true if it was
 * written to the pipe (caller should then SKIP local injection); false means
 * "not available -- inject locally as before". Backpressure is ignored on
 * purpose: input frames are tiny and must not be delayed; if the pipe ever
 * genuinely backs up, dropping the write and falling back is the safer choice.
 */
export function maybeForwardInput(message: RemoteInputMessage): boolean {
  if (!ENABLED) return false
  const s = sock
  if (!s || s.destroyed || !s.writable) {
    connect() // kick a (re)connect for next time
    return false
  }
  try {
    s.write(encodeFrame(message))
    return true
  } catch {
    return false
  }
}
