# Plan: move remote input to a pure-Node helper process

Status: **implemented and verified end-to-end on the affected machine.**
Branch `fix/native-input-helper`. Not yet merged/released — see §9 for what's
still open before that.

## 1. Root cause (proven end-to-end)

When the agent window is hidden to tray during a real (WAN/Mac) session,
**the entire Electron process's event loop is throttled**, not just the
renderer. Chromium's message pump (which drives Electron's main-process libuv
loop) enters a low-power state when the app has no active window, so both
timers and socket I/O in the main process stop until a window is shown again.

Measured on the affected machine, all within one hidden period:

| probe | while agent hidden |
|---|---|
| renderer data-channel receive | **0** (frozen; floods on show) |
| Electron main timer (`setInterval`) | **0/10 per 10 s** |
| Electron main socket I/O (UDP recv) | **0/~20** (packets buffered by OS, dumped on show) |
| **pure-Node process timer** (separate proc) | **10/10** ✅ |
| **pure-Node process socket I/O** (UDP recv) | **~20/~20** ✅ |

Everything that keeps the work inside the Electron process fails; a **separate
pure-Node.js process (no Chromium pump) is completely unaffected** — its timers
and socket I/O run at full rate through the freeze. This is why Parsec's native
host is immune, and it rules out the earlier "input PC in Electron main" idea.

Ruled out (all tested on the real path, all failed): `win.hide()` vs
opacity-0 / off-screen / always-on-top / 1px-opaque visible window;
`disable-backgrounding-occluded-windows` / `disable-renderer-backgrounding` /
`disable-background-timer-throttling` (already present) /
`CalculateNativeWinOcclusion` / `IntensiveWakeUpThrottling`; silent-audio
keepalive; `powerSaveBlocker('prevent-app-suspension')`; Windows Power
Throttling opt-out via `SetProcessInformation` (processes showed Normal
priority, no Efficiency mode — it is not EcoQoS). The throttle is Chromium's
own message-pump behavior, dodgeable only by leaving the Chromium process.

Note: this does not reproduce with a **localhost** controller (the machine
stays "active"), only on the real unattended path -- confirmed the local
two-instance harness is fine for wiring/interop testing, but the freeze itself
had to be verified on the real Mac path.

## 2. Approach (implemented)

The **input** data channel lives in a **separate pure-Node helper process** on
the agent. Video stays in the renderer.

- **Video PC**: unchanged. Renderer `RTCPeerConnection` + screen video track.
- **Input helper** (`apps/desktop/src/input-helper/index.ts`, pure Node):
  spawned by the agent's Electron main (`main/inputHelperHost.ts`) via
  `child_process.fork` using **`process.execPath` with
  `ELECTRON_RUN_AS_NODE=1`** — runs the bundled Electron binary as plain Node
  (no Chromium, no pump, so no throttle) while keeping the **same
  native-module ABI** as Electron, so `node-datachannel` and
  `@nut-tree-fork/nut-js` load with the app's normal `electron-builder
  install-app-deps` rebuild, no second toolchain. The helper:
  - owns the input PC via **`node-datachannel/polyfill`** (a standard-shaped
    `RTCPeerConnection`/`RTCDataChannel` implementation, so its data channel
    setup mirrors `shared/webrtc/peerConnection.ts` almost exactly): creates
    `input` (reliable) and `input-moves` (unordered, `maxRetransmits: 0`)
    channels, always as the offerer, same as the video PC;
  - runs the same move queue / coalesce / seq-drop logic that used to live in
    `AgentView.tsx`'s `enqueueRemoteInput`/`handleRemoteInput` (ported, not
    duplicated in spirit -- same algorithm, now draining straight into
    `main/input/injector.ts`'s functions instead of an IPC hop);
  - injects directly via `main/input/injector.ts` (imported as a regular
    module -- no Electron IPC on the hot path at all).
- **Controller side: no helper needed.** The controller window is
  focused/visible while controlling, so its process is never throttled. When
  the agent advertises helper support, `ControllerSession.tsx` opens a
  *second*, input-only `RTCPeerConnection` (answerer) alongside the existing
  video PC, and points `inputChannelRef`/`moveChannelRef` at its channels
  instead of the video PC's.

Only **signaling** crosses process boundaries, and only at session setup
(agent window still visible at pairing time, main not yet throttled): agent
helper ⇄ Electron main (`child_process` message, via `inputHelperHost.ts`) ⇄
agent renderer (IPC, via `preload`'s `window.api.inputHelper`) ⇄ WebSocket ⇄
controller renderer. Once the input PC is P2P-established, input flows
controller-renderer ⇄ agent-helper directly; the (possibly throttled) agent
Electron main and renderer are entirely out of the loop for input from that
point on.

## 3. Signaling protocol change (non-breaking, implemented)

`packages/protocol/src/messages.ts`:
- `channel: z.enum(['video','input']).optional()` on `SdpOfferMessage`,
  `SdpAnswerMessage`, `IceCandidateMessage`. Absent ⇒ `'video'` (what every
  pre-existing client sends).
- `caps: z.array(z.string()).optional()` on `PairRequestMessage`,
  `ConnectionRequestMessage`, `ConnectionResponseMessage`, `PairResultMessage`.
  The one capability defined so far is `"input-helper"`
  (`shared/input/capabilities.ts`'s `INPUT_HELPER_CAP`).

`server/signaling/src/index.ts` relays `caps` through both hops (controller's
`pair-request.caps` → agent's `connection-request.caps`; agent's
`connection-response.caps` → controller's `pair-result.caps`) without
otherwise inspecting or acting on it. **No other server change, no redeploy**
-- sdp/ice relay already didn't inspect message bodies.

## 4. Negotiation and fallback (implemented)

- The controller always sends `caps: ["input-helper"]` in every `pair-request`
  (initial, retry-on-unknown-device, and reconnect).
- The agent decides once per accepted connection, in
  `negotiateHelperCaps()` (`AgentView.tsx`): `useHelper = controller advertised
  input-helper AND window.api.inputHelper.isReady()`. That decision is stored
  in a ref and (a) sent back as the agent's own `caps` in
  `connection-response`, (b) read again, unchanged, when `pair-result` actually
  builds the session -- so the agent's real behavior always matches what it
  told the controller, and the controller's `pair-result.caps` (echoed by the
  server from that same connection-response) is what the controller uses to
  decide whether it also negotiates a second PC.
- **Exactly one path runs per session, never both:** if `useHelper`, the video
  PC is created *without* `createInputChannel`, and
  `window.api.inputHelper.startSession()` kicks off the helper's own PC in
  parallel; if not, the video PC creates `input`/`input-moves` exactly as
  before (the pre-existing, unchanged fallback path -- same queue code, now
  only reachable when the helper path isn't used).
- Old ↔ new interop: an old peer never sends `caps`, so
  `negotiateHelperCaps()`/`useHelper` both evaluate to false and both sides
  transparently use the original single-PC behavior -- video-only agents and
  controllers from before this change keep working unmodified.

## 5. Helper lifecycle (implemented)

`main/inputHelperHost.ts`, started once at app launch for `appMode ===
'agent'` only:
- Spawns via `fork()`, `execPath: process.execPath`, env
  `ELECTRON_RUN_AS_NODE: '1'`.
- Pings the helper every 10 s once it reports `ready`; a missed pong within 5 s
  kills and lets it respawn -- catches a hang, not just a crash.
- On exit (crash or killed hang), marks itself not-ready, fires `onDown`
  (agent renderer clears its own `useHelperRef` and posts a status message),
  and respawns after 2 s.
- `destroy()` (wired to `app.on('before-quit')`) kills the child so it never
  becomes an orphan process.

**Known limitation, accepted for this round:** if the helper crashes *during*
an active helper-backed session, there is no instant mid-call recovery --
`onDown` clears the flag so the *next* pairing correctly falls back, but the
live session's input silently stops until that next re-pair (which happens
automatically via the app's existing reconnect machinery, just not
instantaneously). Building true mid-call renegotiation (adding data channels
to an already-negotiated PC via `onnegotiationneeded`) was judged not worth
the added complexity for what should be a rare event -- the helper's only
dependencies are `node-datachannel` and the already-shipping `nut.js`.

## 6. Verified by testing

**Pre-flight (before writing the rest), on the real affected machine:**
1. A helper spawned exactly as planned (`process.execPath` +
   `ELECTRON_RUN_AS_NODE=1`) kept its timer and raw UDP socket I/O running at
   full rate while the agent's Electron main was simultaneously measured at
   0/10 -- confirmed the whole approach before any of the rest was built.
2. `node-datachannel/polyfill`'s `RTCPeerConnection`/`createDataChannel` and
   `@nut-tree-fork/nut-js`'s `mouse.setPosition` both load and work under
   `ELECTRON_RUN_AS_NODE=1` with no separate rebuild.
3. The actual *built* `out/main/input-helper.js` (not just source), spawned
   via a real `fork()` exactly as `inputHelperHost.ts` does, produced a real
   SDP offer + ICE candidates and answered a ping -- confirms the bundling
   (native deps externalized, shared chunk with `main/input/injector.ts`) is
   packaging-safe, not just source-safe.

**End-to-end functional test**, local two-instance harness (`APP_MODE=agent`/
`controller`, local `server/signaling`, `VITE_DEVICE_ID`/`VITE_PIN`
auto-connect, a synthetic mouse-move driver, and temporary verification logging
-- all removed again after, no trace left in the diff):
- **Helper path:** both sides negotiated `useHelper=true`; the input-helper
  process's own `moveMouse` calls fired continuously (2000+) with live,
  changing coordinates -- input was flowing entirely through the pure-Node
  process, never touching the agent's Electron main/renderer.
- **Fallback path:** with the helper process killed and held down (agent
  correctly saw `isReady()===false`), a fresh pairing negotiated
  `useHelper=false` on both sides, and the *original* renderer-channel path
  (`ipcMain` `input:move`) fired continuously instead -- while the helper's own
  injection path stayed completely silent (**zero** calls), confirming no
  double-injection.
- **Crash detection + respawn:** killing the helper mid-run produced the
  host's down-detection immediately, the agent's `useHelperRef` flipped to
  `false` for the next pairing, and the helper reappeared (ready again) after
  its respawn delay -- the process doesn't stay down permanently.

Not yet done: a real packaged (electron-builder NSIS) install test -- §7
covers what to check there specifically.

## 7. Still open before merge/release

- Package a real build (`npm run build:win`) and confirm the helper's script
  and `node-datachannel`'s native binary are reachable at runtime from inside
  `app.asar`/`app.asar.unpacked` (electron-builder's default native-module
  auto-unpack should already cover this the same way it already does for
  `nut.js`, but hasn't been confirmed on an actual installed build).
- A second real-machine test of the full feature (not just the pre-flight
  probes) on the originally-affected Windows machine: pair, hide the agent
  window, and confirm input keeps working continuously with the *real*
  Mac-side controller, mirroring the local end-to-end test above.
- Mac-side/controller-side and protocol review (this plan and its
  implementation were done from the Windows/agent side).

## 8. Known limitations (not fixed this round)

- **Clipboard sync and file transfer are still renderer-owned data channels**
  on the video PC (`onClipboardChannel`/`onFileChannel` in both the helper and
  fallback branches of `AgentView.tsx`'s pair-result handler) -- only mouse/
  keyboard input moved to the helper. Clipboard sync and in-flight file
  transfers will still stall while the agent window is hidden, for the exact
  same root-cause reason input used to. Not addressed here; would need the
  same helper-process treatment if it turns out to matter in practice.
- **Mid-session helper crash** doesn't recover instantly -- see §5.
- The **1px-window / stealth-hide / audio-keepalive / feature-flag
  experiments** from the investigation are fully reverted; none of that code
  remains. `win.hide()` behaves exactly as it did before this change (the
  video/clipboard/file-transfer paths still rely on the window being
  genuinely visible to avoid the freeze, same as always).

## 9. Rollout

Behind the `"input-helper"` capability flag, so mixed old/new fleets keep
working (§4). The helper path takes over automatically once both the agent and
controller are on a build that has it. No server redeploy required.

## 10. Addendum: helper-session-flapping bug (found in packaged v1.14.0)

Branch `fix/helper-session-flapping`. Reported symptom: pairing repeatedly
(controller "back" then reconnect) made the session alternate almost exactly
every other attempt -- works, dead, works, dead -- with `X`-close behavior
correctly using the helper path whenever a session did work, ruling out a
regression back to the original hidden-window freeze.

**Root cause, proven with an isolated reproduction:** `node-datachannel`'s
`RTCPeerConnection.close()` does not synchronously stop all native event
delivery. A small standalone script (create a pc, close it ~50ms later,
immediately create a second pc) showed the FIRST pc's own
`onconnectionstatechange` firing *after* `close()` was called and *after* the
second pc already existed. `input-helper/index.ts`'s handlers were written as
plain closures over the pc they were created for (`conn`), with no check that
`conn` was still the module's current `pc` -- so a stale, late-firing event
from a session's supposedly-closed connection would relay exactly as if it
belonged to whatever session happened to be current when it finally arrived.
For `onicecandidate` specifically, a late candidate carries the OLD
negotiation's ICE credentials; fed into the NEW session's peer connection (no
per-message session tag existed to catch it), it corrupts that peer
connection's ICE state. On localhost this never had a window to manifest (ICE
gathering completes in under a second, well before a `close()` from the next
session could interleave with it) -- consistent with the original hidden-
window bug also being unreproducible on localhost. The real Mac path's slower,
real-network ICE gathering gives this race a much wider window to land in,
which is why it only ever showed up there.

**Diagnostic method:** since packaged builds have no visible console for
either the agent main process or the pure-Node helper, both were instrumented
to append timestamped, session-numbered lines to `%TEMP%\input-helper.log`
(`main/inputHelperLog.ts`, temporary, still in the tree pending a decision on
whether to keep it -- see below). Every session-start, offer, answer, ICE
candidate (in and out), pc connection-state change, data-channel open, and
handled/unhandled rejection is logged, tagged with the session number the
*originating pc* was created under (not whatever session happens to be
current when the log line is written) -- so a stale event is visibly
identifiable as belonging to an older session than its neighbors in the log.
Separately checked and found **no evidence for**: the ping/pong liveness
check killing a healthy-but-busy helper (pong round-trip stayed 0-1ms through
every negotiation observed, including sessions started and killed within the
same 10s ping interval) or any unhandled promise rejection (none logged in
any run, including deliberately aggressive back-to-back reconnect cycles).

**Fix** (`input-helper/index.ts`): every handler bound to a specific pc
(`onicecandidate`, `onconnectionstatechange`, both data channels' `onopen`/
`onmessage`, and the async offer-creation continuation) now checks `pc !==
conn` first and bails out if the connection it was created for has since been
superseded. `closeSession()` also nulls the two pc-level handlers
(`onicecandidate`, `onconnectionstatechange`) before calling `close()`, as a
first line of defense -- confirmed by rerunning the isolated repro that this
alone suppresses the stale event before it ever reaches JS in the common case;
the per-handler guard is the backstop for the data-channel handlers, which
can't be reached from `closeSession()` since they're local to the closure
that created them.

**Verified:** the same isolated repro no longer shows a stale-session log line
after the fix. Re-ran the local two-instance harness through multiple rounds
of connect/kill/reconnect, including deliberately killing the controller the
instant its session started negotiating (before reaching `connected`) and
immediately reconnecting -- every round completed cleanly with no `IGNORED
stale ...` / `REJECTED` lines.

**Not done, and why:** the literal ask was to reproduce via a packaged
install. The packaged app would not reliably start in this sandboxed dev
environment (hung indefinitely on one launch with zero CPU activity and no
child processes spawned, silently exited immediately on another) -- consistent
with the GPU/display-virtualization limitations this same environment showed
throughout the original investigation (persistent `DXGI` desktop-duplication
failures). Since none of the code under investigation (input-helper session
lifecycle) differs between a dev build and a packaged one -- only native
binary loading and asar packaging do, neither of which this bug touches -- the
local dev-mode harness was used instead, and is what the evidence above comes
from. This should be re-verified against a real packaged install (ideally on
the machine that originally reported it) before considering this fully closed.
