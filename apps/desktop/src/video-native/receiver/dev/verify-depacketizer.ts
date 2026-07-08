// Unit checks for the receiver's pure RTP->Annex-B reassembly (rtpDepacketizer.ts)
// -- the piece the joint e2e can't isolate. Mirrors sender/dev/verify-units.mjs.
// Run from apps/desktop:  node_modules/.bin/tsx src/video-native/receiver/dev/verify-depacketizer.ts
import { H264Depacketizer, isRtcp } from '../rtpDepacketizer'
import { BandwidthEstimator, BWE_CEIL_KBPS, BWE_FLOOR_KBPS, BWE_START_KBPS } from '../bwe'

let failures = 0
function check(name: string, cond: boolean): void {
  console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}  ${name}`)
  if (!cond) failures++
}
const SC = Buffer.from([0, 0, 0, 1])

function rtp(payload: Buffer, opts: { marker?: boolean; ts?: number; seq?: number }): Buffer {
  const h = Buffer.alloc(12)
  h[0] = 0x80
  h[1] = (opts.marker ? 0x80 : 0) | 96
  h.writeUInt16BE(opts.seq ?? 0, 2)
  h.writeUInt32BE(opts.ts ?? 1000, 4)
  h.writeUInt32BE(0x1234abcd, 8)
  return Buffer.concat([h, payload])
}

// 1. single NAL (IDR type 5) + marker -> one keyframe AU
{
  const d = new H264Depacketizer()
  const nal = Buffer.concat([Buffer.from([0x65]), Buffer.from('idrdata')])
  const aus = d.push(rtp(nal, { marker: true }))
  check('single NAL: 1 AU', aus.length === 1)
  check('single NAL: keyframe true', aus[0]?.keyframe === true)
  check(
    'single NAL: Annex-B start code + NAL',
    aus[0]?.data.equals(Buffer.concat([SC, nal])) === true
  )
}

// 2. FU-A: NAL 0x65 split across S/mid/E -> reassembled to original NAL
{
  const d = new H264Depacketizer()
  const fuInd = (0x65 & 0xe0) | 28 // 0x7c
  const type = 0x65 & 0x1f // 5
  const pS = Buffer.from([fuInd, 0x80 | type, 0xaa, 0xbb])
  const pM = Buffer.from([fuInd, type, 0xcc])
  const pE = Buffer.from([fuInd, 0x40 | type, 0xdd])
  check('FU-A start: no AU yet', d.push(rtp(pS, { marker: false, ts: 2000 })).length === 0)
  check('FU-A mid: no AU yet', d.push(rtp(pM, { marker: false, ts: 2000 })).length === 0)
  const aus = d.push(rtp(pE, { marker: true, ts: 2000 }))
  const want = Buffer.concat([SC, Buffer.from([0x65, 0xaa, 0xbb, 0xcc, 0xdd])])
  check('FU-A end: 1 AU', aus.length === 1)
  check('FU-A: reassembled NAL correct', aus[0]?.data.equals(want) === true)
  check('FU-A: keyframe true (IDR)', aus[0]?.keyframe === true)
}

// 3. STAP-A: SPS(0x67)+PPS(0x68) aggregated -> two NALs, keyframe (SPS present)
{
  const d = new H264Depacketizer()
  const sps = Buffer.from([0x67, 0x42, 0x00, 0x1f])
  const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80])
  const stap = Buffer.concat([
    Buffer.from([0x78]), // STAP-A header (type 24)
    Buffer.from([0x00, sps.length]),
    sps,
    Buffer.from([0x00, pps.length]),
    pps
  ])
  const aus = d.push(rtp(stap, { marker: true, ts: 3000 }))
  const want = Buffer.concat([SC, sps, SC, pps])
  check('STAP-A: 1 AU', aus.length === 1)
  check('STAP-A: two NALs w/ start codes', aus[0]?.data.equals(want) === true)
  check('STAP-A: keyframe true (SPS)', aus[0]?.keyframe === true)
}

// 4. timestamp change delimits an AU even without a marker bit
{
  const d = new H264Depacketizer()
  const nalA = Buffer.from([0x41, 0x01]) // non-IDR slice
  const nalB = Buffer.from([0x41, 0x02])
  const first = d.push(rtp(nalA, { marker: false, ts: 4000 }))
  check('ts-change: no AU on first (no marker)', first.length === 0)
  const second = d.push(rtp(nalB, { marker: false, ts: 4001 }))
  check('ts-change: prior AU flushed when ts advances', second.length === 1)
  check('ts-change: flushed AU is nalA', second[0]?.data.equals(Buffer.concat([SC, nalA])) === true)
  check('ts-change: non-IDR not keyframe', second[0]?.keyframe === false)
}

// 5. isRtcp routing
{
  check('isRtcp: PT 200 (SR) true', isRtcp(Buffer.from([0x80, 200, 0, 0])) === true)
  check('isRtcp: PT 206 (PSFB) true', isRtcp(Buffer.from([0x80, 206, 0, 0])) === true)
  check('isRtcp: PT 96 (RTP) false', isRtcp(Buffer.from([0x80, 96, 0, 0])) === false)
}

// ── BWE (bwe.ts): loss-based AIMD bitrate estimator ──
console.log('BandwidthEstimator (BWE)')
// Observe a clean run of `n` consecutive seqs starting at `start` (wrap-aware).
function feedRun(est: BandwidthEstimator, start: number, n: number): void {
  for (let i = 0; i < n; i++) est.observe((start + i) & 0xffff)
}
{
  // 1. no packets this window -> hold (null)
  const est = new BandwidthEstimator()
  check('bwe: no packets -> tick() null (idle hold)', est.tick() === null)
}
{
  // 2. clean window -> additive increase from the start bitrate, changed=true
  const est = new BandwidthEstimator()
  feedRun(est, 0, 100)
  const u = est.tick()
  check(
    'bwe: clean window -> increase past start',
    !!u && u.lossFraction === 0 && u.targetKbps > BWE_START_KBPS
  )
  check('bwe: clean window -> changed=true', u?.changed === true)
}
{
  // 3. ~19% loss (skip every 5th of 100) -> multiplicative decrease below start
  const est = new BandwidthEstimator()
  for (let i = 0; i < 100; i++) if (i % 5 !== 0) est.observe(i)
  const u = est.tick()
  check('bwe: heavy loss measured (>5%)', !!u && u.lossFraction > 0.05)
  check('bwe: heavy loss -> decrease below start', !!u && u.targetKbps < BWE_START_KBPS)
}
{
  // 4. wrap-around (65533..2) must NOT read as loss
  const est = new BandwidthEstimator()
  feedRun(est, 65533, 6) // 65533,65534,65535,0,1,2
  const u = est.tick()
  check('bwe: seq wrap 65535->0 is not loss', u?.lossFraction === 0)
}
{
  // 5. mild loss (3%, between thresholds) after a change -> hold, changed=false
  const est = new BandwidthEstimator()
  feedRun(est, 0, 100)
  est.tick() // one clean step (target moved, lastEmitted updated)
  for (let i = 0; i < 100; i++) if (i % 34 !== 0) est.observe(1000 + i) // ~3 dropped
  const u = est.tick()
  check('bwe: mild loss in dead-band -> changed=false (no thrash)', u?.changed === false)
}
{
  // 6. sustained clean -> ramp caps at 60 Mbps, and AT the cap a clean window
  //    produces no change (changed=false)
  const est = new BandwidthEstimator()
  let last = est.tick()
  for (let w = 0; w < 40; w++) {
    feedRun(est, w * 200, 100)
    last = est.tick()
  }
  check('bwe: clean ramp caps at 60 Mbps', last?.targetKbps === BWE_CEIL_KBPS)
  check('bwe: no change once pinned at the cap', last?.changed === false)
}
{
  // 7. sustained loss -> floor at 5 Mbps
  const est = new BandwidthEstimator()
  let last = null as ReturnType<BandwidthEstimator['tick']>
  for (let w = 0; w < 60; w++) {
    for (let i = 0; i < 100; i++) if (i % 2 === 0) est.observe(w * 200 + i) // 50% loss
    last = est.tick()
  }
  check('bwe: sustained loss floors at 5 Mbps', last?.targetKbps === BWE_FLOOR_KBPS)
}

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILED ❌`)
process.exit(failures === 0 ? 0 : 1)
