// Named-pipe framing between the user-session input-helper (sender) and the
// SYSTEM injector-in-session (receiver). A pipe is a byte stream, so frame each
// RemoteInputMessage as a 4-byte little-endian length prefix + UTF-8 JSON.

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RemoteInputMessage } from '../renderer/src/shared/input/inputProtocol'

// SYSTEM-side log path (injector + launcher). Deliberately under C:\Users\Public
// so the file inherits a world-READABLE ACL: the SYSTEM processes' default
// C:\Windows\Temp files get a SYSTEM+Admins-only DACL that blocks a non-elevated
// read, which made every diagnostic require an elevated shell. Public lets a
// medium tool (or the owner's normal shell) tail it directly. Non-Windows
// (the Mac-side harness) falls back to tmpdir.
export const SERVICE_LOG =
  process.platform === 'win32'
    ? 'C:\\Users\\Public\\personal-remote-input-service.log'
    : join(tmpdir(), 'personal-remote-input-service.log')

// Fix A role split (docs/input-elevation-plan.md): the MEDIUM helper HOSTS this
// pipe and the SYSTEM injector CONNECTS. A SYSTEM-hosted pipe gets a default DACL
// that denies the medium helper; a user-hosted pipe is openable by SYSTEM, so
// inverting the roles needs no custom SDDL. Injector-owned pipe with an explicit
// SDDL (Fix B) + pipe-squat hardening are documented Phase 4 TODOs.
export const PIPE_NAME = '\\\\.\\pipe\\personal-remote-input'

const LEN_BYTES = 4
// Guard against a corrupt/hostile length prefix wedging the reader on a huge
// allocation. Input messages are tiny (a few hundred bytes at most).
const MAX_FRAME = 64 * 1024

export function encodeFrame(message: RemoteInputMessage): Buffer {
  const json = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(LEN_BYTES + json.length)
  frame.writeUInt32LE(json.length, 0)
  json.copy(frame, LEN_BYTES)
  return frame
}

// Stateful stream decoder: feed it whatever chunk arrived, get back the
// complete messages it now holds; partial tails are buffered for next time.
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): RemoteInputMessage[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const out: RemoteInputMessage[] = []
    while (this.buf.length >= LEN_BYTES) {
      const len = this.buf.readUInt32LE(0)
      if (len === 0 || len > MAX_FRAME) {
        // Unrecoverable desync — drop everything rather than loop forever.
        this.buf = Buffer.alloc(0)
        break
      }
      if (this.buf.length < LEN_BYTES + len) break // wait for the rest
      const json = this.buf.subarray(LEN_BYTES, LEN_BYTES + len).toString('utf8')
      this.buf = this.buf.subarray(LEN_BYTES + len)
      try {
        out.push(JSON.parse(json) as RemoteInputMessage)
      } catch {
        // Skip a single malformed frame; framing stays aligned (we already
        // advanced past it by its declared length).
      }
    }
    return out
  }
}
