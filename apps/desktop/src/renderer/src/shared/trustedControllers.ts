// Controllers the operator of this agent has already accepted at least
// once. Trust lives here (the agent's own localStorage) rather than on the
// signaling server, since the server's in-memory state resets on restart
// and the whole point is for this to survive that -- the agent machine is
// the one whose security decision this actually is.
const STORAGE_KEY = 'remote-control-trusted-controllers'

export interface TrustedController {
  id: string
  trustedAt: number
}

function readAll(): TrustedController[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(list: TrustedController[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
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
