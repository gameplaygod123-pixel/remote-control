import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import {
  DEFAULT_VIDEO_PIPELINE,
  VIDEO_PIPELINE_ENV,
  type VideoPipeline
} from '../video-native/shared/contract'

// The machine's video-pipeline preference, persisted in userData like the app
// mode / house token / theme so it survives updates + reinstalls. This is what
// lets "run native as the primary" be a saved per-machine choice instead of an
// env var + a special launcher every time.
//
// AUTO-NATIVE (owner decision 2026-07-07: "บังคับออโต้ native เป็นหลัก"): with no
// saved file the default is now 'native', so a fresh machine tries the low-latency
// path automatically -- no toggle press, no env var. The sidebar bolt becomes the
// OFF switch (write 'webrtc') if native ever misbehaves.
//
// This is SAFE despite native being FFI (koffi + node-datachannel + ffmpeg) because
// the fallback is automatic + total: 'native' only ACTUALLY engages when BOTH peers
// advertise NATIVE_VIDEO_CAP and the helper hosts report ready (see main/index.ts +
// contract.ts). On any machine where native can't run -- ffmpeg missing, no NVENC,
// a Mac agent, a spawn failure -- the cap is never advertised and the session
// silently uses WebRTC. So WebRTC is never removed; it is the invisible safety net.
// Golden rule #1 still applies to SHIPPING this flip: it must go out as a PRERELEASE
// and be verified on the real Windows agent (ffmpeg present) before any full release.
//
// The env var VIDEO_PIPELINE still wins when set (dev launcher / test harness), and
// 'webrtc' saved in the file forces the old path for that machine.

const AUTO_DEFAULT_PIPELINE: VideoPipeline = 'native'

const PIPELINES: readonly VideoPipeline[] = ['webrtc', 'native']

function filePath(): string {
  return join(app.getPath('userData'), 'video-pipeline.txt')
}

/** The saved preference alone (env NOT consulted). Defaults to 'native' (auto). */
export function getVideoPipeline(): VideoPipeline {
  try {
    if (existsSync(filePath())) {
      const saved = readFileSync(filePath(), 'utf-8').trim()
      if ((PIPELINES as readonly string[]).includes(saved)) return saved as VideoPipeline
    }
  } catch {
    /* unreadable -> default */
  }
  return AUTO_DEFAULT_PIPELINE
}

export function saveVideoPipeline(pipeline: VideoPipeline): void {
  writeFileSync(filePath(), PIPELINES.includes(pipeline) ? pipeline : DEFAULT_VIDEO_PIPELINE)
}

/**
 * The effective pipeline for THIS run: the VIDEO_PIPELINE env var still wins when
 * set (keeps the dev launcher + test harness workflow byte-for-byte), otherwise
 * the saved per-machine preference. Call this ONLY after app-ready (it reads
 * userData) and never at module scope -- getPath('userData') returns the wrong
 * path before ready (documented caveat in CLAUDE.md).
 */
export function resolveVideoPipeline(): VideoPipeline {
  const env = process.env[VIDEO_PIPELINE_ENV]
  if (env === 'native' || env === 'webrtc') return env
  return getVideoPipeline()
}

/** Convenience: true when the native pipeline should be engaged this run. */
export function nativePipelineEnabled(): boolean {
  return resolveVideoPipeline() === 'native'
}
