import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

// Deliberately a plain file in the main process rather than the renderer's
// localStorage: this app runs its renderer off a Vite dev server
// (http://localhost:PORT), and localStorage is scoped per-origin -- if the
// port ever shifts between runs (Vite falls back to another port whenever
// the usual one is still occupied, which has happened more than once
// during this project's development), the "same" agent would silently
// see a completely empty trust list. A file keyed only by the OS user
// profile has no such dependency.
export interface TrustedController {
  id: string
  trustedAt: number
}

function filePath(): string {
  return join(app.getPath('userData'), 'trusted-controllers.json')
}

function readAll(): TrustedController[] {
  try {
    if (!existsSync(filePath())) return []
    const parsed = JSON.parse(readFileSync(filePath(), 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(list: TrustedController[]): void {
  writeFileSync(filePath(), JSON.stringify(list))
}

export function getTrustedControllers(): TrustedController[] {
  return readAll()
}

export function isTrustedController(id: string): boolean {
  return readAll().some((c) => c.id === id)
}

export function trustController(id: string): void {
  const all = readAll()
  if (all.some((c) => c.id === id)) return
  writeAll([...all, { id, trustedAt: Date.now() }])
}

// Revoking just means the next connection attempt from this controller has
// to go through the accept/reject prompt again -- its PIN still works the
// same as always, this is purely about skipping the human confirmation.
export function revokeController(id: string): void {
  writeAll(readAll().filter((c) => c.id !== id))
}
