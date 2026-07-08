// koffi loader for the in-process native render surface (librvr.dylib, built from
// video-native/receiver/render/embed.swift). This composites decoded H.264 frames
// INSIDE the Electron controller window instead of a separate floating NSWindow --
// the fix for the native-video-plan §3a crux (drag stutter / covers-everything /
// clipped corners / fullscreen mouse). See embed.swift for the why.
//
// Only ever touched on the controller in VIDEO_PIPELINE=native mode. Following
// golden rule #5 (and injectorWin32.ts's precedent), koffi.load() is LAZY -- never
// at module scope -- so a default build / the agent side never dlopens anything.
// Any failure degrades gracefully to unavailable (the caller keeps the old path
// only if it wants; today native simply won't paint and logs why).

import koffi from 'koffi'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { VideoCodec } from '../video-native/shared/contract'

type AttachFn = (viewPtr: bigint) => void
type PushFn = (data: Buffer, len: number) => void
type SetCodecFn = (codec: number) => void
type DetachFn = () => void

let loaded = false
let available = false
let attachFn: AttachFn | null = null
let pushFn: PushFn | null = null
let setCodecFn: SetCodecFn | null = null
let detachFn: DetachFn | null = null

function resolveLibPath(): string | null {
  const fromEnv = process.env.VIDEO_RENDER_LIB
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const resDir = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resDir) {
    const bundled = join(resDir, 'video-render', 'librvr.dylib')
    if (existsSync(bundled)) return bundled
  }
  // Dev fallback: the build script drops it in out/video-render, a sibling of
  // out/main (where __dirname points) that survives main rebuilds.
  const devLib = join(__dirname, '..', 'video-render', 'librvr.dylib')
  if (existsSync(devLib)) return devLib
  return null
}

function ensureLoaded(): boolean {
  if (loaded) return available
  loaded = true
  if (process.platform !== 'darwin') return false
  const libPath = resolveLibPath()
  if (!libPath) {
    console.error('[native-render] librvr.dylib not found (set VIDEO_RENDER_LIB)')
    return false
  }
  try {
    const lib = koffi.load(libPath)
    attachFn = lib.func('void rvr_attach(uint64_t view)') as unknown as AttachFn
    pushFn = lib.func('void rvr_push(uint8_t *data, int32_t len)') as unknown as PushFn
    // Optional (older dylibs won't export it) -- guarded so a stale librvr.dylib
    // without rvr_set_codec still loads and plays H.264 instead of failing to load.
    try {
      setCodecFn = lib.func('void rvr_set_codec(int32_t codec)') as unknown as SetCodecFn
    } catch {
      setCodecFn = null
    }
    detachFn = lib.func('void rvr_detach()') as unknown as DetachFn
    available = true
    console.log(`[native-render] loaded ${libPath}`)
  } catch (e) {
    console.error(`[native-render] load failed: ${(e as Error).message}`)
    available = false
  }
  return available
}

/** True once the dylib is loadable on this machine (darwin + present + valid). */
export function nativeSurfaceAvailable(): boolean {
  return ensureLoaded()
}

/**
 * Attach the video subview to the controller window's content view. `handle` is
 * BrowserWindow.getNativeWindowHandle() -- on macOS an 8-byte little-endian NSView
 * pointer. Idempotent (the dylib guards a double-attach). Returns false if the
 * surface isn't available.
 */
export function attachNativeSurface(handle: Buffer): boolean {
  if (!ensureLoaded() || !attachFn) return false
  if (handle.length < 8) return false
  attachFn(handle.readBigUInt64LE(0))
  return true
}

/** Feed one Annex-B access unit (decode + enqueue). No-op if unavailable. */
export function pushNativeAccessUnit(au: Buffer): void {
  if (!available || !pushFn) return
  pushFn(au, au.length)
}

/**
 * Set the decoder codec (from the offer SDP) before AUs arrive, so the decoder
 * builds the right CMFormatDescription (H.264 vs HEVC parameter sets). No-op if the
 * dylib is unavailable or predates rvr_set_codec (it then decodes H.264 as before).
 */
export function setNativeCodec(codec: VideoCodec): void {
  if (!ensureLoaded() || !setCodecFn) return
  setCodecFn(codec === 'hevc' ? 1 : 0)
}

/** Remove the video subview (session end / receiver-down). No-op if unavailable. */
export function detachNativeSurface(): void {
  if (!available || !detachFn) return
  detachFn()
}
