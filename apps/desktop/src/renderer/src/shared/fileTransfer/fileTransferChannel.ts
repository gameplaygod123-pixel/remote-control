// File transfer over a dedicated WebRTC data channel (see peerConnection.ts's
// "file-transfer" channel) -- deliberately separate from the "input" channel
// so a large file doesn't head-of-line-block mouse/keyboard delivery on the
// same ordered channel. Bidirectional: whichever side calls sendFileOverChannel
// sends, whichever side has createFileReceiver attached to onmessage receives --
// same channel object works either way once open, like the input channel does.

// Was briefly bumped to 64KB to reduce per-message overhead, but that
// broke a real transfer with "failed to send" -- RTCDataChannel.send()
// throws synchronously if a single message exceeds the max message size
// actually negotiated between the two peers for this connection (SCTP's
// negotiated limit, which isn't something this app controls or can query
// in advance). 16KB is the conservative, near-universally-safe value and
// is back to being the known-good baseline; not worth risking another
// silent-ish failure for a modest speed gain that wasn't the real
// bottleneck anyway (see connectionType.ts -- relay bandwidth, not chunk
// size, is the usual culprit for a genuinely slow transfer).
const CHUNK_SIZE = 16 * 1024

// Pause sending once this much is buffered locally, resuming on
// `bufferedamountlow` -- without this, blasting a large file into `send()`
// as fast as possible can balloon memory/latency far ahead of what the
// other side has actually received.
const BUFFERED_AMOUNT_LOW_THRESHOLD = 1024 * 1024

type ControlMessage = { t: 'file-start'; name: string; size: number } | { t: 'file-end' }

export async function sendFileOverChannel(
  channel: RTCDataChannel,
  file: File,
  onProgress: (sentBytes: number, totalBytes: number) => void
): Promise<void> {
  channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD
  const start: ControlMessage = { t: 'file-start', name: file.name, size: file.size }
  channel.send(JSON.stringify(start))

  // Read the whole file into memory *immediately*, before any of the
  // network-paced backpressure delay below -- a `File` picked up from a
  // drag-and-drop isn't guaranteed to stay readable indefinitely (seen on
  // Windows: `file.slice(...).arrayBuffer()` failing partway through a
  // slow transfer with a NotFoundError, as if the underlying OS-level
  // reference had gone stale). Once read into a plain ArrayBuffer, the
  // data has no such dependency and can be chunked/paced freely.
  const buffer = await file.arrayBuffer()

  function waitForDrain(): Promise<void> {
    if (channel.bufferedAmount <= BUFFERED_AMOUNT_LOW_THRESHOLD) return Promise.resolve()
    return new Promise((resolve) => {
      channel.addEventListener(
        'bufferedamountlow',
        function handler() {
          channel.removeEventListener('bufferedamountlow', handler)
          resolve()
        },
        { once: true }
      )
    })
  }

  let offset = 0
  while (offset < buffer.byteLength) {
    await waitForDrain()
    const chunk = buffer.slice(offset, offset + CHUNK_SIZE)
    channel.send(chunk)
    offset += chunk.byteLength
    onProgress(offset, buffer.byteLength)
  }

  const end: ControlMessage = { t: 'file-end' }
  channel.send(JSON.stringify(end))
}

// Only one transfer in flight per direction at a time -- plenty for a
// personal tool, and avoids needing per-chunk transfer IDs: channel
// ordering guarantees every binary chunk between a file-start and the next
// file-end belongs to that one transfer.
export function createFileReceiver(handlers: {
  onStart: (name: string, size: number) => void
  onProgress: (receivedBytes: number, totalBytes: number) => void
  onComplete: (name: string, data: Uint8Array) => void
}): (event: MessageEvent) => void {
  let expectedName = ''
  let expectedSize = 0
  let chunks: Uint8Array[] = []
  let received = 0

  return (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data) as ControlMessage
      if (message.t === 'file-start') {
        expectedName = message.name
        expectedSize = message.size
        chunks = []
        received = 0
        handlers.onStart(message.name, message.size)
      } else if (message.t === 'file-end') {
        const combined = new Uint8Array(received)
        let pos = 0
        for (const chunk of chunks) {
          combined.set(chunk, pos)
          pos += chunk.length
        }
        chunks = []
        received = 0
        handlers.onComplete(expectedName, combined)
      }
      return
    }
    const chunk = new Uint8Array(event.data as ArrayBuffer)
    chunks.push(chunk)
    received += chunk.length
    if (expectedSize) handlers.onProgress(received, expectedSize)
  }
}
