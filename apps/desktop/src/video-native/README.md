# video-native

The native low-latency video pipeline. Isolated on purpose (owner's ask): all
new native-video code lives **here**, and the existing WebRTC path
(`agent/AgentView.tsx`, `shared/webrtc/*`, the controller `<video>`) is touched
**only** at the one branch point that picks `native` vs `webrtc`. That keeps the
old path a trivially-selectable fallback and stops the two entangling.

Full rationale, phases, and division of labor: [`docs/native-video-plan.md`](../../../../docs/native-video-plan.md).

## Layout

```
video-native/
  shared/       ← FROZEN foundation (this is done). Both sides build against it.
    contract.ts   codecs, VideoConfig, stats, the native-video capability + pipeline flag
    ipc.ts        main ↔ helper message contracts + host/callback interfaces
  sender/       ← Windows-side Claude. DXGI capture · MF/NVENC encode · RTP send. (Phase 1)
  receiver/     ← Mac-side Claude. RTP recv · VideoToolbox decode · AVSampleBufferDisplayLayer. (Phase 2)
  native/       ← FFI bindings / native addons (DXGI, MF, VideoToolbox, Metal). Form decided in Phase 0.
```

## The one interface both halves share

The agent is the SDP **offerer** (as today); the controller **answers**.

```
  agent (Windows)                    controller (Mac)
  video-native/sender                video-native/receiver
  ─────────────────                  ───────────────────
  DXGI capture                       RTP recv (node-datachannel)
  HW encode (MF/NVENC)               VideoToolbox decode
  RTP send (node-datachannel)  ───▶  AVSampleBufferDisplayLayer render
        │                                    │
        └── offer/ICE via existing signaling, channel:'video', caps:['native-video'] ──┘
```

Each side runs as a **separate process forked like the input helper**
(`ELECTRON_RUN_AS_NODE=1`), supervised by a host in `main/` modeled on
`main/inputHelperHost.ts` (respawn, ping/pong, ICE relay). Main also relays SDP
over signaling and — for the receiver — sends `set-render-rect` so the native
video window tracks the Electron session view.

## Do not

- Do not edit the WebRTC video path except the single `native`-vs-`webrtc`
  branch point.
- Do not change `shared/contract.ts` or `shared/ipc.ts` without re-syncing both
  halves — they are the frozen foundation. Propose changes in the plan first.
- Do not merge to `main` from the Windows side; push the branch, Mac reviews +
  merges + releases (per repo CLAUDE.md).
- Do not ship any native/FFI piece as a full release before it's verified on the
  real machine — prerelease first (golden rule #1).
