// A stable identity for this controller install, so an agent can recognize
// "this is the same computer I already approved" across separate pairing
// attempts and skip asking again. Unlike the agent's human-typed numeric
// deviceId, nobody types this, so a UUID is fine.
const STORAGE_KEY = 'remote-control-controller-id'

export function getOrCreateControllerId(): string {
  const existing = localStorage.getItem(STORAGE_KEY)
  if (existing) return existing
  const id = crypto.randomUUID()
  localStorage.setItem(STORAGE_KEY, id)
  return id
}
