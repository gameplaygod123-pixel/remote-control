import { SIGNALING_URL } from '../config'

// The signaling server sits behind a Cloudflare *quick* tunnel, whose URL
// changes every time the tunnel restarts. Baking that URL into the build
// meant every restart required rebuilding and re-releasing the app to all
// machines (v1.11.0 shipped broken for exactly this class of reason).
// Instead, installed builds fetch the current URL from a tiny JSON file in
// the app's own GitHub repo -- raw.githubusercontent.com is free, stable,
// and CORS-open -- so a tunnel restart is fixed by editing one file
// (signaling-url.json at the repo root), no rebuild, no reinstall.
const REMOTE_CONFIG_URL =
  'https://raw.githubusercontent.com/gameplaygod123-pixel/remote-control/main/signaling-url.json'

const FETCH_TIMEOUT_MS = 5000

// Called on every (re)connect attempt, not just startup -- an agent that
// sits in the tray for days must pick up a changed URL without a restart.
// raw.githubusercontent.com caches for ~5 minutes, which bounds how stale
// a fetch can be; the signaling client's reconnect loop retries anyway.
// Never throws: any failure (offline, GitHub down, malformed file) falls
// back to the URL baked in at build time.
export async function resolveSignalingUrl(): Promise<string> {
  // Dev runs (pnpm dev) keep using the env var / localhost default --
  // pointing a dev instance at the production signaling server just
  // because it's listed on GitHub would make local testing impossible.
  if (import.meta.env.DEV) return SIGNALING_URL
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const response = await fetch(REMOTE_CONFIG_URL, {
      signal: controller.signal,
      cache: 'no-store'
    })
    clearTimeout(timer)
    if (response.ok) {
      const { url } = (await response.json()) as { url?: unknown }
      if (typeof url === 'string' && /^wss?:\/\//.test(url)) return url
    }
  } catch {
    // offline or GitHub unreachable -- fall through to the baked URL
  }
  return SIGNALING_URL
}
