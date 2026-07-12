// Diagnostic logging for the native video sender (host + helper), mirroring
// inputHelperLog.ts. Packaged builds have no visible console for the Electron
// main process or the forked helper, and per golden rule #1 the native video
// path must be verifiable on the real Windows machine -- this file is where that
// evidence lands (%TEMP%\video-sender.log). Volume is light: lifecycle lines +
// one stats line per second, not per frame.
import { appendFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const LOG_PATH = join(tmpdir(), 'video-sender.log')

export function resetVideoSenderLog(): void {
  try {
    writeFileSync(LOG_PATH, '')
  } catch {
    /* best-effort */
  }
}

export function logVideoSender(who: 'HOST' | 'HELPER', message: string): void {
  const line = `${new Date().toISOString()} [${who}] ${message}\n`
  try {
    appendFileSync(LOG_PATH, line)
  } catch {
    // never let a diagnostic write crash either process
  }
}
