// Bidirectional clipboard *text* sync over its own WebRTC data channel --
// copy on either machine, paste on the other. Text only for now: images/
// files would need size negotiation and a different wire format, and the
// file-transfer channel already covers moving big payloads deliberately.
//
// Poll-based because neither OS reliably pushes clipboard-change events
// through Electron: on macOS there is no native clipboard event at all
// (even native apps poll NSPasteboard's changeCount), so a 1s poll is the
// same technique everything else uses. The poll is two cheap IPC calls,
// nothing crosses the network unless the text actually changed.

const POLL_INTERVAL_MS = 1000

// Anything bigger than this is almost certainly an accidental "select all"
// copy of a huge document/log -- silently skip instead of shoving hundreds
// of KB through a channel that shares the connection with live video.
const MAX_TEXT_BYTES = 256 * 1024

export function attachClipboardChannel(channel: RTCDataChannel): void {
  // The last text either side is known to have -- set both when we send and
  // when we receive, so a received text doesn't bounce straight back as a
  // "local change" on the next poll (an infinite echo loop between the two
  // machines). null means "not seeded yet": whatever was sitting in the
  // clipboard from before the session must not auto-sync on connect.
  let lastSynced: string | null = null
  let interval: ReturnType<typeof setInterval> | null = null

  channel.onmessage = (event) => {
    const text = typeof event.data === 'string' ? event.data : ''
    if (!text || text === lastSynced) return
    lastSynced = text
    void window.api.clipboard.write(text)
  }

  function start(): void {
    void window.api.clipboard.read().then((initial) => {
      if (lastSynced === null) lastSynced = initial ?? ''
    })
    interval = setInterval(async () => {
      if (channel.readyState !== 'open') return
      if (lastSynced === null) return // initial seed hasn't resolved yet
      const text = await window.api.clipboard.read()
      if (!text || text === lastSynced) return
      if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) return
      lastSynced = text
      channel.send(text)
    }, POLL_INTERVAL_MS)
  }

  if (channel.readyState === 'open') start()
  else channel.onopen = () => start()

  channel.onclose = () => {
    if (interval) clearInterval(interval)
    interval = null
  }
}
