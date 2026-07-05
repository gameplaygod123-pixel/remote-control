// TEMP diagnostic logging for the helper-session-flapping investigation
// (see docs/native-input-plan.md). Packaged builds have no visible console
// for either the agent's main process or the pure-Node input-helper process,
// so both write to a shared file instead. Remove once the root cause is
// confirmed and fixed.
import { appendFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const LOG_PATH = join(tmpdir(), 'input-helper.log')

export function resetInputHelperLog(): void {
  writeFileSync(LOG_PATH, '')
}

export function logInputHelper(who: 'HOST' | 'HELPER', message: string): void {
  const line = `${new Date().toISOString()} [${who}] ${message}\n`
  try {
    appendFileSync(LOG_PATH, line)
  } catch {
    // best-effort diagnostic logging -- never let a log write crash either process
  }
}
