import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'

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

// Uninstalling doesn't remove this (or any other userData file) by
// default -- a delete-and-reinstall cycle otherwise silently skips the
// first-run mode picker since getSavedMode() still finds the old choice.
// This is the escape hatch: an explicit in-app "switch mode" action.
export function resetMode(): void {
  if (existsSync(filePath())) unlinkSync(filePath())
}
