// Remembers the PIN used for each device after a manual connect, so
// re-connecting from the device list later doesn't require typing it again.
// If a remembered PIN turns out to be wrong (device's PIN changed), the
// caller should clear it so the user is prompted again.
const STORAGE_KEY = 'remote-control-device-pins'

function readAll(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function getCachedPin(deviceId: string): string | undefined {
  return readAll()[deviceId]
}

export function setCachedPin(deviceId: string, pin: string): void {
  const all = readAll()
  all[deviceId] = pin
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export function clearCachedPin(deviceId: string): void {
  const all = readAll()
  delete all[deviceId]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}
