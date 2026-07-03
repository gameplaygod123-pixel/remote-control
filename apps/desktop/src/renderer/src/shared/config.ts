// Dev defaults point at a locally-run signaling server (see server/signaling).
// Phase 4 will replace these with a real deployed URL + a real shared secret.
export const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL ?? 'ws://localhost:8080'
export const AGENT_TOKEN = import.meta.env.VITE_AGENT_TOKEN ?? 'dev-token-change-me'
