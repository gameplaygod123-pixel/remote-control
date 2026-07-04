import { useEffect, useState } from 'react'

export interface VideoStats {
  fps: number
  width: number
  height: number
  kbps: number
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

    const interval = setInterval(() => {
      pc.getStats().then((report) => {
        report.forEach((entry) => {
          if (entry.type !== `${direction}-rtp` || entry.kind !== 'video') return
          const bytes = direction === 'inbound' ? entry.bytesReceived : entry.bytesSent
          const timestamp = entry.timestamp as number
          // bits per ms and kbps (1000 bits/sec) are numerically the same
          // unit, so this needs no further conversion.
          let kbps = 0
          if (prevTimestamp && timestamp > prevTimestamp && typeof bytes === 'number') {
            kbps = Math.round(((bytes - prevBytes) * 8) / (timestamp - prevTimestamp))
          }
          if (typeof bytes === 'number') prevBytes = bytes
          prevTimestamp = timestamp
          setStats({
            fps: Math.round(entry.framesPerSecond ?? 0),
            width: entry.frameWidth ?? 0,
            height: entry.frameHeight ?? 0,
            kbps
          })
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
