// Unit checks for the sender's pure modules (dev-only) — the parts the
// synthetic-source e2e (verify.mjs) does NOT exercise: the Annex-B NAL splitter,
// access-unit assembly, and the ffmpeg arg builder. rtcpFeedback is covered too.
// Bundles the TS modules with esbuild and asserts. Run from apps/desktop:
//   node src/video-native/sender/dev/verify-units.mjs

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SENDER = resolve(__dirname, '..') // sender/

let failures = 0
function check(name, cond) {
  console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}  ${name}`)
  if (!cond) failures++
}

async function bundle() {
  const viteRequire = createRequire(require.resolve('vite'))
  const esbuild = viteRequire('esbuild')
  const outfile = join(SENDER, '../../..', '.verify-tmp', 'units.cjs')
  mkdirSync(dirname(outfile), { recursive: true })
  const entry = `
    export { NalSplitter, AccessUnitAssembler } from ${JSON.stringify(join(SENDER, 'nalSplitter.ts'))}
    export { buildFfmpegArgs } from ${JSON.stringify(join(SENDER, 'ffmpegArgs.ts'))}
    export { parseRtcpFeedback, isKeyframeRequest } from ${JSON.stringify(join(SENDER, 'rtcpFeedback.ts'))}
  `
  await esbuild.build({
    stdin: { contents: entry, resolveDir: SENDER, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    outfile, logLevel: 'error'
  })
  return require(outfile)
}

const sc = (...nals) => Buffer.concat(nals.map((n) => Buffer.concat([Buffer.from([0, 0, 0, 1]), n])))

bundle().then((m) => {
  const { NalSplitter, AccessUnitAssembler, buildFfmpegArgs, parseRtcpFeedback, isKeyframeRequest } = m

  // ── NalSplitter: NALs recovered across a chunk boundary ──
  console.log('NalSplitter')
  {
    const sps = Buffer.from([0x67, 1, 2])
    const pps = Buffer.from([0x68, 3])
    const idr = Buffer.from([0x65, 9, 9, 9])
    const p = Buffer.from([0x41, 7, 7])
    const stream = sc(sps, pps, idr, p)
    const sp = new NalSplitter()
    // split mid-NAL to test boundary handling
    const cut = 7
    const out = [...sp.push(stream.subarray(0, cut)), ...sp.push(stream.subarray(cut))]
    // last NAL (p) stays buffered until a following start code -> feed a sentinel
    out.push(...sp.push(Buffer.from([0, 0, 0, 1, 0x09])))
    const types = out.map((n) => n[0] & 0x1f)
    check('recovers SPS,PPS,IDR,P in order across a chunk split', JSON.stringify(types) === JSON.stringify([7, 8, 5, 1]))
  }

  // ── AccessUnitAssembler: one AU per VCL, keyframe flag, start-code framing ──
  console.log('AccessUnitAssembler')
  {
    const asm = new AccessUnitAssembler()
    const aus = []
    for (const nal of [Buffer.from([0x67]), Buffer.from([0x68]), Buffer.from([0x65, 1])]) {
      const au = asm.push(nal)
      if (au) aus.push(au)
    }
    const pAu = asm.push(Buffer.from([0x41, 2]))
    if (pAu) aus.push(pAu)
    check('SPS+PPS+IDR collapse into ONE keyframe AU', aus.length === 2 && aus[0].keyframe === true)
    check('P slice is a separate non-keyframe AU', aus[1] && aus[1].keyframe === false)
    check('AU data is start-code framed', aus[0].data.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1])))
    // IDR AU should contain 3 start codes (SPS,PPS,IDR)
    let starts = 0
    for (let i = 0; i + 3 < aus[0].data.length; i++)
      if (aus[0].data[i] === 0 && aus[0].data[i + 1] === 0 && aus[0].data[i + 2] === 0 && aus[0].data[i + 3] === 1) starts++
    check('keyframe AU carries SPS+PPS+IDR (3 NALs)', starts === 3)
  }

  // ── buildFfmpegArgs ──
  console.log('buildFfmpegArgs')
  {
    const cfg = { width: 1920, height: 1080, fps: 60, codec: 'h264', minBitrateKbps: 6000, startBitrateKbps: 20000, maxBitrateKbps: 30000, cursor: 'composited' }
    const nv = buildFfmpegArgs(cfg, { gop: 60 }).join(' ')
    check('nvenc: ddagrab DXGI capture at target fps', nv.includes('ddagrab=output_idx=0:framerate=60'))
    // zero-copy: NVENC ingests the d3d11 RGB surface directly (no scale_d3d11 --
    // its VideoProcessor won't configure BGRA->NV12 on this GPU; real-ffmpeg run).
    check('nvenc: zero-copy, NO scale_d3d11 filter', !nv.includes('scale_d3d11'))
    check('nvenc: low-latency flags (ull, bf 0, zerolatency)', nv.includes('-tune ull') && nv.includes('-bf 0') && nv.includes('-zerolatency 1'))
    check('nvenc: CBR at startBitrate (20000k), gop 60', nv.includes('-rc cbr') && nv.includes('-b:v 20000k') && nv.includes('-g 60'))
    check('nvenc: Annex-B pipe out with in-band params', nv.includes('-bsf:v dump_extra') && nv.includes('-f h264') && nv.includes('-flush_packets 1') && nv.endsWith('pipe:1'))
    const mf = buildFfmpegArgs(cfg, { gop: 60, encoder: 'h264_mf' }).join(' ')
    check('mf fallback: hwdownload + CPU scale + h264_mf', mf.includes('hwdownload,format=bgra,scale=1920:1080') && mf.includes('-c:v h264_mf'))
    // quality-sweep knobs: default byte-identical (p1/20000k), override honoured
    check('default preset is p1 (contract default)', nv.includes('-preset p1'))
    const swept = buildFfmpegArgs(cfg, { gop: 60, preset: 'p4', bitrateKbps: 30000 }).join(' ')
    check('sweep override: preset p4 + 30000k CBR', swept.includes('-preset p4') && swept.includes('-b:v 30000k') && !swept.includes('-b:v 20000k'))
    check('sweep bitrate reaches mf fallback too', buildFfmpegArgs(cfg, { encoder: 'h264_mf', bitrateKbps: 30000 }).join(' ').includes('-b:v 30000k'))
  }

  // ── parseRtcpFeedback: a hand-built PLI compound packet ──
  console.log('parseRtcpFeedback')
  {
    // RR (PT=201, len=1 -> 8 bytes) then PLI (PT=206 PSFB FMT=1, len=2 -> 12 bytes)
    const rr = Buffer.from([0x81, 201, 0, 1, 0, 0, 0, 0])
    const pli = Buffer.from([0x81, 206, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0])
    const fb = parseRtcpFeedback(Buffer.concat([rr, pli]))
    check('PLI parsed from compound RTCP', fb.pli === 1 && isKeyframeRequest(fb))
    check('non-feedback RR does not count as keyframe req', parseRtcpFeedback(rr).pli === 0)
  }

  console.log(`\nOVERALL: ${failures === 0 ? 'PASS ✅' : `FAIL ❌ (${failures})`}`)
  process.exit(failures === 0 ? 0 : 1)
}).catch((e) => { console.error('setup failed:', e); process.exit(2) })
