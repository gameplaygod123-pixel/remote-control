// Verification RECEIVER peer (dev-only) — stands in for the Mac native receiver.
//
// A minimal node-datachannel answerer: accepts the sender helper's H.264 track,
// counts delivered frames (RTP marker bit), and after a burst calls
// requestKeyframe() to exercise item A (PLI -> the helper should force an IDR).
// Not production — the real receiver is native Mac code (VideoToolbox). Driven by
// dev/verify.mjs, which relays SDP/ICE between this peer and the real helper.

import nd from 'node-datachannel'

const { PeerConnection, RtcpReceivingSession } = nd
const pc = new PeerConnection('verify-receiver', { iceServers: [] })

const state = { packets: 0, frames: 0, bytes: 0, seenTs: new Set(), pliCalls: 0, pliTrue: 0 }

pc.onLocalDescription((sdp, type) => process.send({ t: 'sig', kind: 'sdp', sdp, type }))
pc.onLocalCandidate((candidate, mid) => process.send({ t: 'sig', kind: 'ice', candidate, mid }))
pc.onStateChange((s) => process.send({ t: 'log', line: `receiver pc state=${s}` }))

process.on('message', (m) => {
  if (m?.t !== 'sig') return
  if (m.kind === 'sdp') {
    pc.setRemoteDescription(m.sdp, m.type)
    if (m.type === 'offer') pc.setLocalDescription() // -> answer
  } else if (m.kind === 'ice') {
    pc.addRemoteCandidate(m.candidate, m.mid ?? '')
  }
})

// marker bit + first-packet-of-frame detection (same as phase0 media-loopback)
function rtpInfo(buf) {
  if (buf.length < 12) return null
  const cc = buf[0] & 0x0f
  const ext = (buf[0] & 0x10) !== 0
  const marker = (buf[1] & 0x80) !== 0
  const timestamp = buf.readUInt32BE(4)
  let off = 12 + cc * 4
  if (ext) {
    if (buf.length < off + 4) return null
    off += 4 + buf.readUInt16BE(off + 2) * 4
  }
  return { marker, timestamp, off }
}

pc.onTrack((track) => {
  process.send({ t: 'log', line: `receiver onTrack mid=${track.mid()} type=${track.type()}` })
  track.setMediaHandler(new RtcpReceivingSession())
  track.onMessage((msg) => {
    const info = rtpInfo(msg)
    if (!info) return
    state.packets++
    state.bytes += msg.length
    if (info.marker && !state.seenTs.has(info.timestamp)) {
      state.seenTs.add(info.timestamp)
      state.frames++
      // Item A: once a stream is flowing, ask for a keyframe. The REAL helper
      // parses this PLI on its send track and forces an IDR (proven via its log).
      if (state.frames === 40) {
        for (let i = 0; i < 3; i++) {
          const ok = track.requestKeyframe()
          state.pliCalls++
          if (ok) state.pliTrue++
        }
        process.send({ t: 'log', line: `receiver sent ${state.pliCalls} requestKeyframe() (true=${state.pliTrue})` })
      }
    }
  })
})

// periodic + final report to the parent
const iv = setInterval(() => process.send({ t: 'progress', frames: state.frames, packets: state.packets }), 1000)
process.on('message', (m) => {
  if (m?.t === 'report-now') {
    clearInterval(iv)
    process.send({
      t: 'report',
      frames: state.frames,
      packets: state.packets,
      mbps: (state.bytes * 8) / 1e6,
      pliCalls: state.pliCalls,
      pliTrue: state.pliTrue
    })
  }
})
