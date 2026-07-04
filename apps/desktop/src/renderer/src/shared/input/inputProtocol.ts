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
export type RemoteInputMessage =
  | { t: 'move'; x: number; y: number; seq?: number }
  | { t: 'down'; button: MouseButton }
  | { t: 'up'; button: MouseButton }
  | { t: 'wheel'; dy: number }
  | { t: 'keydown'; code: string }
  | { t: 'keyup'; code: string }
  | { t: 'text'; text: string }

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
export function isPrintableKey(e: KeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey
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
