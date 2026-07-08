// Messages sent controller -> agent over the WebRTC input data channel.
// This never touches the signaling server -- it's the peer-to-peer channel
// alongside the video track. Coordinates are fractions of the remote
// screen (0..1 on both axes), not pixels, since the controller only knows
// the *decoded video* resolution, which the agent's real screen resolution
// may not exactly match (e.g. resize, differing scale factors).
export type MouseButton = 'left' | 'right' | 'middle'

// `seq` on 'move': moves travel over an unordered/no-retransmit channel
// (see peerConnection.ts), so a stale position can physically arrive after
// a newer one -- the agent uses the sequence number to drop it instead of
// jerking the cursor backwards. Optional so an older controller build
// (no seq) still works against a newer agent.
// `scan` on keydown/keyup: GAME-MODE key injection. When true the agent
// injects the key as a raw HARDWARE SCAN CODE (KEYEVENTF_SCANCODE, wVk=0)
// instead of a virtual-key event, so DirectInput / RawInput / GetAsyncKeyState
// games all see it as a real keyboard press that can be HELD -- the plain VK
// path and, worse, the Unicode `text` path (a character, not a key press) are
// invisible to most games. Absent/false keeps the byte-identical VK path used
// for normal typing and shortcuts (no regression). Optional so an older agent
// (no scan handling) still injects the key via the VK path -- graceful.
export type RemoteInputMessage =
  | { t: 'move'; x: number; y: number; seq?: number }
  | { t: 'down'; button: MouseButton }
  | { t: 'up'; button: MouseButton }
  | { t: 'wheel'; dy: number }
  | { t: 'keydown'; code: string; scan?: boolean }
  | { t: 'keyup'; code: string; scan?: boolean }
  | { t: 'text'; text: string }

// The remote machine's CURRENT cursor SHAPE, reported agent -> controller by
// the input helper (Windows) so the controller can draw the matching NATIVE
// cursor. The native video ships WITHOUT a composited cursor (ddagrab
// draw_mouse=0) so a mouse-only move isn't a "desktop change" and NVENC sits
// near-idle on a static screen -- the Parsec-style GPU win. Each value is a
// valid CSS `cursor` keyword, applied verbatim on the video element, so macOS
// renders the real shape itself (crisp, 0-latency, correct hotspot); 'none'
// hides it (the remote app hid its cursor). Unknown/custom app cursors fall
// back to 'default'. Only standard system cursors are recognised -- shape, not
// pixels, crosses the wire, so the FFI stays a single GetCursorInfo call (no
// bitmap plumbing, which is what segfaulted the v1.15.0 clipboard FFI).
export type CursorShape =
  | 'default'
  | 'text'
  | 'pointer'
  | 'wait'
  | 'progress'
  | 'help'
  | 'crosshair'
  | 'move'
  | 'not-allowed'
  | 'ns-resize'
  | 'ew-resize'
  | 'nwse-resize'
  | 'nesw-resize'
  | 'none'

// Sent over the dedicated 'cursor' data channel (helper mode only), reliable/
// ordered and only on change -- negligible traffic.
export type RemoteCursorMessage = { shape: CursorShape }

// Physical-key-code injection (nut.js's Key enum) only covers a fixed,
// US-layout-shaped set of keys -- there's no way to express "type a Thai
// character" as a physical key press at all. Printable characters are sent
// as the browser's already-resolved KeyboardEvent.key instead (which
// reflects whatever input layout/IME is active on the controller) and
// typed via nut.js's Unicode-aware keyboard.type() on the agent, which
// works regardless of the language or the agent's own active layout.
// Excluded whenever Ctrl/Alt/Meta is held -- that's a shortcut (Ctrl+C),
// not text entry, and must go through the physical-key hold path instead
// so the modifier combo is real on the agent's OS.
//
// Backquote (`~) is also excluded even though it produces a length-1 key:
// on Windows with a Thai layout it's the standard Thai/English toggle, so
// it has to arrive as a *physical key press* for the toggle to fire --
// sent as typed text, the remote machine just receives a ` character and
// the language never switches. When the toggle isn't configured, a
// physical Grave press still types `/~ natively, so nothing is lost.
export function isPrintableKey(e: KeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.code !== 'Backquote'
}

// The window-level keydown/keyup listeners that forward keys to the
// remote machine need to leave local UI elements (the device-name field,
// any future text input in this same window) alone -- otherwise typing
// into them gets hijacked and sent to the remote machine instead of
// updating the local field.
export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
}

// The video element is styled with object-fit: contain, so it letterboxes
// when the element's aspect ratio doesn't exactly match the stream's --
// this maps a raw client-coordinate click back to a 0..1 fraction of the
// actual video content, returning null for clicks that landed on a
// letterbox bar rather than the video itself.
export function videoRelativePosition(
  video: HTMLVideoElement,
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  const rect = video.getBoundingClientRect()
  if (!video.videoWidth || !video.videoHeight || rect.width === 0 || rect.height === 0) return null

  const videoAspect = video.videoWidth / video.videoHeight
  const boxAspect = rect.width / rect.height

  let renderedWidth = rect.width
  let renderedHeight = rect.height
  let offsetX = 0
  let offsetY = 0

  if (boxAspect > videoAspect) {
    renderedWidth = rect.height * videoAspect
    offsetX = (rect.width - renderedWidth) / 2
  } else {
    renderedHeight = rect.width / videoAspect
    offsetY = (rect.height - renderedHeight) / 2
  }

  const x = (clientX - rect.left - offsetX) / renderedWidth
  const y = (clientY - rect.top - offsetY) / renderedHeight

  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}
