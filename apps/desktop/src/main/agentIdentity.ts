import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

// This machine's device ID, display name, and pairing PIN, persisted as a
// plain file in the main process -- not renderer localStorage, which is
// scoped to the Vite dev server's origin and can drift to a different port
// between runs (see trustedControllers.ts/controllerIdentity.ts for the
// same rationale). The PIN in particular used to come from a VITE_PIN env
// var baked into the launcher scripts, which meant a real PIN sitting in
// plaintext in a file committed to git -- fine while the repo was private,
// not fine once it's public. Now the PIN lives only in this local file, and
// the person at this machine can view/change/regenerate it from the UI.
interface AgentIdentity {
  deviceId?: string
  name?: string
  pin?: string
}

function filePath(): string {
  return join(app.getPath('userData'), 'agent-identity.json')
}

function readAll(): AgentIdentity {
  try {
    if (!existsSync(filePath())) return {}
    return JSON.parse(readFileSync(filePath(), 'utf-8'))
  } catch {
    return {}
  }
}

function writeAll(identity: AgentIdentity): void {
  writeFileSync(filePath(), JSON.stringify(identity))
}

function generateDeviceId(): string {
  return String(Math.floor(100_000_000 + Math.random() * 900_000_000))
}

export function generatePin(): string {
  return String(Math.floor(100_000 + Math.random() * 900_000))
}

export function getOrCreateDeviceId(): string {
  const identity = readAll()
  if (identity.deviceId) return identity.deviceId
  const deviceId = generateDeviceId()
  writeAll({ ...identity, deviceId })
  return deviceId
}

export function getName(): string {
  return readAll().name ?? ''
}

export function setName(name: string): void {
  writeAll({ ...readAll(), name })
}

// Seeds from the legacy VITE_PIN env var on first run only, so machines
// updating from the old hardcoded-PIN setup keep working with their
// existing paired controllers instead of silently getting a new PIN out
// from under them. Every run after that, the persisted file wins.
export function getOrCreatePin(legacyFixedPin?: string): string {
  const identity = readAll()
  if (identity.pin) return identity.pin
  const pin = legacyFixedPin ?? generatePin()
  writeAll({ ...identity, pin })
  return pin
}

export function setPin(pin: string): void {
  writeAll({ ...readAll(), pin })
}

export function regeneratePin(): string {
  const pin = generatePin()
  setPin(pin)
  return pin
}
