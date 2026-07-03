import type { SignalTransport } from '../webrtc/peerConnection'

export interface SignalingClient extends SignalTransport {
  close(): void
}

// Connects to the real signaling server over WebSocket. Implements the same
// SignalTransport interface as the Phase 1 IPC-relay transport, so
// createPeerConnection() and the pairing/SDP message handlers don't need to
// change when swapping one for the other.
export function connectSignaling(url: string): Promise<SignalingClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const handlers: Array<(message: unknown) => void> = []

    ws.addEventListener('open', () => {
      resolve({
        send: (message) => ws.send(JSON.stringify(message)),
        onMessage: (handler) => handlers.push(handler),
        close: () => ws.close()
      })
    })

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data as string)
      handlers.forEach((handler) => handler(message))
    })

    ws.addEventListener('error', () => reject(new Error(`failed to connect to ${url}`)))
  })
}
