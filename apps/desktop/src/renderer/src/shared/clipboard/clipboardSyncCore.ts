// Platform-agnostic core of the bidirectional clipboard-text sync. Holds the
// polling + echo-guard + size-cap logic with NO dependency on where the
// clipboard actually lives, so the same code runs in two very different
// hosts:
//   - the renderer (controller side, and the agent's own fallback path),
//     reading/writing via Electron IPC (window.api.clipboard)
//   - the agent's pure-Node input-helper process, reading/writing the OS
//     clipboard directly -- this is the whole point: when the agent window
//     is hidden to the tray its renderer is throttled, so clipboard sync has
//     to run in the un-throttled helper alongside input (see
//     docs/native-input-plan.md and input-helper/index.ts).
//
// Caller supplies the clipboard access + how to send/subscribe on the data
// channel, keeping this file free of both `window` and `node-datachannel`
// types so either host can import it.

export interface ClipboardAccess {
  read: () => Promise<string> | string
  write: (text: string) => Promise<void> | void
}

// Minimal shape shared by a browser RTCDataChannel and node-datachannel's
// polyfill channel -- only what this sync actually touches.
export interface ClipboardChannelLike {
  readyState: string
  send: (data: string) => void
  onmessage: ((event: { data: unknown }) => void) | null
  onopen?: (() => void) | null
  onclose?: (() => void) | null
}

const POLL_INTERVAL_MS = 1000

// Anything bigger than this is almost certainly an accidental "select all"
// copy of a huge document/log -- silently skip instead of shoving hundreds
// of KB through a channel that shares the connection with live video.
const MAX_TEXT_BYTES = 256 * 1024

function byteLength(text: string): number {
  // TextEncoder exists in both modern Node and the renderer.
  return new TextEncoder().encode(text).length
}

// Returns a cleanup function that stops the poll and detaches handlers.
export function runClipboardSync(
  channel: ClipboardChannelLike,
  access: ClipboardAccess
): () => void {
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
    void access.write(text)
  }

  function start(): void {
    void Promise.resolve(access.read()).then((initial) => {
      if (lastSynced === null) lastSynced = initial ?? ''
    })
    interval = setInterval(async () => {
      if (channel.readyState !== 'open') return
      if (lastSynced === null) return // initial seed hasn't resolved yet
      const text = await access.read()
      if (!text || text === lastSynced) return
      if (byteLength(text) > MAX_TEXT_BYTES) return
      lastSynced = text
      channel.send(text)
    }, POLL_INTERVAL_MS)
  }

  if (channel.readyState === 'open') start()
  else channel.onopen = () => start()

  const stop = (): void => {
    if (interval) clearInterval(interval)
    interval = null
  }
  channel.onclose = stop
  return stop
}
