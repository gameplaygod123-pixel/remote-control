import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

// Cached PINs (so re-connecting to an already-approved device from the list
// doesn't ask again) and the most recently connected device (so the app can
// jump straight back into a session on next launch instead of always
// landing on the picker). Persisted as a plain file in the main process,
// not renderer localStorage -- see trustedControllers.ts for why: this
// app's renderer loads from a Vite dev server whose port isn't actually
// fixed, and localStorage is scoped per-origin.
interface Memory {
  lastDeviceId?: string
  pins: Record<string, string>
}

function filePath(): string {
  return join(app.getPath('userData'), 'controller-memory.json')
}

function readAll(): Memory {
  try {
    if (!existsSync(filePath())) return { pins: {} }
    const parsed = JSON.parse(readFileSync(filePath(), 'utf-8'))
    return { lastDeviceId: parsed.lastDeviceId, pins: parsed.pins ?? {} }
  } catch {
    return { pins: {} }
  }
}

function writeAll(mem: Memory): void {
  writeFileSync(filePath(), JSON.stringify(mem))
}

export function getCachedPin(deviceId: string): string | undefined {
  return readAll().pins[deviceId]
}

export function setCachedPin(deviceId: string, pin: string): void {
  const mem = readAll()
  mem.pins[deviceId] = pin
  writeAll(mem)
}

export function clearCachedPin(deviceId: string): void {
  const mem = readAll()
  delete mem.pins[deviceId]
  if (mem.lastDeviceId === deviceId) delete mem.lastDeviceId
  writeAll(mem)
}

export function setLastDeviceId(deviceId: string): void {
  const mem = readAll()
  mem.lastDeviceId = deviceId
  writeAll(mem)
}

// Only returns a device to auto-connect to if its PIN is still cached --
// no point jumping into a session that would just prompt for a PIN anyway.
export function getLastDevice(): { deviceId: string; pin: string } | null {
  const mem = readAll()
  if (!mem.lastDeviceId) return null
  const pin = mem.pins[mem.lastDeviceId]
  if (!pin) return null
  return { deviceId: mem.lastDeviceId, pin }
}
