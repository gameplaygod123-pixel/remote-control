import type { SignalTransport } from '../webrtc/peerConnection'

export interface SignalingClient extends SignalTransport {
  close(): void
}

export interface ConnectSignalingOptions {
  // Fired after every RECONNECT (not the initial connect -- that's when the
  // returned promise resolves). Use this to redo registration/pairing,
  // since the server forgets all state (who's registered, who's paired)
  // the moment a connection drops.
  onReconnect?: () => void
  // Fired when a previously-open connection drops, before a reconnect
  // attempt is scheduled. Useful for reflecting "reconnecting..." in the UI.
  onDisconnect?: () => void
}

// Sent well under the ~1-2 minute idle-connection timeout typical of free
// tunnels/proxies (e.g. a Cloudflare quick tunnel) so the WebSocket doesn't
// silently die from inactivity between signaling messages.
const HEARTBEAT_INTERVAL_MS = 25_000

// Reconnect backoff after a real drop (network blip, tunnel restart, etc.).
// Capped at 30s so it doesn't hammer the server but still recovers promptly.
const RECONNECT_MIN_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000

// Connects to the real signaling server over WebSocket, with automatic
// reconnection on drop. Implements the same SignalTransport interface as
// the Phase 1 IPC-relay transport, so createPeerConnection() and the
// pairing/SDP message handlers don't need to change when swapping one for
// the other.
//
// `url` can be a resolver function instead of a fixed string -- it's then
// re-invoked on every reconnect attempt, so a signaling URL that changed
// while this client was already running (a restarted Cloudflare quick
// tunnel; see resolveSignalingUrl.ts) gets picked up without an app
// restart. A long-lived tray agent depends on this to ever find its way
// back after the tunnel moves.
export function connectSignaling(
  url: string | (() => Promise<string>),
  options: ConnectSignalingOptions = {}
): Promise<SignalingClient> {
  const handlers: Array<(message: unknown) => void> = []
  let ws: WebSocket | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectDelay = RECONNECT_MIN_DELAY_MS
  let stopped = false
  let settled = false

  const client: SignalingClient = {
    send: (message) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    },
    onMessage: (handler) => handlers.push(handler),
    close: () => {
      stopped = true
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    }
  }

  return new Promise((resolve) => {
    async function connectOnce(): Promise<void> {
      const target = typeof url === 'string' ? url : await url()
      if (stopped) return // close() may have been called while resolving
      const socket = new WebSocket(target)
      ws = socket

      socket.addEventListener('open', () => {
        reconnectDelay = RECONNECT_MIN_DELAY_MS
        heartbeatTimer = setInterval(() => {
          socket.send(JSON.stringify({ type: 'ping' }))
        }, HEARTBEAT_INTERVAL_MS)

        if (!settled) {
          settled = true
          resolve(client)
        } else {
          options.onReconnect?.()
        }
      })

      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data as string)
        handlers.forEach((handler) => handler(message))
      })

      socket.addEventListener('close', () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        if (stopped) return

        // The *initial* attempt failing used to reject and give up -- which
        // stranded an agent that started while the published tunnel URL was
        // mid-rotation: it showed "failed to connect" forever even though a
        // working URL appeared on GitHub minutes later. Retry the first
        // connect exactly like a reconnect (each attempt re-resolves the
        // URL); the promise simply resolves on whichever attempt succeeds
        // first, and callers' onReconnect/registration flow is unaffected
        // since it only fires after `settled`.
        options.onDisconnect?.()
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS)
          void connectOnce()
        }, reconnectDelay)
      })
    }

    void connectOnce()
  })
}
