import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'

// A stable identity for this controller install, so an agent can recognize
// "this is the same computer I already approved" across separate pairing
// attempts and skip asking again. Stored as a plain file in the main
// process rather than the renderer's localStorage for the same reason as
// trustedControllers.ts -- localStorage is scoped to the Vite dev server's
// origin, which can drift to a different port between runs.
function filePath(): string {
  return join(app.getPath('userData'), 'controller-id.txt')
}

export function getOrCreateControllerId(): string {
  if (existsSync(filePath())) {
    const existing = readFileSync(filePath(), 'utf-8').trim()
    if (existing) return existing
  }
  const id = randomUUID()
  writeFileSync(filePath(), id)
  return id
}
