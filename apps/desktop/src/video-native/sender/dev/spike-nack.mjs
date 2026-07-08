// SPIKE (STEP 3a): does the native video pipeline's ndc setup negotiate NACK
// retransmission? Mirrors sender/index.ts (Video SendOnly + addH26xCodec +
// H26xRtpPacketizer + RtcpSrReporter + RtcpNackResponder) and receiver/index.ts
// (RtcpReceivingSession) as a single-process LOOPBACK, then dumps both SDPs and
// reports whether `a=rtcp-fb:96 nack` / `nack pli` are present.
//
//   node src/video-native/sender/dev/spike-nack.mjs [h264|h265]
//
// Decisive for STEP 3a: if the offer/answer carry `nack` feedback, the sender's
// RtcpNackResponder will retransmit and the only missing piece is the receiver
// SENDING NACKs (RtcpReceivingSession) + a shallow receive buffer. If `nack` is
// absent, NACK is not negotiated at all and we'd have to add the feedback line.

import ndc from 'node-datachannel'

const {
  PeerConnection,
  Video,
  RtpPacketizationConfig,
  H264RtpPacketizer,
  H265RtpPacketizer,
  RtcpSrReporter,
  RtcpNackResponder,
  RtcpReceivingSession
} = ndc

const codec = (process.argv[2] || 'h265').toLowerCase()
const hevc = codec === 'h265' || codec === 'hevc'
const PT = 96
const CLOCK = 90_000
const SSRC = 0x1234abcd
const CNAME = 'video-native'
const MAX_FRAGMENT = 1200

const sdps = {}
const sender = new PeerConnection('spike-sender', { iceServers: [] })
const receiver = new PeerConnection('spike-receiver', { iceServers: [] })

// local signaling loopback
sender.onLocalDescription((sdp, type) => {
  if (type === 'offer') sdps.offer = sdp
  receiver.setRemoteDescription(sdp, type)
})
receiver.onLocalDescription((sdp, type) => {
  if (type === 'answer') sdps.answer = sdp
  sender.setRemoteDescription(sdp, type)
})
sender.onLocalCandidate((c, m) => receiver.addRemoteCandidate(c, m))
receiver.onLocalCandidate((c, m) => sender.addRemoteCandidate(c, m))

receiver.onTrack((track) => {
  track.setMediaHandler(new RtcpReceivingSession())
})

// sender media = exactly sender/index.ts
const media = new Video('video', 'SendOnly')
if (hevc) media.addH265Codec(PT)
else media.addH264Codec(PT)
media.addSSRC(SSRC, CNAME)
const track = sender.addTrack(media)
const rtpConfig = new RtpPacketizationConfig(SSRC, CNAME, PT, CLOCK)
const packetizer = hevc
  ? new H265RtpPacketizer('LongStartSequence', rtpConfig, MAX_FRAGMENT)
  : new H264RtpPacketizer('LongStartSequence', rtpConfig, MAX_FRAGMENT)
packetizer.addToChain(new RtcpSrReporter(rtpConfig))
packetizer.addToChain(new RtcpNackResponder())
track.setMediaHandler(packetizer)

sender.setLocalDescription()

function report() {
  const grepFb = (label, sdp) => {
    if (!sdp) return console.log(`  ${label}: (no SDP captured)`)
    const fb = sdp.split('\n').filter((l) => l.includes('rtcp-fb') || l.startsWith('m=video'))
    console.log(`  ${label}:`)
    for (const l of fb) console.log(`      ${l.trim()}`)
    const hasNack = /rtcp-fb:\S* nack(\s|$)/m.test(sdp)
    const hasPli = /rtcp-fb:\S* nack pli/m.test(sdp)
    console.log(`      -> nack=${hasNack ? 'YES' : 'no'}  nack-pli=${hasPli ? 'YES' : 'no'}`)
    return hasNack
  }
  console.log(`\nSPIKE-NACK (codec=${hevc ? 'h265' : 'h264'})`)
  const so = grepFb('OFFER (sender)', sdps.offer)
  const sa = grepFb('ANSWER (receiver)', sdps.answer)
  console.log(
    `\n  VERDICT: NACK ${so && sa ? 'NEGOTIATED on both sides ✅ -> retransmit path is open' : 'NOT negotiated on both -> must add rtcp-fb nack ❌'}`
  )
  sender.close()
  receiver.close()
  process.exit(0)
}

setTimeout(report, 1500)
