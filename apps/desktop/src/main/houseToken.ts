import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

// The pre-shared "house token" every install (agent AND controller) must
// present to the signaling server -- agents to register, controllers to
// list/pair/remove devices. It's the outer gate that keeps strangers who
// found the public signaling URL from even reaching the PIN check.
//
// Entered once on first launch (see setup/TokenSetupView) and persisted in
// userData like the app mode -- it survives auto-updates and
// uninstall/reinstall, so it really is a one-time step per machine. It must
// NOT be baked in at build time: the installers sit on a public GitHub
// releases page, so anything compiled in is public too (that's exactly what
// happened with the original dev default).
function filePath(): string {
  return join(app.getPath('userData'), 'house-token.txt')
}

export function getHouseToken(): string | null {
  // Env override first: lets dev harnesses and tests point at a local
  // server without touching the real saved token.
  if (process.env.HOUSE_TOKEN) return process.env.HOUSE_TOKEN
  try {
    if (existsSync(filePath())) {
      const saved = readFileSync(filePath(), 'utf-8').trim()
      if (saved) return saved
    }
  } catch {
    /* unreadable -> treat as unset; the first-launch prompt will show */
  }
  // Dev fallback matching the server's own default, so `pnpm dev` against a
  // local signaling server keeps working with zero setup. Packaged installs
  // get null, which routes the renderer to the token-setup screen.
  return app.isPackaged ? null : 'dev-token-change-me'
}

export function saveHouseToken(token: string): void {
  writeFileSync(filePath(), token.trim())
}
