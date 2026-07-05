// Headless file push: pair with an agent and send files over the
// file-transfer data channel WITHOUT opening a control session UI. Used by
// the controller's File Transfer page to fan files out to several machines
// at once -- one independent signaling connection + peer connection per
// target, so pushes can't interfere with each other.
//
// Deliberately sends NO `caps` in its pair-request: the agent then treats
// this as a legacy (pre-input-helper) controller and serves everything --
// including the file channel -- on a single renderer-owned video pc, which
// keeps the agent's native input helper completely out of the loop for a
// mere file drop. The video track that comes along is simply never attached
// to any element.
//
// Known sharp edge, acceptable at personal/family scale: an agent only
// serves ONE controller at a time (a new pairing replaces the old), so
// pushing files to a machine that someone is actively controlling will kick
// that session.

import { connectSignaling, type SignalingClient } from '../signaling/signalingClient'
import { resolveSignalingUrl } from '../signaling/resolveSignalingUrl'
import { createPeerConnection, type SignalTransport } from '../webrtc/peerConnection'
import { SignalingMessage } from '../protocol'
import { sendFileOverChannel, type SendableFile } from './fileTransferChannel'

export type PushPhase =
  | 'connecting' // reaching the signaling server
  | 'pairing' // pair-request sent, waiting for pair-result
  | 'awaiting-approval' // correct PIN, waiting for a human at the agent
  | 'preparing' // paired, negotiating the peer connection / channel
  | 'sending'
  | 'done'
  | 'error'

export interface PushUpdate {
  phase: PushPhase
  // Only meaningful while sending:
  fileName?: string
  fileIndex?: number // 1-based
  fileCount?: number
  percent?: number
  error?: string
}

// Generous because "awaiting approval" legitimately takes as long as a human
// walk to the other machine; the server itself gives up on approval after
// 30s, which surfaces here as a pair-result failure well before this fires.
const SETUP_TIMEOUT_MS = 60_000

// No delivered-bytes progress for this long during sending = the transfer is
// wedged; fail it rather than freezing the row (the second-consecutive-send
// hang this was written to catch).
const STALL_TIMEOUT_MS = 20_000

export async function pushFilesToDevice(
  deviceId: string,
  pin: string,
  files: SendableFile[],
  onUpdate: (update: PushUpdate) => void
): Promise<void> {
  onUpdate({ phase: 'connecting' })

  const houseToken = (await window.api.houseToken.get()) ?? ''
  const controllerId = await window.api.controllerId.get()

  // connectSignaling retries forever and never rejects -- race a timeout so
  // one unreachable-server push doesn't hang its row indefinitely, but still
  // close the client whenever the retry loop does eventually win.
  const clientPromise = connectSignaling(resolveSignalingUrl)
  let timedOut = false
  const client: SignalingClient = await Promise.race<SignalingClient>([
    clientPromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        timedOut = true
        reject(new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'))
      }, 15_000)
    )
  ]).catch((error) => {
    if (timedOut) void clientPromise.then((c) => c.close())
    throw error
  })

  // Held in an object property: assignments inside the message callback are
  // invisible to TS's flow analysis, which would otherwise narrow a plain
  // `let pc` to null/never at the finally below.
  const held: { pc: RTCPeerConnection | null } = { pc: null }
  // Hoisted so the finally can always clear them, whichever way the promise
  // settles (resolve, reject, or a throw from an await inside a handler).
  const timers: { setup?: ReturnType<typeof setTimeout>; stall?: ReturnType<typeof setInterval> } =
    {}
  try {
    await new Promise<void>((resolve, reject) => {
      const transport: SignalTransport = {
        send: (message) => client.send(message),
        onMessage: (handler) => client.onMessage(handler)
      }

      // Covers everything up to the file channel actually opening; the send
      // itself can legitimately run for minutes and is not under this timer.
      timers.setup = setTimeout(
        () => reject(new Error('การเจรจาเชื่อมต่อค้างนานเกินไป')),
        SETUP_TIMEOUT_MS
      )

      // Watchdog for a wedged transfer: if the delivered-bytes figure hasn't
      // advanced in this long, the channel is dead (peer gone, relay stalled)
      // -- fail loudly instead of leaving the row frozen forever. Reset on
      // every progress tick.
      let lastProgressAt = Date.now()
      timers.stall = setInterval(() => {
        if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
          reject(new Error('การส่งค้าง — ลองใหม่อีกครั้ง'))
        }
      }, 2_000)

      // The file channel can surface twice (onopen AND an already-open
      // readyState check below); a second sendAll on the same channel would
      // interleave a duplicate byte stream and corrupt the transfer.
      let started = false
      async function sendAll(channel: RTCDataChannel): Promise<void> {
        if (started) return
        started = true
        clearTimeout(timers.setup)
        channel.binaryType = 'arraybuffer'
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          onUpdate({
            phase: 'sending',
            fileName: file.name,
            fileIndex: i + 1,
            fileCount: files.length,
            percent: 0
          })
          await sendFileOverChannel(
            channel,
            file,
            (sent, total) => {
              lastProgressAt = Date.now()
              onUpdate({
                phase: 'sending',
                fileName: file.name,
                fileIndex: i + 1,
                fileCount: files.length,
                percent: Math.round((sent / total) * 100)
              })
            },
            () => false
          )
        }
        // Give the last file-end message a moment to flush before the pc is
        // torn down -- data channels have no "everything delivered" signal.
        await new Promise((r) => setTimeout(r, 1_000))
        onUpdate({ phase: 'done' })
        resolve()
      }

      transport.onMessage(async (raw) => {
        const parsed = SignalingMessage.safeParse(raw)
        if (!parsed.success) return
        const message = parsed.data
        try {
          if (message.type === 'pairing-pending') {
            onUpdate({ phase: 'awaiting-approval' })
          } else if (message.type === 'pair-result') {
            if (!message.ok) {
              reject(new Error(message.reason ?? 'pairing failed'))
            } else {
              onUpdate({ phase: 'preparing' })
            }
          } else if (message.type === 'sdp-offer' && (message.channel ?? 'video') === 'video') {
            held.pc = createPeerConnection(transport, deviceId, {
              onFileChannel: (channel) => {
                channel.onopen = () => void sendAll(channel).catch(reject)
                // Guard against the open having already happened before this
                // handler was assigned (possible with ondatachannel timing).
                if (channel.readyState === 'open') void sendAll(channel).catch(reject)
              }
            })
            await held.pc.setRemoteDescription({ type: 'offer', sdp: message.sdp })
            const answer = await held.pc.createAnswer()
            await held.pc.setLocalDescription(answer)
            transport.send({ type: 'sdp-answer', deviceId, sdp: answer.sdp, channel: 'video' })
          } else if (
            message.type === 'ice-candidate' &&
            (message.channel ?? 'video') === 'video' &&
            held.pc
          ) {
            await held.pc.addIceCandidate({
              candidate: message.candidate,
              sdpMid: message.sdpMid,
              sdpMLineIndex: message.sdpMLineIndex ?? undefined
            })
          } else if (message.type === 'server-error') {
            reject(new Error(message.reason))
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })

      onUpdate({ phase: 'pairing' })
      client.send({ type: 'pair-request', token: houseToken, deviceId, pin, controllerId })
    })
  } finally {
    clearTimeout(timers.setup)
    clearInterval(timers.stall)
    held.pc?.close()
    client.close()
  }
}
