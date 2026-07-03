import type { SignalTransport } from '../webrtc/peerConnection'

export interface SignalingClient extends SignalTransport {
  close(): void
}

// Sent well under the ~1-2 minute idle-connection timeout typical of free
// tunnels/proxies (e.g. a Cloudflare quick tunnel) so the WebSocket -- and
// the agent's registration/pairing state on the server -- doesn't silently
// die from inactivity between signaling messages.
const HEARTBEAT_INTERVAL_MS = 25_000

// Connects to the real signaling server over WebSocket. Implements the same
// SignalTransport interface as the Phase 1 IPC-relay transport, so
// createPeerConnection() and the pairing/SDP message handlers don't need to
// change when swapping one for the other.
export function connectSignaling(url: string): Promise<SignalingClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const handlers: Array<(message: unknown) => void> = []

    ws.addEventListener('open', () => {
      const heartbeat = setInterval(() => {
        ws.send(JSON.stringify({ type: 'ping' }))
      }, HEARTBEAT_INTERVAL_MS)
      ws.addEventListener('close', () => clearInterval(heartbeat))

      resolve({
        send: (message) => ws.send(JSON.stringify(message)),
        onMessage: (handler) => handlers.push(handler),
        close: () => {
          clearInterval(heartbeat)
          ws.close()
        }
      })
    })

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data as string)
      handlers.forEach((handler) => handler(message))
    })

    ws.addEventListener('error', () => reject(new Error(`failed to connect to ${url}`)))
  })
}
