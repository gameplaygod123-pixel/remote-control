import { useCallback, useRef, useState } from 'react'
import { createFileReceiver, sendFileOverChannel } from './fileTransferChannel'

export interface TransferState {
  direction: 'send' | 'receive'
  name: string
  progress: number // 0-100
  done: boolean
}

// Shared by AgentView and ControllerSession -- both sides can send and
// receive over the same "file-transfer" data channel (see peerConnection.ts),
// so both use identical send/receive orchestration rather than duplicating
// it per screen.
export function useFileTransferChannel(): {
  transfer: TransferState | null
  attachChannel: (channel: RTCDataChannel) => void
  sendFiles: (files: FileList | File[]) => void
} {
  const [transfer, setTransfer] = useState<TransferState | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)

  const attachChannel = useCallback((channel: RTCDataChannel) => {
    channel.binaryType = 'arraybuffer'
    channelRef.current = channel
    channel.onmessage = createFileReceiver({
      onStart: (name) => setTransfer({ direction: 'receive', name, progress: 0, done: false }),
      onProgress: (receivedBytes, totalBytes) =>
        setTransfer((prev) =>
          prev ? { ...prev, progress: Math.round((receivedBytes / totalBytes) * 100) } : prev
        ),
      onComplete: async (name, data) => {
        try {
          await window.api.fileTransfer.save(name, data)
          setTransfer((prev) => (prev ? { ...prev, progress: 100, done: true } : prev))
        } catch (error) {
          console.error('failed to save received file:', error)
          setTransfer(null)
        }
        setTimeout(() => setTransfer(null), 3000)
      }
    })
  }, [])

  const sendFiles = useCallback((files: FileList | File[]) => {
    const channel = channelRef.current
    if (!channel || channel.readyState !== 'open') return
    const list = Array.from(files)

    ;(async () => {
      for (const file of list) {
        setTransfer({ direction: 'send', name: file.name, progress: 0, done: false })
        await sendFileOverChannel(channel, file, (sentBytes, totalBytes) =>
          setTransfer((prev) =>
            prev ? { ...prev, progress: Math.round((sentBytes / totalBytes) * 100) } : prev
          )
        )
        setTransfer((prev) => (prev ? { ...prev, progress: 100, done: true } : prev))
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      setTransfer(null)
    })()
  }, [])

  return { transfer, attachChannel, sendFiles }
}
