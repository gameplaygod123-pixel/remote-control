// Phase 1 · task #1 de-risk (highest risk) — keyframe-on-demand feedback path.
//
// A pipe-fed encoder (ffmpeg) has no built-in WebRTC RTCP loop. If packets are lost,
// the Mac decoder corrupts/stalls until the next IDR. Recovery REQUIRES the sender to
// learn "send a keyframe NOW". Two candidate signals:
//   (a) RTCP PLI/FIR — the receiver's node-datachannel Track.requestKeyframe() emits a
//       real PLI. Question: does node-datachannel SURFACE that PLI to the SENDER (so we
//       can force an ffmpeg IDR)? The JS API shows no onKeyframeRequest callback — prove
//       it empirically.
//   (b) RTCP NACK — RtcpNackResponder auto-retransmits lost packets from a send buffer,
//       with NO JS involvement. This is the first line of loss recovery; PLI is the
//       escalation. We verify the responder is wired (sender doesn't crash / keeps up).
//
// If (a) does NOT reach the sender, the fallback (fully in our control, both ends are
// node-datachannel) is a side CONTROL DATA CHANNEL: the Mac sends {t:'keyframe'} and we
// force an IDR. This spike also proves that path works, so #1 has a guaranteed answer.
//
// Run (from apps/desktop):  node src/video-native/sender/phase1/pli-feedback.mjs
// SPIKE CODE — throwaway proof, not production.

import nd from 'node-datachannel'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROLE = process.argv[2]
const DURATION_MS = 3500
const FPS = 30

// ── PARENT: fork sender+receiver, relay signaling, print verdict ──────────────
if (!ROLE) {
  const self = fileURLToPath(import.meta.url)
  console.log(`[pli-spike] libdatachannel ${nd.getLibraryVersion()} — does receiver PLI reach the sender?`)
  const sender = fork(self, ['sender'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const receiver = fork(self, ['receiver'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const relay = (from, to) => from.on('message', (m) => { if (m?.t === 'sig') to.send(m); else if (m?.t === 'verdict') done(m) })
  relay(sender, receiver); relay(receiver, sender)
  let finished = false
  function done(v) {
    if (finished) return; finished = true
    console.log('\n================ #1 PLI / keyframe-feedback RESULT ================')
    console.log(`receiver requestKeyframe() calls : ${v.pliSent} (returned true: ${v.pliTrue})`)
    console.log(`sender track.onMessage (RTCP in) : ${v.senderOnMessage} pkts; RTCP PTs seen: [${v.rtcpPTs}]`)
    console.log(`  parsed -> PLI:${v.pli}  FIR:${v.fir}  NACK:${v.nack}  (onError=${v.senderOnError})`)
    console.log(`sender saw via CONTROL data chan : ${v.senderCtrl} keyframe requests`)
    console.log(`RtcpNackResponder wired on sender: ${v.nackWired ? 'yes' : 'no'} (auto packet-retransmit)`)
    console.log('\nVERDICT:')
    console.log(`  RTCP PLI -> sender (parse onMessage): ${v.pli > 0 ? 'REACHES US ✅ (force IDR here)' : 'no PLI parsed ❌'}`)
    console.log(`  Control-data-channel keyframe      : ${v.senderCtrl > 0 ? 'WORKS ✅ (robust fallback)' : 'FAILED ❌'}`)
    console.log('==================================================================\n')
    sender.kill(); receiver.kill()
    setTimeout(() => process.exit(0), 100)
  }
  setTimeout(() => { console.error('[pli-spike] timeout'); sender.kill(); receiver.kill(); process.exit(1) }, DURATION_MS + 6000)
}

// ── PEER ──────────────────────────────────────────────────────────────────────
if (ROLE === 'sender' || ROLE === 'receiver') {
  const { PeerConnection, Video, RtpPacketizationConfig, H264RtpPacketizer, RtcpSrReporter, RtcpNackResponder, RtcpReceivingSession } = nd
  const pc = new PeerConnection(ROLE, { iceServers: [] })
  pc.onLocalDescription((sdp, type) => process.send({ t: 'sig', kind: 'sdp', sdp, type }))
  pc.onLocalCandidate((candidate, mid) => process.send({ t: 'sig', kind: 'ice', candidate, mid }))
  process.on('message', (m) => {
    if (m?.t !== 'sig') return
    if (m.kind === 'sdp') pc.setRemoteDescription(m.sdp, m.type)
    else if (m.kind === 'ice') pc.addRemoteCandidate(m.candidate, m.mid)
  })

  if (ROLE === 'sender') {
    // SendOnly H.264 video track + SR reporter + NACK responder (auto-retransmit).
    const media = new Video('video', 'SendOnly')
    media.addH264Codec(96); media.addSSRC(0x1234abcd, 'vid')
    const track = pc.addTrack(media)
    const rtpConfig = new RtpPacketizationConfig(0x1234abcd, 'vid', 96, 90000)
    const packetizer = new H264RtpPacketizer('LongStartSequence', rtpConfig, 1200)
    packetizer.addToChain(new RtcpSrReporter(rtpConfig))
    let nackWired = false
    try { packetizer.addToChain(new RtcpNackResponder()); nackWired = true } catch {}
    track.setMediaHandler(packetizer)

    const seen = { onMessage: 0, onError: 0, ctrl: 0, pli: 0, fir: 0, nack: 0, rtcpPTs: new Set() }
    // The sender's send-only track delivers INCOMING RTCP via onMessage. Parse the
    // compound RTCP to distinguish PLI (PT=206 PSFB, FMT=1) / FIR (FMT=4) / NACK
    // (PT=205 RTPFB, FMT=1) from ordinary RR/SR — this is what tells us to force an IDR.
    track.onMessage((msg) => {
      seen.onMessage++
      let off = 0
      while (off + 4 <= msg.length) {
        const pt = msg[off + 1]
        const fmt = msg[off] & 0x1f
        const len = (msg.readUInt16BE(off + 2) + 1) * 4 // RTCP length in 32-bit words +1
        seen.rtcpPTs.add(pt)
        if (pt === 206 && fmt === 1) seen.pli++
        else if (pt === 206 && fmt === 4) seen.fir++
        else if (pt === 205 && fmt === 1) seen.nack++
        if (len <= 0) break
        off += len
      }
    })
    track.onError(() => { seen.onError++ })

    // Fallback control channel — the OFFERER (sender) creates it so it rides the
    // initial offer (no renegotiation). Receiver asks for IDR over it.
    const ctrl = pc.createDataChannel('video-control')
    ctrl.onMessage((msg) => {
      const s = Buffer.isBuffer(msg) ? msg.toString() : String(msg)
      if (s.includes('keyframe')) { seen.ctrl++; /* production: force ffmpeg IDR here */ }
    })

    let frameId = 0
    track.onOpen(() => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (Date.now() - t0 >= DURATION_MS) {
          clearInterval(iv)
          process.send({ t: 'verdict', pliSent: SHARED.pliSent, pliTrue: SHARED.pliTrue,
            senderOnMessage: seen.onMessage, senderOnError: seen.onError, senderCtrl: seen.ctrl, nackWired,
            pli: seen.pli, fir: seen.fir, nack: seen.nack, rtcpPTs: [...seen.rtcpPTs].join(',') })
          return
        }
        frameId++
        rtpConfig.timestamp = (rtpConfig.timestamp + 3000) >>> 0
        const b = Buffer.alloc(4000); b[3] = 1; b[4] = 0x41; b.fill(0xab, 5)
        track.sendMessageBinary(b)
      }, 1000 / FPS)
    })
    // receiver reports its PLI counters to us via the parent so the verdict is complete
    const SHARED = { pliSent: 0, pliTrue: 0 }
    process.on('message', (m) => { if (m?.t === 'sig' && m.kind === 'pli-count') { SHARED.pliSent = m.sent; SHARED.pliTrue = m.trueCount } })

    pc.setLocalDescription() // sender is the offerer — start negotiation
  }

  if (ROLE === 'receiver') {
    let pliSent = 0, pliTrue = 0
    let ctrl = null
    // the sender (offerer) creates 'video-control'; we receive it here
    pc.onDataChannel((dc) => {
      if (dc.getLabel() === 'video-control') {
        ctrl = dc
        dc.onOpen(() => console.log('[receiver] control channel OPEN'))
      }
    })
    pc.onTrack((track) => {
      track.setMediaHandler(new RtcpReceivingSession())
      let got = 0
      track.onMessage(() => {
        got++
        // after a burst of frames, simulate "I need a keyframe" both ways, and keep
        // trying the control channel for a short window to rule out open-timing.
        if (got >= 40 && got <= 46) {
          if (got === 40) for (let i = 0; i < 5; i++) { const ok = track.requestKeyframe(); pliSent++; if (ok) pliTrue++ } // (a) RTCP PLI
          const open = !!(ctrl && ctrl.isOpen())
          if (got === 40) console.log(`[receiver] at trigger: ctrl=${ctrl ? 'exists' : 'null'} open=${open}`)
          try { if (open) ctrl.sendMessage('keyframe') } catch (e) { console.log('[receiver] ctrl send err', e.message) } // (b) control channel
        }
      })
    })
    setTimeout(() => process.send({ t: 'sig', kind: 'pli-count', sent: pliSent, trueCount: pliTrue }), DURATION_MS - 400)
  }
}
