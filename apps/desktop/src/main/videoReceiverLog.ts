// Diagnostic logging for the native video RECEIVER (host + helper), mirroring
// videoSenderLog.ts / inputHelperLog.ts. The Mac controller's Electron main and
// its forked receiver helper have no visible console in a packaged build, and
// per golden rule #1 the native path must be verifiable on the real Mac -- this
// is where that evidence lands (video-receiver.log in the temp dir). Volume is
// light: lifecycle lines + one stats line per second, not per frame.
import { appendFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const LOG_PATH = join(tmpdir(), 'video-receiver.log')

export function resetVideoReceiverLog(): void {
  try {
    writeFileSync(LOG_PATH, '')
  } catch {
    /* best-effort */
  }
}

export function logVideoReceiver(who: 'HOST' | 'HELPER', message: string): void {
  const line = `${new Date().toISOString()} [${who}] ${message}\n`
  try {
    appendFileSync(LOG_PATH, line)
  } catch {
    // never let a diagnostic write crash either process
  }
}
