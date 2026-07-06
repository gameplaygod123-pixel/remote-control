// Phase 0-A de-risk spike (Windows sender half) — see docs/native-video-plan.md §5.
//
// Question this answers: can node-datachannel (libdatachannel) send AND receive a
// live H.264 *media track* (RTP) OUTSIDE Chromium — i.e. from a plain Node process
// like the input helper — robustly enough to carry our encoded video?
//
// Design: TWO real OS processes (not one event loop doing both ends — that proved
// racy and starved receive callbacks). A parent forks a `sender` child and a
// `receiver` child; each has its own event loop and its own libdatachannel stack;
// they exchange real SRTP/DTLS/ICE media over localhost UDP. The parent only relays
// SDP/ICE between them over child_process IPC (standing in for real signaling).
//
// The sender feeds SYNTHETIC Annex-B H.264 access units (no real encoder yet — that
// is Phase 0-B) through the real H264RtpPacketizer. Each frame embeds a wall-clock
// send time so the receiver can estimate one-way latency (same machine => shared
// clock). The receiver parses RTP, counts packets, uses the marker bit to count
// whole frames, and reports delivery / throughput / latency.
//
// FINDINGS this spike encodes (all verified this session):
//   - node-datachannel exposes libdatachannel's full media API (Video/addTrack/
//     H264RtpPacketizer/RtcpReceivingSession) from plain Node — no Chromium.
//   - onMessage on a receive track delivers RAW RTP PACKETS, not reassembled
//     Annex-B frames; the receiver owns FU-A reassembly (the Mac half will do this).
//   - media tracks expose NO bufferedAmount(); sendMessageBinary()'s boolean is not
//     a reliable drop signal (esp. with a pacer), so we measure delivery empirically.
//   - PeerConnection.bytesSent/bytesReceived do NOT count SRTP media in this build.
//
// Run:  node src/video-native/sender/phase0/media-loopback.mjs   (from apps/desktop)
//
// SPIKE CODE. Throwaway proof, not the production sender. Do not import from app code.

import nd from 'node-datachannel'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ── shared test parameters ────────────────────────────────────────────────────
const PAYLOAD_TYPE = 96
const CLOCK_RATE = 90_000
const SSRC = 0x1234abcd
const CNAME = 'phase0-video'
const FPS = Number(process.env.FPS || 30)
const DURATION_MS = 4_000
const MAX_FRAGMENT = 1200
// Load is env-tunable (FPS / IDR_BYTES / P_BYTES / IDR_EVERY) so the packet-rate
// ceiling can be swept. Defaults are the rate at which this JS-on-both-ends harness
// sustains ~100% delivery — enough to PROVE the transport. The ceiling here is the
// RECEIVER's per-packet JS callback (N-API), NOT node-datachannel: in production the
// receiver is native Mac code (VideoToolbox), not a JS loop. Pushing rate/bitrate up
// here (FPS=60 IDR_BYTES=60000) reproduces steady loss / SRTP buffer overrun —
// sustained 30 Mbps is validated on real hardware in Phase 1.
const IDR_BYTES = Number(process.env.IDR_BYTES || 12_000)
const P_BYTES = Number(process.env.P_BYTES || 4_000)
const IDR_EVERY = Number(process.env.IDR_EVERY || 60)

const ROLE = process.argv[2] // undefined (parent) | 'sender' | 'receiver'

// ══════════════════════════════════════════════════════════════════════════════
// PARENT: fork the two peers, relay their SDP/ICE, print the gated result.
// ══════════════════════════════════════════════════════════════════════════════
if (!ROLE) {
  const self = fileURLToPath(import.meta.url)
  console.log(`[spike] node-datachannel media loopback (2-process) — libdatachannel ${nd.getLibraryVersion()}`)
  console.log(`[spike] ${FPS}fps for ${DURATION_MS}ms, IDR≈${IDR_BYTES}B every ${IDR_EVERY}, P≈${P_BYTES}B, MTU frag ${MAX_FRAGMENT}`)

  const sender = fork(self, ['sender'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const receiver = fork(self, ['receiver'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })

  const relay = (from, to) =>
    from.on('message', (m) => {
      if (m?.t === 'sig') to.send(m)
      else if (m?.t === 'result') finish(m.result)
    })
  relay(sender, receiver)
  relay(receiver, sender)

  let done = false
  function finish(result) {
    if (done) return
    done = true
    const pass = result.frames > 0 && result.frames >= result.attempted * 0.9
    console.log('\n================ Phase 0-A RESULT (2-process) ================')
    console.log(`frames attempted (sender) : ${result.attempted}`)
    console.log(`RTP packets received      : ${result.packets}`)
    console.log(`whole frames received     : ${result.frames}  (by RTP marker bit)`)
    console.log(`frame delivery            : ${result.attempted ? ((result.frames / result.attempted) * 100).toFixed(1) : '0'}%`)
    console.log(`effective throughput      : ${result.mbps.toFixed(1)} Mbps`)
    if (result.lat) {
      console.log(`one-way latency p50/p90/p99/max ms: ${result.lat.p50.toFixed(2)} / ${result.lat.p90.toFixed(2)} / ${result.lat.p99.toFixed(2)} / ${result.lat.max.toFixed(2)}  (n=${result.lat.n})`)
    }
    if (result.pair) console.log(`selected candidate pair   : ${result.pair}`)
    console.log(`\nGATE (media transport usable outside Chromium): ${pass ? 'PASS ✅' : 'FAIL ❌'}`)
    console.log('==============================================================\n')
    sender.kill()
    receiver.kill()
    setTimeout(() => process.exit(pass ? 0 : 1), 100)
  }

  setTimeout(() => {
    console.error('[spike] TIMEOUT — receiver never reported a result')
    sender.kill(); receiver.kill(); process.exit(1)
  }, DURATION_MS + 8_000)
}

// ══════════════════════════════════════════════════════════════════════════════
// PEER (sender or receiver): own libdatachannel stack; signal via parent IPC.
// ══════════════════════════════════════════════════════════════════════════════
if (ROLE === 'sender' || ROLE === 'receiver') {
  const { PeerConnection, Video, RtpPacketizationConfig, H264RtpPacketizer, RtcpSrReporter, RtcpNackResponder, RtcpReceivingSession, PacingHandler } = nd
  // Pacing OFF by default: at this moderate rate the raw path sustains 100% delivery,
  // and node-datachannel's PacingHandler tuning is non-obvious (mis-set params queue
  // huge latency). PACE=1 to experiment with it. See notes.
  const PACE = process.env.PACE === '1'
  const pc = new PeerConnection(ROLE, { iceServers: [] }) // host candidates only

  // wire signaling to the parent relay
  pc.onLocalDescription((sdp, type) => process.send({ t: 'sig', kind: 'sdp', sdp, type }))
  pc.onLocalCandidate((candidate, mid) => process.send({ t: 'sig', kind: 'ice', candidate, mid }))
  process.on('message', (m) => {
    if (m?.t !== 'sig') return
    if (m.kind === 'sdp') pc.setRemoteDescription(m.sdp, m.type)
    else if (m.kind === 'ice') pc.addRemoteCandidate(m.candidate, m.mid)
  })
  pc.onStateChange((s) => console.log(`[${ROLE}] pc state=${s}`))

  // ── RTP header parsing (marker + payload offset, handling CSRC/extension) ─────
  const rtpPayloadInfo = (buf) => {
    if (buf.length < 12) return null
    const cc = buf[0] & 0x0f
    const ext = (buf[0] & 0x10) !== 0
    const marker = (buf[1] & 0x80) !== 0
    const timestamp = buf.readUInt32BE(4)
    let off = 12 + cc * 4
    if (ext) {
      if (buf.length < off + 4) return null
      const extLen = buf.readUInt16BE(off + 2)
      off += 4 + extLen * 4
    }
    return { marker, timestamp, off }
  }

  if (ROLE === 'receiver') {
    const recv = { packets: 0, frames: 0, bytes: 0, firstAt: 0, lastAt: 0, seenTs: new Set(), lat: [] }
    // sender tells us how many frames it fed so we can compute delivery %
    const ATTEMPTED_HINT = { value: 0 }
    process.on('message', (m) => { if (m?.t === 'sig' && m.kind === 'attempted') ATTEMPTED_HINT.value = m.value })
    pc.onTrack((track) => {
      console.log(`[receiver] onTrack mid=${track.mid()} type=${track.type()}`)
      track.setMediaHandler(new RtcpReceivingSession())
      track.onMessage((msg) => {
        const now = Date.now()
        const info = rtpPayloadInfo(msg)
        if (!info) return
        recv.packets++
        recv.bytes += msg.length
        if (!recv.firstAt) recv.firstAt = process.hrtime.bigint()
        recv.lastAt = process.hrtime.bigint()
        // First packet of a new frame carries the NAL start = our embedded send time.
        if (!recv.seenTs.has(info.timestamp)) {
          const p = msg.subarray(info.off)
          let tsOff = -1
          const nalType = p[0] & 0x1f
          if (nalType === 28 && (p[1] & 0x80)) tsOff = 2 // FU-A start fragment
          else if (nalType >= 1 && nalType <= 23) tsOff = 1 // single NAL
          if (tsOff >= 0 && p.length >= tsOff + 8) {
            const sentAt = Number(p.readBigUInt64BE(tsOff))
            if (sentAt > 0 && sentAt <= now) recv.lat.push(now - sentAt)
          }
        }
        if (info.marker && !recv.seenTs.has(info.timestamp)) {
          recv.seenTs.add(info.timestamp)
          recv.frames++
        }
      })
    })

    // report shortly after the stream is expected to end
    setTimeout(() => {
      const durSec = Number(recv.lastAt - recv.firstAt) / 1e9 || DURATION_MS / 1000
      const mbps = (recv.bytes * 8) / 1e6 / (durSec || 1)
      const s = [...recv.lat].sort((a, b) => a - b)
      const pct = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0)
      const pair = (() => {
        const sp = pc.getSelectedCandidatePair?.()
        return sp ? `${sp.local?.candidateType} <-> ${sp.remote?.candidateType}` : null
      })()
      process.send({
        t: 'result',
        result: {
          attempted: ATTEMPTED_HINT.value, // filled via IPC from sender below
          packets: recv.packets,
          frames: recv.frames,
          mbps,
          pair,
          lat: s.length ? { n: s.length, p50: pct(50), p90: pct(90), p99: pct(99), max: s[s.length - 1] } : null
        }
      })
    }, DURATION_MS + 1_500)
  }

  if (ROLE === 'sender') {
    const media = new Video('video', 'SendOnly')
    media.addH264Codec(PAYLOAD_TYPE)
    media.addSSRC(SSRC, CNAME)
    const track = pc.addTrack(media)

    const rtpConfig = new RtpPacketizationConfig(SSRC, CNAME, PAYLOAD_TYPE, CLOCK_RATE)
    const packetizer = new H264RtpPacketizer('LongStartSequence', rtpConfig, MAX_FRAGMENT)
    // Pacing smooths each frame's packet burst so the outbound SRTP buffer isn't
    // overrun (without it the buffer fills after ~0.5s and the stream cuts off).
    // Ceiling set above our 30 Mbps target; 1 ms granularity.
    if (PACE) packetizer.addToChain(new PacingHandler(45_000_000, 1))
    packetizer.addToChain(new RtcpSrReporter(rtpConfig))
    packetizer.addToChain(new RtcpNackResponder())
    track.setMediaHandler(packetizer)
    console.log(`[sender] pacing: ${PACE ? 'ON (45 Mbps ceiling)' : 'OFF'}`)

    // synthetic Annex-B AU: [00 00 00 01][nalHdr][8-byte BE send time ms][filler]
    const makeFrame = (isIdr) => {
      const buf = Buffer.alloc(isIdr ? IDR_BYTES : P_BYTES)
      buf[3] = 0x01
      buf[4] = isIdr ? 0x65 : 0x41
      buf.writeBigUInt64BE(BigInt(Date.now()), 5)
      buf.fill(0xab, 13)
      return buf
    }

    let attempted = 0
    let frameId = 0
    track.onOpen(() => {
      console.log('[sender] track open → streaming synthetic H.264 frames')
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (Date.now() - t0 >= DURATION_MS) {
          clearInterval(iv)
          process.send({ t: 'sig', kind: 'attempted', value: attempted })
          return
        }
        frameId++
        attempted++
        rtpConfig.timestamp = (rtpConfig.timestamp + Math.round(CLOCK_RATE / FPS)) >>> 0
        track.sendMessageBinary(makeFrame(frameId % IDR_EVERY === 1))
      }, 1000 / FPS)
    })
    track.onError((e) => console.error('[sender] track error:', e))
    pc.setLocalDescription()
  }
}
