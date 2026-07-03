// Messages sent controller -> agent over the WebRTC input data channel.
// This never touches the signaling server -- it's the peer-to-peer channel
// alongside the video track. Coordinates are fractions of the remote
// screen (0..1 on both axes), not pixels, since the controller only knows
// the *decoded video* resolution, which the agent's real screen resolution
// may not exactly match (e.g. resize, differing scale factors).
export type MouseButton = 'left' | 'right' | 'middle'

export type RemoteInputMessage =
  | { t: 'move'; x: number; y: number }
  | { t: 'down'; button: MouseButton }
  | { t: 'up'; button: MouseButton }
  | { t: 'wheel'; dy: number }
  | { t: 'keydown'; code: string }
  | { t: 'keyup'; code: string }

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
