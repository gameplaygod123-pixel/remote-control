import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

export type AppMode = 'agent' | 'controller'

// Lets a packaged, double-click-to-run install remember which mode the
// person picked on first launch (see the choose-mode screen in
// main/index.ts) instead of needing an APP_MODE environment variable set
// up for them, which isn't practical for an installed .exe/.app.
function filePath(): string {
  return join(app.getPath('userData'), 'app-mode.json')
}

export function getSavedMode(): AppMode | null {
  try {
    if (!existsSync(filePath())) return null
    const parsed = JSON.parse(readFileSync(filePath(), 'utf-8'))
    return parsed.mode === 'agent' || parsed.mode === 'controller' ? parsed.mode : null
  } catch {
    return null
  }
}

export function saveMode(mode: AppMode): void {
  writeFileSync(filePath(), JSON.stringify({ mode }))
}
