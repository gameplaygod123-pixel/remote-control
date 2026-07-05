// Diagnostic logging for the input helper, kept permanently: packaged builds
// have no visible console for either the agent main process or the pure-Node
// helper, and this file is what made the session-flapping root cause findable
// at all (see docs/native-input-plan.md). Volume is deliberately light: a few
// dozen lines per session plus one line per ~500 input messages.
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
