import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

export type Theme = 'dark' | 'light'

// The controller's light/dark choice, persisted in userData like the app
// mode and house token so it survives updates and reinstalls. Dark ("Amber
// Dark") is the default -- the look the app has always shipped with.
function filePath(): string {
  return join(app.getPath('userData'), 'theme.txt')
}

export function getTheme(): Theme {
  try {
    if (existsSync(filePath())) {
      const saved = readFileSync(filePath(), 'utf-8').trim()
      if (saved === 'light' || saved === 'dark') return saved
    }
  } catch {
    /* unreadable -> default */
  }
  return 'dark'
}

export function saveTheme(theme: Theme): void {
  writeFileSync(filePath(), theme === 'light' ? 'light' : 'dark')
}
