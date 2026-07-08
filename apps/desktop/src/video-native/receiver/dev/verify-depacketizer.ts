// Unit checks for the receiver's pure RTP->Annex-B reassembly (rtpDepacketizer.ts)
// -- the piece the joint e2e can't isolate. Mirrors sender/dev/verify-units.mjs.
// Run from apps/desktop:  node_modules/.bin/tsx src/video-native/receiver/dev/verify-depacketizer.ts
import { H264Depacketizer, createDepacketizer, isRtcp } from '../rtpDepacketizer'
import {
  BandwidthEstimator,
  BWE_CEIL_KBPS,
  BWE_HEVC_CEIL_KBPS,
  BWE_FLOOR_KBPS,
  BWE_START_KBPS,
  bweCeilingForCodec
} from '../bwe'

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

// 4b. HEVC single NAL (IDR_W_RADL type 19, 2-byte header) -> keyframe AU
{
  const d = createDepacketizer('hevc')
  const nal = Buffer.concat([Buffer.from([0x26, 0x01]), Buffer.from('idrdata')]) // type=(0x26>>1)=19
  const aus = d.push(rtp(nal, { marker: true, ts: 5000 }))
  check('hevc single: 1 AU', aus.length === 1)
  check('hevc single: keyframe true (IDR 19)', aus[0]?.keyframe === true)
  check('hevc single: Annex-B framed', aus[0]?.data.equals(Buffer.concat([SC, nal])) === true)
}

// 4c. HEVC FU (type 49): IDR NAL split S/mid/E -> reassembled to original 2-byte NAL
{
  const d = createDepacketizer('hevc')
  // FU PayloadHdr: type 49 -> byte0 = 49<<1 = 0x62, byte1 = 0x01 (layer/tid).
  const p0 = 0x62
  const p1 = 0x01
  const fuType = 19 // IDR_W_RADL
  const pS = Buffer.from([p0, p1, 0x80 | fuType, 0xaa, 0xbb])
  const pM = Buffer.from([p0, p1, fuType, 0xcc])
  const pE = Buffer.from([p0, p1, 0x40 | fuType, 0xdd])
  check('hevc FU start: no AU yet', d.push(rtp(pS, { marker: false, ts: 6000 })).length === 0)
  check('hevc FU mid: no AU yet', d.push(rtp(pM, { marker: false, ts: 6000 })).length === 0)
  const aus = d.push(rtp(pE, { marker: true, ts: 6000 }))
  // Rebuilt header: h0 = (0x62 & 0x81) | (19<<1) = 0x26, h1 = 0x01.
  const want = Buffer.concat([SC, Buffer.from([0x26, 0x01, 0xaa, 0xbb, 0xcc, 0xdd])])
  check('hevc FU end: 1 AU', aus.length === 1)
  check('hevc FU: reassembled 2-byte NAL correct', aus[0]?.data.equals(want) === true)
  check('hevc FU: keyframe true (IDR)', aus[0]?.keyframe === true)
}

// 4d. HEVC AP (type 48): VPS+SPS aggregated -> two NALs, keyframe (SPS present)
{
  const d = createDepacketizer('hevc')
  const vps = Buffer.from([0x40, 0x01, 0x0c]) // type 32
  const sps = Buffer.from([0x42, 0x01, 0x22]) // type 33
  const ap = Buffer.concat([
    Buffer.from([0x60, 0x01]), // AP PayloadHdr (type 48)
    Buffer.from([0x00, vps.length]),
    vps,
    Buffer.from([0x00, sps.length]),
    sps
  ])
  const aus = d.push(rtp(ap, { marker: true, ts: 7000 }))
  const want = Buffer.concat([SC, vps, SC, sps])
  check('hevc AP: 1 AU', aus.length === 1)
  check('hevc AP: two NALs w/ start codes', aus[0]?.data.equals(want) === true)
  check('hevc AP: keyframe true (SPS 33)', aus[0]?.keyframe === true)
}

// 5. isRtcp routing
{
  check('isRtcp: PT 200 (SR) true', isRtcp(Buffer.from([0x80, 200, 0, 0])) === true)
  check('isRtcp: PT 206 (PSFB) true', isRtcp(Buffer.from([0x80, 206, 0, 0])) === true)
  check('isRtcp: PT 96 (RTP) false', isRtcp(Buffer.from([0x80, 96, 0, 0])) === false)
}

// ── BWE (bwe.ts): loss+jitter AIMD bitrate estimator ──
// v1.27.0-beta.2: start AT the cap (25 Mbps = v1.26.0's proven-smooth target);
// BWE only backs OFF on congestion (loss OR jitter/bufferbloat) then probes back up.
console.log('BandwidthEstimator (BWE)')
const CALM_JITTER = 5 // ms, well under JITTER_PROBE_OK_MS -> "link is calm"
// Observe a clean run of `n` consecutive seqs starting at `start` (wrap-aware).
function feedRun(est: BandwidthEstimator, start: number, n: number): void {
  for (let i = 0; i < n; i++) est.observe((start + i) & 0xffff)
}
{
  // 1. no packets this window -> hold (null)
  const est = new BandwidthEstimator()
  check('bwe: no packets -> tick() null (idle hold)', est.tick(CALM_JITTER) === null)
}
{
  // 2. clean+calm at the start (= cap) -> stays pinned at the cap, changed=false
  const est = new BandwidthEstimator()
  feedRun(est, 0, 100)
  const u = est.tick(CALM_JITTER)
  check('bwe: clean at cap -> holds at cap (no overshoot)', u?.targetKbps === BWE_CEIL_KBPS)
  check('bwe: clean at cap -> changed=false', u?.changed === false)
  check('bwe: start == cap (25 Mbps, v1.26.0 proven target)', BWE_START_KBPS === BWE_CEIL_KBPS)
}
{
  // 2b. HEVC ceiling (15 Mbps) -> starts + caps at 15, never probes above it
  check('bwe: hevc ceiling helper = 15 Mbps', bweCeilingForCodec('hevc') === BWE_HEVC_CEIL_KBPS)
  check('bwe: h264 ceiling helper = 25 Mbps', bweCeilingForCodec('h264') === BWE_CEIL_KBPS)
  const est = new BandwidthEstimator(BWE_HEVC_CEIL_KBPS)
  feedRun(est, 0, 100)
  const u = est.tick(CALM_JITTER)
  check('bwe hevc: clean -> holds at 15 Mbps cap (not 25)', u?.targetKbps === BWE_HEVC_CEIL_KBPS)
  // even after many calm windows it must NOT climb above the HEVC cap
  for (let w = 0; w < 10; w++) {
    feedRun(est, 100 + w * 100, 100)
    est.tick(CALM_JITTER)
  }
  feedRun(est, 2000, 100)
  const u2 = est.tick(CALM_JITTER)
  check('bwe hevc: never probes above the 15 Mbps cap', (u2?.targetKbps ?? 0) <= BWE_HEVC_CEIL_KBPS)
}
{
  // 3. ~19% loss (skip every 5th of 100) -> multiplicative decrease below cap
  const est = new BandwidthEstimator()
  for (let i = 0; i < 100; i++) if (i % 5 !== 0) est.observe(i)
  const u = est.tick(CALM_JITTER)
  check('bwe: heavy loss measured (>5%)', !!u && u.lossFraction > 0.05)
  check('bwe: heavy loss -> decrease below cap', !!u && u.targetKbps < BWE_CEIL_KBPS)
  check('bwe: heavy loss -> changed=true', u?.changed === true)
}
{
  // 4. JITTER spike alone (no loss) -> back off (the bufferbloat fix)
  const est = new BandwidthEstimator()
  feedRun(est, 0, 100) // zero loss
  const u = est.tick(40) // jitter > JITTER_CONGESTION_MS
  check('bwe: jitter spike (no loss) still measured loss=0', u?.lossFraction === 0)
  check('bwe: jitter spike -> back off (delay signal)', !!u && u.targetKbps < BWE_CEIL_KBPS)
}
{
  // 5. wrap-around (65533..2) must NOT read as loss
  const est = new BandwidthEstimator()
  feedRun(est, 65533, 6) // 65533,65534,65535,0,1,2
  const u = est.tick(CALM_JITTER)
  check('bwe: seq wrap 65535->0 is not loss', u?.lossFraction === 0)
}
{
  // 6. after a back-off, clean+calm windows ramp BACK UP toward the cap and pin
  const est = new BandwidthEstimator()
  for (let i = 0; i < 100; i++) if (i % 2 === 0) est.observe(i) // 50% loss -> drop hard
  est.tick(CALM_JITTER)
  let last = null as ReturnType<BandwidthEstimator['tick']>
  for (let w = 1; w < 20; w++) {
    feedRun(est, w * 200, 100)
    last = est.tick(CALM_JITTER)
  }
  check('bwe: recovers/ramps back up to the 25 Mbps cap', last?.targetKbps === BWE_CEIL_KBPS)
  check('bwe: no change once re-pinned at the cap', last?.changed === false)
}
{
  // 7. mild loss (3%, between thresholds) + calm jitter -> hold, changed=false.
  //    Drop once first so we're off the cap (else "hold" is trivially at cap).
  const est = new BandwidthEstimator()
  for (let i = 0; i < 100; i++) if (i % 2 === 0) est.observe(i) // drop
  est.tick(CALM_JITTER)
  for (let i = 0; i < 100; i++) if (i % 34 !== 0) est.observe(1000 + i) // ~3% loss
  const u = est.tick(CALM_JITTER)
  check('bwe: mild loss dead-band + calm -> changed=false (no thrash)', u?.changed === false)
}
{
  // 8. sustained loss -> floor at 5 Mbps
  const est = new BandwidthEstimator()
  let last = null as ReturnType<BandwidthEstimator['tick']>
  for (let w = 0; w < 60; w++) {
    for (let i = 0; i < 100; i++) if (i % 2 === 0) est.observe(w * 200 + i) // 50% loss
    last = est.tick(CALM_JITTER)
  }
  check('bwe: sustained loss floors at 5 Mbps', last?.targetKbps === BWE_FLOOR_KBPS)
}

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILED ❌`)
process.exit(failures === 0 ? 0 : 1)
