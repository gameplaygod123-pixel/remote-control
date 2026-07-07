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
// SAFETY BAR (golden rule #1): the code default stays 'webrtc'. Native is native
// FFI (koffi + node-datachannel + ffmpeg) and must be a deliberate opt-in that
// was verified on real hardware. With no saved file and no env, resolveVideoPipeline()
// returns 'webrtc' -> the host processes never spawn -> the build is byte-identical
// to today. Even when 'native' is selected, the session only actually uses it if
// BOTH peers advertise NATIVE_VIDEO_CAP and the helper hosts report ready
// (see main/index.ts + contract.ts) -- otherwise it silently falls back to WebRTC.
// So WebRTC is never removed; it is the automatic safety net under native.

const PIPELINES: readonly VideoPipeline[] = ['webrtc', 'native']

function filePath(): string {
  return join(app.getPath('userData'), 'video-pipeline.txt')
}

/** The saved preference alone (env NOT consulted). Defaults to 'webrtc'. */
export function getVideoPipeline(): VideoPipeline {
  try {
    if (existsSync(filePath())) {
      const saved = readFileSync(filePath(), 'utf-8').trim()
      if ((PIPELINES as readonly string[]).includes(saved)) return saved as VideoPipeline
    }
  } catch {
    /* unreadable -> default */
  }
  return DEFAULT_VIDEO_PIPELINE
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
