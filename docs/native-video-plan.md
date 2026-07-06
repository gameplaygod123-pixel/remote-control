# Plan: native video pipeline for Parsec-level latency

Status: **proposed — not started.** New project. Owner picked "Native — เอา
latency เท่า Parsec" over a same-tech rebuild. Intended executor: the
**Windows-side Claude** for the agent (sender) half; the **Mac-side Claude /
owner** for the controller (receiver/render) half. This doc is the handoff.

Precedent: this is the **same move that already worked for input** — see
[`native-input-plan.md`](./native-input-plan.md). Input was moved out of the
Chromium process into a pure-Node helper and became immune to the throttle.
Video has a *different* Chromium problem (pipeline latency, not throttling) but
the *shape of the fix is the same*: leave Chromium for the hot path.

---

## 1. Why (proven this session, v1.22.0)

We closed every **measurable** gap with Parsec on the same two machines:

| metric | Personal Remote v1.22.0 | Parsec |
|---|---|---|
| Network RTT | 11 ms | 10.56 ms |
| Decode | 3 ms | 3.68 ms |
| Resolution | 1920×1080 | 2560×1440 |
| Bitrate | 37 Mbps | 30 Mbps |
| Path | direct P2P | direct |

…and it **still doesn't feel "glued to the mouse"** the way Parsec does. Because
the remaining latency is **not** in anything a WebRTC/encoder setting can touch —
it's the two Chromium pipeline stages the HUD can't measure:

1. **Capture (Windows agent):** Chromium `desktopCapturer` / `getDisplayMedia`
   adds ~1 frame of its own before a frame even reaches the encoder.
2. **Render (Mac controller):** the decoded frame goes `<video>` → Chromium
   compositor → GPU → screen, vsync-aligned and buffered for "smooth playback"
   — easily 1–2 frames of pure glass-to-glass lag we cannot remove because it
   is Chromium internals, not our code.

Together these are ~30–60 ms that dominate the felt latency (the network is only
~11 ms of it). Parsec wins here with **DXGI Desktop Duplication** capture and a
**native direct-to-GPU renderer** that bypass the OS compositor. There is no
setting that closes this — only leaving the `<video>`/capture path does.

**Goal:** get "glued to the mouse" feel by moving the *video hot path* out of
Chromium on both ends, while keeping the current UI and every existing feature.

**Non-goals:** replacing signaling, replacing the input helper (it already
works), or supporting new platforms in this project. The Electron **lobby** UI
(device list, file transfer, settings, themes) is kept as-is; only the in-session
screen moves to a native window (§3).

## 1.5 North Star — what "best" means here (owner: "ทำให้ดีที่สุดไปเลย")

Since we're rewriting the video path anyway, aim for genuinely best-in-class, not
just parity. Concrete bar:

| Target | Bar | Status in foundation |
|---|---|---|
| Latency | within **~1 frame of Parsec** glass-to-glass | the whole point (native capture+render) |
| Cursor feel | **instant local cursor** (`cursor:'separate'`) | reserved in `VideoConfig.cursor` |
| Text sharpness | **4:4:4** chroma option (Parsec is 4:2:0) | reserved in `VideoConfig.chroma` |
| Color | **10-bit / HDR** option | reserved in `VideoConfig.bitDepth` |
| Codec | H.264 **and** HEVC, negotiated | reserved in `VideoCodec` |
| Resolution / fps | up to **1440p / 4K**, **120/144 fps** | parameterized in `VideoConfig` |
| Multi-monitor | pick which display | reserved in `VideoConfig.displayId` |
| Audio | Opus stereo, in sync | reserved as a parallel track (`SessionConfig.audio`) |
| Resilience | clean reconnect; no wedge on loss | Phase 3 |

**Discipline:** everything above is *anticipated by the frozen foundation now*
(so nothing needs a rearchitect later), but **implemented in phases** — do NOT
build all of it before the core path works. Default config ships conservative
(1080p60, H.264, 4:2:0, 8-bit, no audio); the "best" knobs turn on as each is
proven on real hardware. Best foundation now; best features incrementally.

---

## 2. Guiding principles (do not skip)

1. **Do not break v1.22.0.** The current WebRTC video path stays fully working
   and stays the **default**. The native path is opt-in behind a flag
   (`VIDEO_PIPELINE=native`, or a settings toggle) until it is proven better on
   real hardware. We ship improvements, not regressions.
2. **Golden rule #1 applies hard.** Every native/FFI piece (DXGI, Media
   Foundation, VideoToolbox, Metal, koffi bindings) MUST ship as a **prerelease**
   and be verified on the real machine before a full release. A bad FFI
   signature segfaults natively; JS try/catch can't catch it.
3. **Mirror the input-helper pattern.** Native video runs in a **separate
   process outside Chromium** (like the input helper), forked with
   `ELECTRON_RUN_AS_NODE=1`, talking to the Electron UI over IPC. Reuse that
   plumbing; don't invent a new one.
4. **Reuse the transport we already ship.** `node-datachannel` (libdatachannel)
   is already a dependency for the input helper and **supports media (RTP)
   tracks**, and we already have working signaling + house-token + ICE. Do not
   build a new UDP protocol in v1 — send the encoded video as an RTP media track
   over node-datachannel. The latency wins are in **capture / encode / decode /
   render**, not the transport (SRTP/ICE ≈ what WebRTC already did).
5. **One phase = one testable, revertible increment.** Each phase must be
   demoable and independently valuable, gated on a measurement.
6. **Foundation before features (owner's explicit ask).** Get the *boundaries*
   right before any feature code: the RTP track interface, the IPC contract, the
   module layout (§3.5), and the fallback flag. These are the expensive-to-change
   things. Nail them in Phase 0 and freeze them; do not let feature work start
   until they're agreed. The goal is to not have to re-lay this foundation later.

---

## 3. Architecture

Keep the entire control plane; replace only the video hot path.

```
                          KEEP (unchanged)                         NEW (native, this project)
  ┌─────────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
  Electron UI  ·  signaling  ·  house token  ·      │   Windows agent: DXGI capture → MF/NVENC
  input helper (native)  ·  file transfer  ·        │     hardware encode → RTP send
  clipboard sync  ·  auto-update                    │   Mac controller: RTP recv → VideoToolbox
  └─────────────────────────────────────────────┘   │     decode → AVSampleBufferDisplayLayer/Metal
                                                     └──────────────────────────────────────────┘

  OLD video path (kept as fallback, default until native proven):
    Windows getDisplayMedia → Chromium WebRTC H.264 → Mac <video> element

  NEW video path (this project):
    Windows DXGI Desktop Duplication → MF/NVENC HW encode (low-latency, no B-frames)
      → node-datachannel media track (RTP/SRTP over existing ICE)
      → Mac node-datachannel recv → VideoToolbox HW decode
      → AVSampleBufferDisplayLayer in a native NSWindow composited into the Electron controller
```

**Video sender (Windows agent) — new native module/process**
- **Capture:** DXGI Output Duplication (`IDXGIOutputDuplication`) — the same API
  Parsec/OBS use; delivers frames on GPU with minimal latency, and (bonus)
  keeps working when the window is hidden (no getDisplayMedia dependency).
- **Encode:** Media Foundation H.264/HEVC hardware encoder (or NVENC directly on
  NVIDIA). Configure for latency: `LOW_LATENCY` / real-time, **no B-frames**,
  infinite/long GOP with periodic IDR, 1-frame reference. This is what WebRTC's
  general-purpose encoder wouldn't let us pin down.
- **Send:** feed encoded NAL units into a node-datachannel video track.

**Video receiver (Mac controller) — new native module/process**
- **Receive:** node-datachannel media track → depacketize to NALs.
- **Decode:** VideoToolbox (`VTDecompressionSession`) hardware decode.
- **Render:** `AVSampleBufferDisplayLayer` (feed CMSampleBuffers straight in) —
  presents each frame the moment it's decoded, no `<video>`, no browser
  compositor. Hosted in a native `NSWindow`/`NSView` positioned to fill the
  session area of the Electron controller window (Electron draws the chrome:
  floating controls, sidebar; the native layer draws the video underneath/inside).

**The session view becomes its own native window (owner OK'd rewriting it,
2026-07-06 — "เขียนใหม่ให้เหมาะกับงานใหม่ก็ได้ถ้ามีผลกับความสามารถ").** This is
the preferred approach and it *removes* what was the riskiest part of the
project. Instead of fighting to composite a native layer *inside* the Electron
`BrowserWindow` (chasing the compositor's rect on every resize/move), the
**session is a purpose-built native window**:
- `AVSampleBufferDisplayLayer` (Metal) fills it — video presented direct-to-
  screen, tuned for low latency / fullscreen / vsync, no `<video>`, no browser
  compositor. This is how Parsec structures its own session window.
- The floating controls (Back / stats / status pill) ride on top as either a
  **transparent click-through Electron overlay** (reuses today's React
  `ControllerSession` controls — keeps the exact look) **or** native controls.
  Overlay-vs-native decided in a short Phase 2 spike.
- The **Electron lobby stays untouched**: device list, file transfer, settings,
  themes (incl. glass). Only the in-session screen moves to native.

Net effect: Phase 2 risk drops from "fragile Electron compositing sync" to
"build a native window + overlay" — more upfront native code, but a proven
pattern with no ongoing sync fight and a better latency ceiling.

---

## 3.5 Project layout — keep it isolated (owner's explicit ask)

Put **all** new native-video code in one self-contained folder, separate from
the existing renderer video path, so the two never entangle and the old path
stays trivially removable/keepable as the fallback:

```
apps/desktop/src/video-native/     ← NEW, isolated. Sits beside src/input-helper/.
  sender/     Windows agent: DXGI capture · MF/NVENC encode · RTP packetize + send
  receiver/   Mac controller: RTP recv · VideoToolbox decode · AVSampleBufferDisplayLayer render
  shared/     the RTP track interface · IPC message contract · the VIDEO_PIPELINE flag
  native/     FFI bindings / native addons (DXGI, MF, VideoToolbox, Metal) — form decided in Phase 0
  README.md   how to build/run this subsystem in isolation
```

Rules for keeping it un-mixed:
- The existing WebRTC video path (`agent/AgentView.tsx`, `shared/webrtc/*`, the
  controller `<video>`) is **not edited** except at the **one branch point** that
  picks `native` vs `webrtc`. Every new line lives under `video-native/`.
- **Windows Claude works only inside `video-native/sender`, `shared`, `native`**
  (+ that one wiring point), on a dedicated branch (e.g. `feat/native-video`).
  Mac side owns `video-native/receiver`. Clean split, no toes stepped on.
- One clean seam to the rest of the app: the subsystem is a **separate process**
  forked like the input helper (`ELECTRON_RUN_AS_NODE=1`), talking to Electron
  over the documented IPC contract in `video-native/shared`. Nothing reaches
  into Electron internals.
- Phase 0 writes `video-native/README.md` and the `shared/` interfaces **first**;
  those are the frozen foundation everything else builds on.

---

## 4. Division of labor

| Half | Owner | Why |
|---|---|---|
| **Windows agent native sender** (DXGI + MF/NVENC + RTP send) | **Windows-side Claude** | Windows-native, needs real Windows GPU to build+verify |
| **Mac controller native receiver + render** (VideoToolbox + AVSampleBufferDisplayLayer + NSWindow↔Electron) | **Mac-side Claude / owner** | macOS-native (Obj-C/Swift/Metal), needs the real Mac |
| **Shared:** node-datachannel media track wiring, SDP/track negotiation, the `VIDEO_PIPELINE` flag, IPC contract, stats | both (agree the interface in Phase 0) | it's the seam between the two halves |

The two halves meet at **one interface: an RTP video track negotiated over the
existing signaling.** Agree its shape (codec, payload type, RTP params, how the
offer/answer carries it) in Phase 0 so each side can build against it
independently.

---

## 5. Phases

Each phase: build → measure → gate. Do not start the next until the gate passes.

### Phase 0 — Spike & de-risk (BOTH, ~1 week)
The whole project rests on two unproven assumptions; prove them cheaply first.
- [ ] Confirm `node-datachannel` can **send and receive a live video media
      track** between the two machines outside Chromium (minimal Node script,
      hardcoded test frames ok). If it can't do media robustly → decide
      transport (fallback: raw UDP + our own RTP-lite) before anything else.
- [ ] Windows: prove DXGI capture → MF hardware encode → a savable/decodable
      H.264 stream, end to end, measuring capture+encode latency.
- [ ] Mac: prove VideoToolbox decode → `AVSampleBufferDisplayLayer` shows a
      decoded H.264 stream in a bare NSWindow, measuring decode+present latency.
- [ ] Agree the **RTP track interface** + the **IPC contract** between Electron
      and each native helper (offer/answer fields, codec, ports).
- **Gate:** a hand-wired frame goes Windows-capture → native transport →
  Mac-native-render, and the measured capture+render latency is meaningfully
  below the Chromium path. If not, stop and reconsider (native may not be worth
  it — document and fall back to keeping v1.22.0).

### Phase 1 — Windows native sender (WINDOWS CLAUDE)
- [ ] `src/video-helper/` (or extend the pattern): a pure-Node/native process
      forked like the input helper.
- [ ] DXGI Output Duplication capture of the primary display, 1080p, target
      60fps, cursor composited (or sent separately — see §7).
- [ ] Media Foundation (or NVENC) hardware encode, low-latency config (no
      B-frames, 1 ref, periodic IDR), rate control matched to v1.22.0 (min
      6 / start 20 / max 30 Mbps).
- [ ] Emit encoded frames into a node-datachannel video track; negotiate via the
      existing signaling with a `caps: ['native-video']` advertisement (old
      peers ignore it → graceful fallback to the WebRTC path).
- [ ] Behind `VIDEO_PIPELINE=native`; default stays WebRTC.
- **Gate:** the current (unchanged) Mac controller can still connect via the
  WebRTC fallback, AND a native test receiver shows the DXGI-captured stream
  with capture+encode latency measured lower than getDisplayMedia+WebRTC.
- **Ship:** prerelease; verify on the real Windows machine (golden rule #1).

### Phase 2 — Mac native receiver + render (MAC CLAUDE / OWNER)
- [ ] Native receiver: node-datachannel media recv → VideoToolbox decode →
      `AVSampleBufferDisplayLayer`.
- [ ] Build the **native session window** (§3): a dedicated Metal/
      AVSampleBufferDisplayLayer window the video fills. The Electron lobby
      opens it on connect and closes it on Back.
- [ ] Floating controls over it — spike overlay-vs-native, then reuse the
      React `ControllerSession` controls as a transparent click-through
      Electron overlay if that wins (keeps the current look).
- [ ] Wire session lifecycle: connect (open native window), Back (close +
      tear down cleanly), fullscreen, multi-display — all owned by the native
      window now, no compositor-rect chasing.
- [ ] Feed real pipeline numbers back to the existing HUD (decode/render ms from
      VideoToolbox/AVSampleBufferDisplayLayer instead of `<video>` stats).
- **Gate:** full native path end-to-end (DXGI → native render), and **glass-to-
  glass latency measured against Parsec** on the same machines (film both
  screens with a phone at 240fps; count frames from input to on-screen change).
  Target: within ~1 frame of Parsec.
- **Ship:** prerelease; verify on the real Mac.

### Phase 3 — Feature parity & polish (BOTH)
- [ ] Multi-monitor / monitor selection (DXGI per-output).
- [ ] Reconnect / self-heal parity (rebuild the native track on the same signals
      the WebRTC path uses today).
- [ ] Cursor handling decision resolved (§7).
- [ ] Audio: out of scope for v1 unless trivial; note it as a follow-up.
- [ ] Make `native` the default only after it's proven ≥ the WebRTC path on
      latency AND stability; keep WebRTC as a one-flag fallback indefinitely.

### Phase 4 — Rollout
- [ ] Prerelease with `native` default → owner runs the full test matrix
      (connect/Back cycles, Thai+English typing still fine via the untouched
      input helper, X-close mid-session, fullscreen, multi-monitor).
- [ ] Promote to full release once verified.

---

## 6. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| node-datachannel media (RTP video) is immature / lossy | med | Phase 0 spike proves it FIRST; fallback = minimal own RTP-over-UDP |
| Native FFI segfault (DXGI/MF/VT/Metal via koffi) crashes the app | med | Golden rule #1: prerelease + verify each piece; run native video in its **own process** so a crash respawns instead of killing the UI (like the input helper) |
| Native-video-in-Electron-window integration is fiddly on Mac | med | Phase 2 spike picks approach (a)/(b); worst case a separate always-on-top native window |
| A/V sync / cursor lag / tearing | low | no audio in v1; cursor decision in §7; AVSampleBufferDisplayLayer handles pacing |
| Effort balloons | med | v1.22.0 already works and stays default — we can pause anytime with zero regression |

---

## 7. Open questions (decide in Phase 0/1)

- **Cursor:** composite the OS cursor into the captured frame (simplest, but the
  cursor then carries full round-trip lag) **or** send cursor position/shape on a
  side channel and draw it **locally** on the Mac (Parsec-like "instant cursor"
  feel, more work). Local cursor is a real feel win — strongly consider it.
- **Codec:** H.264 (safest, universal HW) vs HEVC/H.265 (Parsec uses it; better
  quality/bitrate, needs HW support both ends — the Mac has it, verify the
  Windows GPU).
- **Encoder API on Windows:** Media Foundation (vendor-agnostic) vs NVENC direct
  (lower latency on NVIDIA, but NVIDIA-only). Detect and prefer NVENC if present.
- **Transport:** confirm node-datachannel media is solid; if not, the fallback
  raw-UDP path needs its own tiny design.

---

## 8. What explicitly stays untouched

Input helper, signaling server + supervisor, house token, file transfer,
clipboard sync, auto-update, the entire Electron UI (device list, session
controls, themes incl. glass), `build-win.sh` packing rules. This project adds a
video subsystem beside them; it does not touch them.
