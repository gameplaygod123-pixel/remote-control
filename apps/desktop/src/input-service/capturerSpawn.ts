// Secure-desktop SYSTEM capturer spawn — request validation + argv building.
// docs/secure-desktop-plan.md "2b spawn-trigger contract (FROZEN)".
//
// The user-session sender HOSTS the request pipe and writes ONE structured JSON spawn
// request (built by capturerArgs.ts `buildCapturerSpawnRequest`, 1:1 with buildCapturerArgs).
// The SYSTEM launcher (service.ts) CONNECTS, reads the frame, and calls validateSpawnRequest
// HERE before spawning. Because a same-user process could squat/write this pipe (the Fix A
// residual), the launcher trusts NOTHING from the wire: it validates every field, clamps the
// numbers, and builds the argv ITSELF — the capturer exe is the launcher's own resolved path,
// never from the request, and a raw command string is never accepted.

import type { CapturerSpawnRequest } from '../video-native/sender/capturerArgs'

// Request pipe the sender hosts (Fix A: sender HOSTS, SYSTEM launcher CONNECTS). Mirrors the
// input pipe naming in protocol.ts.
export const CAPTURER_SPAWN_PIPE = '\\\\.\\pipe\\personal-remote-capturer-spawn'

// Capturer stderr sink. Public (world-readable) so the medium helper / owner can tail it —
// SYSTEM's C:\Windows\Temp files get a SYSTEM+Admins-only DACL that hides them (the SERVICE_LOG
// lesson in protocol.ts).
export const CAPTURER_SYSTEM_LOG = 'C:\\Users\\Public\\personal-remote-capturer-system.log'

// Only `pr-capturer-<id>` pipes with a conservative id charset are accepted (no spaces, so the
// argv can't be split/injected; no traversal into other pipe names).
const PIPE_NAME_RE = /^\\\\\.\\pipe\\pr-capturer-[A-Za-z0-9._-]+$/

function intInRange(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return null
  return v
}

/**
 * Validate a raw parsed-JSON spawn request off the wire. Returns a clean
 * CapturerSpawnRequest or null (caller logs + skips — never spawns on invalid).
 */
export function validateSpawnRequest(raw: unknown): CapturerSpawnRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  if (typeof r.pipeName !== 'string' || !PIPE_NAME_RE.test(r.pipeName)) return null
  if (r.codec !== 'h264' && r.codec !== 'h265') return null
  if (typeof r.desktopFollow !== 'boolean') return null

  const monitor = intInRange(r.monitor, 0, 15)
  const fps = intInRange(r.fps, 1, 240)
  const bitrate = intInRange(r.bitrate, 500, 200_000)
  const maxrate = intInRange(r.maxrate, 500, 500_000)
  const gop = intInRange(r.gop, 1, 100_000)
  const vbvMs = intInRange(r.vbvMs, 1, 10_000)
  if (
    monitor === null ||
    fps === null ||
    bitrate === null ||
    maxrate === null ||
    gop === null ||
    vbvMs === null
  ) {
    return null
  }

  return {
    pipeName: r.pipeName,
    monitor,
    codec: r.codec,
    fps,
    bitrate,
    maxrate,
    gop,
    vbvMs,
    desktopFollow: r.desktopFollow
  }
}

/**
 * Build the capturer argv (without the exe path) for the SYSTEM path from a VALIDATED request.
 * Mirrors buildCapturerArgs' flag set + order exactly (anti-drift, asserted in verify-units)
 * and adds `--desktop-follow` (the secure-desktop follow that only the SYSTEM path needs).
 */
export function buildSystemCapturerArgv(req: CapturerSpawnRequest): string[] {
  return [
    '--output',
    `pipe:${req.pipeName}`,
    '--monitor',
    String(req.monitor),
    '--codec',
    req.codec,
    '--fps',
    String(req.fps),
    '--bitrate',
    String(req.bitrate),
    '--maxrate',
    String(req.maxrate),
    '--gop',
    String(req.gop),
    '--vbv-ms',
    String(req.vbvMs),
    '--desktop-follow'
  ]
}
