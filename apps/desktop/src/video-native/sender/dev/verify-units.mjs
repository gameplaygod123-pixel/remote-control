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
    export { buildCapturerArgs } from ${JSON.stringify(join(SENDER, 'capturerArgs.ts'))}
    export { parseRtcpFeedback, isKeyframeRequest } from ${JSON.stringify(join(SENDER, 'rtcpFeedback.ts'))}
  `
  await esbuild.build({
    stdin: { contents: entry, resolveDir: SENDER, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    logLevel: 'error'
  })
  return require(outfile)
}

const sc = (...nals) =>
  Buffer.concat(nals.map((n) => Buffer.concat([Buffer.from([0, 0, 0, 1]), n])))

bundle()
  .then((m) => {
    const {
      NalSplitter,
      AccessUnitAssembler,
      buildFfmpegArgs,
      buildCapturerArgs,
      parseRtcpFeedback,
      isKeyframeRequest
    } = m

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
      check(
        'recovers SPS,PPS,IDR,P in order across a chunk split',
        JSON.stringify(types) === JSON.stringify([7, 8, 5, 1])
      )
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
      check(
        'SPS+PPS+IDR collapse into ONE keyframe AU',
        aus.length === 2 && aus[0].keyframe === true
      )
      check('P slice is a separate non-keyframe AU', aus[1] && aus[1].keyframe === false)
      check(
        'AU data is start-code framed',
        aus[0].data.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1]))
      )
      // IDR AU should contain 3 start codes (SPS,PPS,IDR)
      let starts = 0
      for (let i = 0; i + 3 < aus[0].data.length; i++)
        if (
          aus[0].data[i] === 0 &&
          aus[0].data[i + 1] === 0 &&
          aus[0].data[i + 2] === 0 &&
          aus[0].data[i + 3] === 1
        )
          starts++
      check('keyframe AU carries SPS+PPS+IDR (3 NALs)', starts === 3)
    }

    // ── AccessUnitAssembler (HEVC): 2-byte header, VCL 0..31, IDR 19/20 ──
    console.log('AccessUnitAssembler (HEVC)')
    {
      const asm = new AccessUnitAssembler('hevc')
      const aus = []
      // VPS(32)=0x40, SPS(33)=0x42, PPS(34)=0x44, IDR_W_RADL(19)=0x26 (type<<1).
      for (const nal of [
        Buffer.from([0x40, 0x01]),
        Buffer.from([0x42, 0x01]),
        Buffer.from([0x44, 0x01]),
        Buffer.from([0x26, 0x01, 9])
      ]) {
        const au = asm.push(nal)
        if (au) aus.push(au)
      }
      // TRAIL_R(1)=0x02 -> a P slice, its own non-keyframe AU.
      const pAu = asm.push(Buffer.from([0x02, 0x01, 7]))
      if (pAu) aus.push(pAu)
      check(
        'hevc: VPS+SPS+PPS+IDR collapse into ONE keyframe AU',
        aus.length === 2 && aus[0].keyframe === true
      )
      check('hevc: P slice is a separate non-keyframe AU', aus[1] && aus[1].keyframe === false)
      let hstarts = 0
      for (let i = 0; i + 3 < aus[0].data.length; i++)
        if (
          aus[0].data[i] === 0 &&
          aus[0].data[i + 1] === 0 &&
          aus[0].data[i + 2] === 0 &&
          aus[0].data[i + 3] === 1
        )
          hstarts++
      check('hevc: keyframe AU carries VPS+SPS+PPS+IDR (4 NALs)', hstarts === 4)
    }

    // ── buildFfmpegArgs ──
    console.log('buildFfmpegArgs')
    {
      const cfg = {
        width: 1920,
        height: 1080,
        fps: 60,
        codec: 'h264',
        minBitrateKbps: 6000,
        startBitrateKbps: 20000,
        maxBitrateKbps: 30000,
        cursor: 'composited'
      }
      const nv = buildFfmpegArgs(cfg, {}).join(' ')
      check(
        'nvenc: ddagrab DXGI capture at target fps',
        nv.includes('ddagrab=output_idx=0:framerate=60')
      )
      // dup_frames=0 (on-change) is always on; draw_mouse tracks cursor mode.
      check(
        'nvenc: on-change capture + composited cursor baked in',
        nv.includes('dup_frames=0:draw_mouse=1')
      )
      const sep = buildFfmpegArgs({ ...cfg, cursor: 'separate' }, { gop: 60 }).join(' ')
      check(
        "nvenc: cursor 'separate' -> draw_mouse=0 (no composited cursor)",
        sep.includes('dup_frames=0:draw_mouse=0')
      )
      // zero-copy: NVENC ingests the d3d11 RGB surface directly (no scale_d3d11 --
      // its VideoProcessor won't configure BGRA->NV12 on this GPU; real-ffmpeg run).
      check('nvenc: zero-copy, NO scale_d3d11 filter', !nv.includes('scale_d3d11'))
      check(
        'nvenc: low-latency flags (ull, bf 0, zerolatency)',
        nv.includes('-tune ull') && nv.includes('-bf 0') && nv.includes('-zerolatency 1')
      )
      check(
        'nvenc: VBR target 20000k + maxrate cap 30000k',
        nv.includes('-rc vbr') && nv.includes('-b:v 20000k') && nv.includes('-maxrate 30000k')
      )
      // Step 1 REVERTED: -intra-refresh is incompatible with the VideoToolbox
      // receiver (froze at every GOP length). Plain periodic IDR every 2s (-g 120),
      // NO -intra-refresh; -forced-idr kept (harmless, forces a real IDR on PLI).
      check(
        'nvenc: plain periodic IDR -g 120 + forced-idr, NO intra-refresh',
        !nv.includes('-intra-refresh') &&
          nv.includes('-forced-idr 1') &&
          nv.includes('-g 120') &&
          !nv.includes('-g 60') &&
          !nv.includes('-g 999999')
      )
      check(
        'nvenc: Annex-B pipe out with in-band params',
        nv.includes('-bsf:v dump_extra') &&
          nv.includes('-f h264') &&
          nv.includes('-flush_packets 1') &&
          nv.endsWith('pipe:1')
      )
      const mf = buildFfmpegArgs(cfg, { gop: 60, encoder: 'h264_mf' }).join(' ')
      check(
        'mf fallback: hwdownload + CPU scale + h264_mf',
        mf.includes('hwdownload,format=bgra,scale=1920:1080') && mf.includes('-c:v h264_mf')
      )
      // quality-sweep knobs: default byte-identical (p1/20000k), override honoured
      check('default preset is p1 (contract default)', nv.includes('-preset p1'))
      const swept = buildFfmpegArgs(cfg, { gop: 60, preset: 'p4', bitrateKbps: 30000 }).join(' ')
      check(
        'sweep override: preset p4 + 30000k VBR target',
        swept.includes('-preset p4') &&
          swept.includes('-b:v 30000k') &&
          !swept.includes('-b:v 20000k')
      )
      check(
        'sweep bitrate reaches mf fallback too',
        buildFfmpegArgs(cfg, { encoder: 'h264_mf', bitrateKbps: 30000 })
          .join(' ')
          .includes('-b:v 30000k')
      )
      // HEVC fallback encoder: same low-latency flags, hevc_nvenc + raw hevc container
      // (so the ffmpeg fallback stays codec-coherent with the negotiated H265 SDP).
      const hv = buildFfmpegArgs({ ...cfg, codec: 'hevc' }, { encoder: 'hevc_nvenc' }).join(' ')
      check(
        'hevc: -c:v hevc_nvenc + -f hevc + same ull/vbr flags',
        hv.includes('-c:v hevc_nvenc') &&
          hv.includes('-f hevc') &&
          !hv.includes('-f h264') &&
          hv.includes('-tune ull') &&
          hv.includes('-rc vbr') &&
          hv.includes('-g 120') &&
          !hv.includes('-intra-refresh')
      )
    }

    // ── buildCapturerArgs (Step 3 custom DXGI capturer CLI contract) ──
    console.log('buildCapturerArgs')
    {
      const cfg = {
        width: 1920,
        height: 1080,
        fps: 60,
        codec: 'h264',
        minBitrateKbps: 6000,
        startBitrateKbps: 25000,
        maxBitrateKbps: 40000,
        cursor: 'composited'
      }
      const a = buildCapturerArgs(cfg).join(' ')
      check('capturer: stdout output by default', a.includes('--output stdout'))
      check('capturer: monitor 0 default', a.includes('--monitor 0'))
      check('capturer: h264 codec by default', a.includes('--codec h264'))
      check(
        'capturer: hevc config -> --codec h265',
        buildCapturerArgs({ ...cfg, codec: 'hevc' })
          .join(' ')
          .includes('--codec h265')
      )
      check('capturer: fps from config', a.includes('--fps 60'))
      check(
        'capturer: VBR target 25000 + maxrate 40000 from config',
        a.includes('--bitrate 25000') && a.includes('--maxrate 40000')
      )
      check(
        'capturer: -g 120 default (NVENC_KEYFRAME_GOP, NO intra-refresh flag)',
        a.includes('--gop 120') && !a.includes('intra-refresh')
      )
      check(
        'capturer: --vbv-ms 250 default (byte-identical; Layer-1 A/B drives 33 via tune-file)',
        a.includes('--vbv-ms 250')
      )
      const b = buildCapturerArgs(cfg, {
        output: '/tmp/out.h264',
        outputIdx: 1,
        gop: 60,
        bitrateKbps: 30000,
        maxBitrateKbps: 50000,
        vbvMs: 33
      }).join(' ')
      check(
        'capturer: overrides (output path, monitor, gop, bitrate, maxrate, vbv-ms)',
        b.includes('--output /tmp/out.h264') &&
          b.includes('--monitor 1') &&
          b.includes('--gop 60') &&
          b.includes('--bitrate 30000') &&
          b.includes('--maxrate 50000') &&
          b.includes('--vbv-ms 33')
      )
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
  })
  .catch((e) => {
    console.error('setup failed:', e)
    process.exit(2)
  })
