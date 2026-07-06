// Phase 1 · tasks #1(action) / #2 / #3 — the real ffmpeg→pipe→NAL path.
//
// Spawns the production-shape capture+encode command:
//   ffmpeg  ddagrab(DXGI dup) → h264_nvenc(low-latency) → -f h264 pipe:1  (Annex-B)
// reads the H.264 elementary stream off stdout, splits it into NAL units by start
// codes (exactly what node-datachannel's H264RtpPacketizer 'LongStartSequence' wants),
// and measures what Phase 1 must know:
//   #2  glass-path timing: spawn→first-NAL, spawn→first-IDR, and per-FRAME cadence
//       out of the pipe (are frames flushed one-at-a-time at ~16.6 ms, or buffered?).
//   #1  recovery cost: spawn→first-IDR == the respawn-on-PLI recovery latency, and we
//       confirm the stream STARTS with an IDR and repeats IDRs every -g frames.
//   #3  RTP 90 kHz timestamps: raw h264 carries no PTS, so we generate them here
//       (monotonic +90000/fps per frame) — the value the packetizer needs.
//
// Needs a portable ffmpeg (ddagrab + h264_nvenc). Pass its path:
//   FFMPEG=C:\path\ffmpeg.exe node src/video-native/sender/phase1/ffmpeg-pipe.mjs
// Env: GOP (frames, default 120), DURATION_MS (default 4000), BITRATE (default 30M),
//      ENC (h264_nvenc|h264_mf, default h264_nvenc), FPS (default 60).
// SPIKE CODE — measurement harness; the real helper reuses this parsing/pacing.

import { spawn } from 'node:child_process'

const FFMPEG = process.env.FFMPEG
if (!FFMPEG) { console.error('set FFMPEG=<path to ffmpeg.exe>'); process.exit(2) }
const FPS = Number(process.env.FPS || 60)
const GOP = Number(process.env.GOP || 120)
const DURATION_MS = Number(process.env.DURATION_MS || 4000)
const BITRATE = process.env.BITRATE || '30M'
const ENC = process.env.ENC || 'h264_nvenc'
const TS_STEP = Math.round(90000 / FPS) // 90 kHz ticks per frame (#3)

// low-latency encoder args + immediate packet flush (don't let ffmpeg buffer frames).
// nvenc zero-latency set: p1(fastest)+ull tune, CBR, NO B-frames, no lookahead, no
// output reorder delay, no scenecut I-frames (keep GOP deterministic). bufsize small
// = tight CBR. (#2 — verified via `ffmpeg -h encoder=h264_nvenc`.)
const encArgs = ENC === 'h264_nvenc'
  ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-rc', 'cbr', '-b:v', BITRATE,
     '-bf', '0', '-g', String(GOP), '-delay', '0', '-zerolatency', '1', '-rc-lookahead', '0', '-no-scenecut', '1']
  : ['-c:v', 'h264_mf', '-b:v', BITRATE]

const args = [
  '-hide_banner', '-loglevel', 'error',
  '-filter_complex', `ddagrab=output_idx=0:framerate=${FPS}${ENC === 'h264_mf' ? ',hwdownload,format=bgra' : ''}`,
  ...encArgs,
  '-bsf:v', 'dump_extra', // ensure SPS/PPS in-band before IDRs (Annex-B)
  '-f', 'h264', '-flush_packets', '1', 'pipe:1'
]

console.log(`[pipe] ${ENC} ${BITRATE} ${FPS}fps GOP=${GOP} — spawning ffmpeg…`)
const t0 = process.hrtime.bigint()
const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'inherit'] })

// ── NAL splitter: scan Annex-B stream for 00 00 01 / 00 00 00 01 boundaries ────
let buf = Buffer.alloc(0)
let firstNalAt = 0, firstIdrAt = 0
let frames = 0, idrs = 0, sps = 0, pps = 0, bytes = 0
let rtpTs = 0, firstFrameMs = 0
const frameArrivals = [] // ms since spawn, per VCL frame
const nalStep = []       // inter-frame ms

function classify(nalType) {
  if (nalType === 5) return 'IDR'
  if (nalType === 1) return 'P'
  if (nalType === 7) return 'SPS'
  if (nalType === 8) return 'PPS'
  return `t${nalType}`
}

function onNal(nal, atNs) {
  if (nal.length === 0) return
  const nalType = nal[0] & 0x1f
  bytes += nal.length
  if (!firstNalAt) firstNalAt = Number(atNs - t0) / 1e6
  if (nalType === 7) sps++
  else if (nalType === 8) pps++
  else if (nalType === 1 || nalType === 5) {
    // a VCL slice = one frame (low-latency: one slice per frame)
    const ms = Number(atNs - t0) / 1e6
    if (frames > 0) nalStep.push(ms - frameArrivals[frameArrivals.length - 1])
    // #3: RTP 90 kHz timestamp. ddagrab emits frames ON SCREEN-CHANGE (variable
    // interval — see the cadence gaps), so a fixed +90000/fps DRIFTS. Derive it from
    // WALL-CLOCK capture time instead: ticks = elapsed_since_first_frame × 90. (A fixed
    // step is only correct for a truly constant-rate source.)
    if (frames === 0) firstFrameMs = ms
    rtpTs = Math.round((ms - firstFrameMs) * 90) >>> 0
    frameArrivals.push(ms)
    frames++
    if (nalType === 5) { idrs++; if (!firstIdrAt) firstIdrAt = ms }
  }
}

// find start codes and emit NALs between them
function drain() {
  let i = 0
  const starts = []
  while (i + 3 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) { starts.push([i, 3]); i += 3 }
    else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) { starts.push([i, 4]); i += 4 }
    else i++
  }
  if (starts.length < 2) return
  const now = process.hrtime.bigint()
  for (let s = 0; s < starts.length - 1; s++) {
    const [pos, sc] = starts[s]
    const end = starts[s + 1][0]
    onNal(buf.subarray(pos + sc, end), now)
  }
  // keep the tail from the last start code onward (incomplete NAL)
  buf = buf.subarray(starts[starts.length - 1][0])
}

ff.stdout.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); drain() })

setTimeout(() => { ff.kill('SIGKILL') }, DURATION_MS)

ff.on('close', () => {
  const wall = Number(process.hrtime.bigint() - t0) / 1e6
  const sorted = [...nalStep].sort((a, b) => a - b)
  const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))] : 0
  const mean = nalStep.length ? nalStep.reduce((a, b) => a + b, 0) / nalStep.length : 0
  console.log('\n================ ffmpeg→pipe→NAL RESULT ================')
  console.log(`spawn → first NAL out of pipe : ${firstNalAt.toFixed(1)} ms`)
  console.log(`spawn → first IDR (== respawn recovery cost): ${firstIdrAt.toFixed(1)} ms`)
  console.log(`frames off pipe               : ${frames}  (${(frames / (wall / 1000)).toFixed(1)} fps over ${(wall/1000).toFixed(1)}s)`)
  console.log(`IDRs                          : ${idrs}  (SPS ${sps}, PPS ${pps}) — expect ~1 per ${GOP} frames`)
  console.log(`per-frame pipe cadence ms     : mean ${mean.toFixed(2)}  p50 ${pct(50).toFixed(2)}  p90 ${pct(90).toFixed(2)}  p99 ${pct(99).toFixed(2)}  max ${(sorted[sorted.length-1]||0).toFixed(2)}`)
  console.log(`  (target ${(1000/FPS).toFixed(1)} ms/frame; low variance ⇒ frames flushed one-at-a-time, not buffered)`)
  console.log(`bytes                         : ${bytes} (${(bytes*8/1e6/(wall/1000)).toFixed(1)} Mbps)`)
  console.log(`RTP 90kHz ts (wall-clock)     : last=${rtpTs}; ≈${(rtpTs / (frames > 1 ? frames - 1 : 1)).toFixed(0)} ticks/frame avg (nominal ${TS_STEP} @ ${FPS}fps, #3)`)
  console.log('========================================================\n')
  process.exit(0)
})
ff.on('error', (e) => { console.error('spawn error:', e.message); process.exit(1) })
