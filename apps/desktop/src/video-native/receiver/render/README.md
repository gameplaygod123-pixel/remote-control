# receiver/render — native Swift render binary

The Mac controller's native present stage. A standalone Swift binary (built with
`swiftc`, CLT — no Xcode.app, no node addon; toolchain settled in
`../phase0/RESULTS.md`) that the Node receiver helper spawns as a child, exactly
as the Windows sender spawns ffmpeg. It hardware-decodes H.264 via VideoToolbox
and presents through `AVSampleBufferVideoRenderer` in a borderless, click-through
`NSWindow` placed over the Electron session view — the path that removes the
`<video>`/compositor latency wall (`docs/native-video-plan.md` §3a).

## Build

```
swiftc -O main.swift -o video-render
```

Produces a single self-contained binary. Packaging (into the app's Resources,
codesign/notarize) is a Phase 2 ship task; until then the helper resolves it via
`VIDEO_RENDER_PATH`.

## I/O contract with the Node helper (FROZEN)

The helper owns RTP recv + depacketize; this binary owns decode + present. They
talk over three fds so the compressed video byte-stream stays separate from
low-rate control and telemetry — the same clean split the sender uses with ffmpeg.

| fd | dir | payload |
| --- | --- | --- |
| stdin (0) | helper → render | **length-prefixed Annex-B access units**: `[4-byte BE length][AU bytes]`. The helper already reassembled AUs from RTP, so framing is exact — no re-parsing ambiguity. |
| fd 3 | helper → render | line-delimited control JSON: `{"cmd":"render-rect","x","y","width","height","scale"}` (screen **points, top-left origin**) and `{"cmd":"stop"}`. |
| stdout (1) | render → helper | line-delimited events: `{"evt":"ready"}`, `{"evt":"first-frame"}`, `{"evt":"stats",...}`. |
| stderr (2) | render → helper | human logs (`[render] ...`). |

`--selftest` runs the identical decode+present path against internally-encoded
synthetic frames (no window, no stdin) — headless verification like the sender's
SyntheticFrameSource. Verified on the real Mac: `decoded 120/120`, `first-frame`,
`ok:true`.

## Key decisions ("best path", not easy path)

- **AVSampleBufferVideoRenderer, not a pixel copy back to the renderer.** Copying
  decoded frames into an Electron `<canvas>` would reintroduce the compositor wall
  we're removing. A separate native window is the whole point of §3a.
- **Borderless + `ignoresMouseEvents` (click-through).** The overlay must not eat
  mouse events — they pass through to the Electron window beneath, which captures
  them for input (unchanged). Positioned/resized by main via `set-render-rect`.
- **`kCMSampleAttachmentKey_DisplayImmediately`.** Present each frame ASAP with no
  timebase scheduling — the lowest-latency present path ("glued to the mouse").
- **Length-prefixed AU framing on stdin.** The helper has exact AU boundaries from
  the depacketizer; framing them avoids the binary re-guessing frame boundaries.

## TODO (Phase 2 continuation)

- Decode/present latency + fps in the `stats` event (currently a stub).
- Multi-screen `render-rect` (pick the NSScreen the Electron window is on).
- Keyframe-needed signal back to the helper when decode fails mid-stream (helper
  then calls `track.requestKeyframe()` → PLI to the agent).
