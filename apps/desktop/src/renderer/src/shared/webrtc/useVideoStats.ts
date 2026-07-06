import { useEffect, useState } from 'react'

export interface VideoStats {
  fps: number
  width: number
  height: number
  kbps: number
  // Encode time (outbound/agent) or decode time (inbound/controller) per
  // frame, in ms -- Parsec's status bar shows both side by side since it
  // controls the whole pipeline; this app only ever sees its own side, so
  // whichever end renders this hook gets whichever half applies to it.
  processingMs: number
  rttMs: number | null
  codec: string | null
  // Fraction of video packets lost over the last interval, 0-100. Only
  // meaningful inbound (the receiver is the side that counts what didn't
  // arrive); null outbound / when nothing's been received yet. High loss is
  // the classic cause of a "not smooth" feel that lowering the jitter buffer
  // can't fix -- the lever for it is less bitrate/resolution, not less buffer.
  lossPct: number | null
  // Inter-packet arrival variance in ms (inbound RTP `jitter`). High jitter
  // with a zeroed jitter buffer is what shows through as micro-stutter.
  jitterMs: number | null
}

// Shows what's actually happening on the wire (not what was asked for --
// e.g. the 60fps/1080p capture request is only a target, not a guarantee)
// so a "does this feel smooth" question can be answered with real numbers
// instead of guessing whether it's bandwidth, the capture side, or
// something else entirely. `direction` picks which RTP stats to read:
// 'inbound' for the controller watching the stream, 'outbound' for the
// agent encoding it.
export function useVideoStats(
  pc: RTCPeerConnection | null,
  direction: 'inbound' | 'outbound'
): VideoStats | null {
  const [stats, setStats] = useState<VideoStats | null>(null)

  useEffect(() => {
    if (!pc) return undefined // stale `stats` from a previous pc gets masked below, not cleared here

    let prevBytes = 0
    let prevTimestamp = 0
    let prevProcessingTime = 0
    let prevFrames = 0
    let prevPacketsLost = 0
    let prevPacketsReceived = 0

    const interval = setInterval(() => {
      pc.getStats().then((report) => {
        let rttMs: number | null = null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let rtpEntry: any = null

        report.forEach((entry) => {
          if (
            entry.type === 'candidate-pair' &&
            entry.nominated &&
            typeof entry.currentRoundTripTime === 'number'
          ) {
            rttMs = Math.round(entry.currentRoundTripTime * 1000)
          }
          if (entry.type === `${direction}-rtp` && entry.kind === 'video') {
            rtpEntry = entry
          }
        })

        if (!rtpEntry) return

        const bytes = direction === 'inbound' ? rtpEntry.bytesReceived : rtpEntry.bytesSent
        const timestamp = rtpEntry.timestamp as number
        const totalProcessingTime =
          direction === 'inbound' ? rtpEntry.totalDecodeTime : rtpEntry.totalEncodeTime
        const frames = direction === 'inbound' ? rtpEntry.framesDecoded : rtpEntry.framesEncoded

        // bits per ms and kbps (1000 bits/sec) are numerically the same
        // unit, so this needs no further conversion.
        let kbps = 0
        if (prevTimestamp && timestamp > prevTimestamp && typeof bytes === 'number') {
          kbps = Math.round(((bytes - prevBytes) * 8) / (timestamp - prevTimestamp))
        }
        // Both totals are cumulative since the stream started -- averaging
        // over just the last interval (rather than since the start) keeps
        // this responsive to what's happening *right now*.
        let processingMs = 0
        if (
          typeof totalProcessingTime === 'number' &&
          typeof frames === 'number' &&
          frames > prevFrames
        ) {
          processingMs = Math.round(
            ((totalProcessingTime - prevProcessingTime) / (frames - prevFrames)) * 1000
          )
        }

        // Packet loss % and jitter only exist on the inbound side -- the
        // receiver is what tallies sequence-number gaps and arrival timing.
        // Loss is measured over the last interval (delta lost / delta total)
        // so a burst that's since cleared doesn't stay pinned high forever.
        let lossPct: number | null = null
        let jitterMs: number | null = null
        if (direction === 'inbound') {
          const packetsLost = rtpEntry.packetsLost
          const packetsReceived = rtpEntry.packetsReceived
          if (typeof packetsLost === 'number' && typeof packetsReceived === 'number') {
            const dLost = packetsLost - prevPacketsLost
            const dRecv = packetsReceived - prevPacketsReceived
            const dTotal = dLost + dRecv
            if (prevTimestamp && dTotal > 0) lossPct = Math.max(0, (dLost / dTotal) * 100)
            prevPacketsLost = packetsLost
            prevPacketsReceived = packetsReceived
          }
          if (typeof rtpEntry.jitter === 'number') jitterMs = Math.round(rtpEntry.jitter * 1000)
        }

        if (typeof bytes === 'number') prevBytes = bytes
        prevTimestamp = timestamp
        if (typeof totalProcessingTime === 'number') prevProcessingTime = totalProcessingTime
        if (typeof frames === 'number') prevFrames = frames

        const codecEntry = rtpEntry.codecId ? report.get(rtpEntry.codecId) : undefined
        const codec = codecEntry?.mimeType
          ? String(codecEntry.mimeType).replace('video/', '')
          : null

        setStats({
          fps: Math.round(rtpEntry.framesPerSecond ?? 0),
          width: rtpEntry.frameWidth ?? 0,
          height: rtpEntry.frameHeight ?? 0,
          kbps,
          processingMs,
          rttMs,
          codec,
          lossPct,
          jitterMs
        })
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [pc, direction])

  // Derived rather than reset via setState(null) inside the effect above
  // (which would fire synchronously on every pc change, cascading renders)
  // -- no active connection means no current stats, regardless of
  // whatever was last measured.
  return pc ? stats : null
}
