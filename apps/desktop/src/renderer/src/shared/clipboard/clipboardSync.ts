// Renderer-side clipboard sync: wires the platform-agnostic core (see
// clipboardSyncCore.ts) to Electron's clipboard via IPC. Used by the
// controller (whose window is focused while controlling, so never throttled)
// and by the agent's own fallback path when the peer is too old to negotiate
// the native input-helper -- in the helper path the agent instead runs the
// same core inside the un-throttled helper process (input-helper/index.ts).

import { runClipboardSync, type ClipboardChannelLike } from './clipboardSyncCore'

export function attachClipboardChannel(channel: RTCDataChannel): void {
  // RTCDataChannel and node-datachannel's polyfill channel both satisfy
  // ClipboardChannelLike structurally, but their onmessage event types differ
  // enough that TS won't accept the assignment directly -- the core only ever
  // reads `event.data`, which both provide.
  runClipboardSync(channel as unknown as ClipboardChannelLike, {
    read: () => window.api.clipboard.read(),
    write: (text) => window.api.clipboard.write(text)
  })
}
