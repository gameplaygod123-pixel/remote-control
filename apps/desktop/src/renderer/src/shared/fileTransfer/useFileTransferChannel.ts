import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileReceiver, sendFileOverChannel } from './fileTransferChannel'

export interface TransferState {
  direction: 'send' | 'receive'
  name: string
  progress: number // 0-100
  done: boolean
  error?: string
}

// If neither send progress nor a receive chunk has advanced things for this
// long, treat the transfer as dead rather than leaving the UI frozen at
// some percentage forever with no explanation -- a silently-dropped data
// channel (network hiccup, TURN relay hiccup, etc.) would otherwise look
// identical to "still going, just slow."
const STALL_TIMEOUT_MS = 15_000

// Surfaces the real browser/DOM error text (e.g. "Failed to execute
// 'send' on 'RTCDataChannel': ...") in the UI itself rather than a generic
// "failed to send" -- this app is a packaged install with no accessible
// devtools console, so the UI is the only place a real diagnostic message
// can reach anyone.
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// Shared by AgentView and ControllerSession -- both sides can send and
// receive over the same "file-transfer" data channel (see peerConnection.ts),
// so both use identical send/receive orchestration rather than duplicating
// it per screen.
export function useFileTransferChannel(): {
  transfer: TransferState | null
  attachChannel: (channel: RTCDataChannel) => void
  sendFiles: (files: FileList | File[]) => void
  rejectDrop: (name: string, reason: string) => void
} {
  const [transfer, setTransfer] = useState<TransferState | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const lastProgressAtRef = useRef(0)

  // Only watches while a transfer is actually in flight (not done, no
  // error yet) -- cleared as soon as one ends, one way or another.
  useEffect(() => {
    if (!transfer || transfer.done || transfer.error) return undefined
    const interval = setInterval(() => {
      if (Date.now() - lastProgressAtRef.current > STALL_TIMEOUT_MS) {
        setTransfer((prev) =>
          prev && !prev.done && !prev.error
            ? { ...prev, error: 'stalled -- no response from the other side' }
            : prev
        )
        // The underlying send/receive promise may still be hung waiting on
        // something that'll never happen (e.g. bufferedamountlow on a dead
        // channel) -- give up on displaying it rather than leaving the
        // error banner up forever.
        setTimeout(() => setTransfer(null), 3000)
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [transfer])

  const attachChannel = useCallback((channel: RTCDataChannel) => {
    channel.binaryType = 'arraybuffer'
    channelRef.current = channel
    const receive = createFileReceiver({
      onStart: (name) => {
        lastProgressAtRef.current = Date.now()
        setTransfer({ direction: 'receive', name, progress: 0, done: false })
      },
      onProgress: (receivedBytes, totalBytes) => {
        lastProgressAtRef.current = Date.now()
        setTransfer((prev) =>
          prev ? { ...prev, progress: Math.round((receivedBytes / totalBytes) * 100) } : prev
        )
      },
      onComplete: async (name, data) => {
        try {
          await window.api.fileTransfer.save(name, data)
          setTransfer((prev) => (prev ? { ...prev, progress: 100, done: true } : prev))
        } catch (error) {
          console.error('failed to save received file:', error)
          setTransfer((prev) => (prev ? { ...prev, error: describeError(error) } : prev))
        }
        setTimeout(() => setTransfer(null), 3000)
      }
    })
    channel.onmessage = (event) => {
      try {
        receive(event)
      } catch (error) {
        console.error('file-transfer receive error:', error)
        setTransfer((prev) => (prev ? { ...prev, error: describeError(error) } : prev))
      }
    }
  }, [])

  // For a drop that's rejected before ever reaching sendFiles -- e.g. a
  // folder, which the browser's File/Blob API can't read as byte content
  // at all (that's what a raw NotFoundError from a directory drop actually
  // means, discovered the hard way). Surfaces the same error banner
  // without pretending a transfer was attempted.
  const rejectDrop = useCallback((name: string, reason: string) => {
    setTransfer({ direction: 'send', name, progress: 0, done: false, error: reason })
    setTimeout(() => setTransfer(null), 4000)
  }, [])

  const sendFiles = useCallback((files: FileList | File[]) => {
    const channel = channelRef.current
    if (!channel || channel.readyState !== 'open') return
    const list = Array.from(files)

    ;(async () => {
      for (const file of list) {
        lastProgressAtRef.current = Date.now()
        setTransfer({ direction: 'send', name: file.name, progress: 0, done: false })
        try {
          await sendFileOverChannel(channel, file, (sentBytes, totalBytes) => {
            lastProgressAtRef.current = Date.now()
            setTransfer((prev) =>
              prev ? { ...prev, progress: Math.round((sentBytes / totalBytes) * 100) } : prev
            )
          })
          setTransfer((prev) => (prev ? { ...prev, progress: 100, done: true } : prev))
        } catch (error) {
          console.error('file-transfer send error:', error)
          setTransfer((prev) => (prev ? { ...prev, error: describeError(error) } : prev))
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      setTransfer(null)
    })()
  }, [])

  return { transfer, attachChannel, sendFiles, rejectDrop }
}
