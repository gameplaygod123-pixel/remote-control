import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

export type Theme = 'dark' | 'light' | 'glass'

const THEMES: readonly Theme[] = ['dark', 'light', 'glass']

// The controller's theme choice, persisted in userData like the app mode and
// house token so it survives updates and reinstalls. Dark ("Amber Dark") is
// the default -- the look the app has always shipped with. 'glass' is the
// translucent see-through theme (only the macOS controller window is created
// transparent, so on other platforms it degrades to a solid dark tint).
function filePath(): string {
  return join(app.getPath('userData'), 'theme.txt')
}

export function getTheme(): Theme {
  try {
    if (existsSync(filePath())) {
      const saved = readFileSync(filePath(), 'utf-8').trim()
      if ((THEMES as readonly string[]).includes(saved)) return saved as Theme
    }
  } catch {
    /* unreadable -> default */
  }
  return 'dark'
}

export function saveTheme(theme: Theme): void {
  writeFileSync(filePath(), THEMES.includes(theme) ? theme : 'dark')
}
