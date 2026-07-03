// Dev defaults point at a locally-run signaling server (see server/signaling).
// Phase 4 will replace these with a real deployed URL + a real shared secret.
export const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL ?? 'ws://localhost:8080'
export const AGENT_TOKEN = import.meta.env.VITE_AGENT_TOKEN ?? 'dev-token-change-me'

// Optional: for personal unattended-access use (both machines belong to the
// same person), set a fixed PIN instead of the default rotating one-time
// PIN, and/or have the controller auto-connect without a manual form.
// Set the SAME value for VITE_PIN on both the agent and controller when
// launching, plus VITE_DEVICE_ID on the controller matching the agent's ID.
export const FIXED_PIN = import.meta.env.VITE_PIN as string | undefined
export const AUTO_CONNECT_DEVICE_ID = import.meta.env.VITE_DEVICE_ID as string | undefined
