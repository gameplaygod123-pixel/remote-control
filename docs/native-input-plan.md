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

## 11. Addendum: real 8-round log from v1.14.1 -- the stale-event fix wasn't it

Branch `fix/input-pc-retry`. The stale-event guard shipped in §10 did NOT fix
the flapping: a real packaged v1.14.1 install still alternated 4 good / 4 bad
across 8 real sessions against the Mac controller. The saved
`%TEMP%\input-helper.log` from that run gave a much more specific signature
than anything reproducible locally:

- Every bad session (2, 3, 6, 7 of 8) received the controller's answer and
  **all 3** of its remote ICE candidates -- identical to every good session.
- Every bad session sent only **2 of its own 4** outgoing ICE candidates: the
  two `host` candidates (fired instantly, always identical across every
  session -- just enumerating the same local interfaces) but **never** the
  two `srflx` (STUN server-reflexive) candidates that every good session sent
  50-250ms after its offer.
- Bad sessions then sat in `connectionState=connecting` for 10-13 seconds
  (well past any real STUN round-trip) until the next "back" killed them --
  not a slow candidate, a candidate that never gets gathered at all.
- Zero `IGNORED stale ...` or `REJECTED` lines anywhere in the log, and the
  host log showed no `PONG TIMEOUT`/kill/respawn -- so the §10 fix's own
  guard never even had anything to catch, and the helper process itself
  never went down. This rules out both the exact mechanism §10 fixed and the
  ping/pong liveness check as causes of *this* symptom (the stale-event fix
  is still correct and worth keeping -- it's just apparently not what's
  making these particular sessions fail).

This points at the helper's own STUN candidate-gathering pipeline stalling
for a subset of `RTCPeerConnection` instances specifically -- most likely
some form of state (a socket, a STUN transaction, or an internal client
object) that node-datachannel doesn't fully release between one
`RTCPeerConnection` and the next within the same process, matching the
"port/candidate reuse" theory floated when the log was first reviewed.

### Two tracks landed in this branch

**Track 1 -- diagnostics, to actually pin down *why* (not yet confirmed; needs
a real-hardware run with this build):**
- `initLogger` (from `node-datachannel`, not the polyfill) is now wired to
  the same file log, so libdatachannel/libjuice's own debug output shows up
  next to everything else. Defaults to `'Debug'`; override with
  `NDC_LOG_LEVEL` if that's too noisy to read by hand.
- `onicegatheringstatechange` is now logged per pc (with the same
  stale-guard as every other handler) -- shows whether a bad session's
  gathering state ever reaches `'complete'` (meaning it gave up gathering
  srflx and thinks it's done) or stays stuck at `'gathering'` forever.
- Every outgoing ICE candidate's `typ host|srflx|relay` is now extracted and
  logged directly (`candidateType()`), instead of requiring a human to
  decode a truncated candidate string by eye -- this is what made the
  host/srflx split in this addendum's analysis fast to confirm, and will
  make it immediately obvious whether a **relay** (TURN) candidate ever
  shows up in *any* session, good or bad -- if it never does, the TURN
  entries (particularly the one whose URL has a `?transport=tcp` suffix
  baked into the `user:pass@host:port` string the polyfill constructs --
  unconfirmed whether libdatachannel's URI parser accepts that combination)
  have likely been silently broken all along.
- `NDC_ICE_SERVERS=stun-only` (env var) drops every ICE server except the
  plain Google STUN entry, to A/B whether the openrelay STUN/TURN entries
  are implicated at all.
- None of the above reproduces the actual stall locally (same as every
  prior investigation round) -- confirming/denying the leading theory needs
  the log from an actual bad session on real hardware.

**Track 2 -- self-healing retry (shipped regardless of what Track 1 finds):**
- `input-helper/index.ts`: `attemptNegotiation()` now sets a 5s
  (`CONNECT_TIMEOUT_MS`) timer after sending each offer. If the pc hasn't
  reached `'connected'` by then, it logs the exact stall (state, gathering
  state, in/out candidate counts, attempt number), fully tears down (through
  the same `closeSession()` used everywhere else -- stale-event guard
  included), and starts a brand new `RTCPeerConnection` + offer -- up to
  `MAX_ATTEMPTS = 3` total per top-level `start-session` before giving up
  and sending `{evt:'fatal'}` up to the host (logged; doesn't crash the
  helper process, since this is an ordinary negotiation failure, not a
  process-level fault).
- `ControllerSession.tsx`: the `sdp-offer`/`channel:'input'` handler no
  longer assumes `inputPcRef.current` already exists and reuses it -- it now
  **always** closes whatever's there (if anything), builds a brand new
  input-only `RTCPeerConnection`, clears `inputChannelRef`/`moveChannelRef`
  immediately (so `sendInput()` can never send on a channel belonging to the
  pc just closed, in the gap before the new one's channels open), and only
  then answers. Every offer -- the first one for a session or a retry's
  replacement -- gets a genuinely clean pc; the proactive pc creation that
  used to happen in the `pair-result` handler was removed since it's now
  redundant (and would otherwise be one more pc instance to tear down before
  the first real offer arrives).
- Verified locally: temporarily forcing `CONNECT_TIMEOUT_MS` down to 100ms
  (via `NDC_TEST_SHORT_TIMEOUT=1`, a permanent but inert-by-default test
  knob) forced 3 real retries end to end -- each with a fresh
  `RTCPeerConnection`/offer/session number, correctly giving up and sending
  `fatal` after the third, and safely no-op'ing a late answer that arrived
  for an already-abandoned attempt (via the same `pc`/`currentSession`
  guards, not a crash). Re-ran at the real 5s timeout afterward to confirm
  no regression: a normal session still connects on attempt 1/3 with no
  unnecessary retries, and the new candidate-type logging shows the expected
  `host` (#1-2) then `srflx` (#3-4) pattern cleanly.
- Not yet verified: the actual acceptance criterion (8-10 real rounds against
  the Mac controller, every session getting input within ~6s). Needs a real
  build + a real test round, same environment limitation as every prior
  round in this investigation -- this sandboxed dev environment cannot
  reliably run a packaged Electron build at all (see §10's addendum).

## 12. Addendum: root cause found -- openrelay.metered.ca's STUN/TURN is dead

Branch `fix/input-pc-retry` (same branch as §11). A real 8-round v1.14.2
log (16 negotiation attempts across those rounds, retries included) with the
Track-1 diagnostics from §11 active gave a 100%, zero-exception correlation:
`IceTransport::IceTransport@109`'s own "Using STUN server X" line showed
which of the two configured STUN entries libjuice picked for that specific
attempt -- non-deterministically, even across retries within the same
top-level session, with no correlation to session/attempt number or process
age -- and:

- Every attempt that picked `stun.l.google.com:19302`: connected. 6/6.
- Every attempt that picked `openrelay.metered.ca:80`: sat in `connecting`
  with `iceGatheringState=in-progress` until it timed out. 8/8, no exceptions.
- `"TURN allocation failed"` is logged (even during a *good*, Google-STUN
  session, where it didn't matter). Zero `typ relay` candidates appear
  anywhere across the ~9500-line log. openrelay's TURN never once worked
  either.

This directly disproves the earlier "process holds some stale resource
across pcs" theory from §10/§11 -- the exact same never-restarted process
(one pid, no respawns, for the whole 8-round test) produced both outcomes,
purely depending on which STUN server got picked for that one attempt.

**Fix:** removed `openrelay.metered.ca` (STUN and both TURN entries) from
`ICE_SERVERS` in both `input-helper/index.ts` and
`shared/webrtc/peerConnection.ts`, leaving only
`stun:stun.l.google.com:19302`. The `NDC_ICE_SERVERS=stun-only` diagnostic
toggle from §11 is removed too -- the question it existed to answer is now
answered, permanently, not situationally.

Local regression check: a fresh negotiation now connects on attempt 1/3 with
`iceServers=1`, gathers all 4 expected candidates (2 host + 2 srflx) and
reaches `connected` in under a second, same as every previously-"good"
session.

**Known gap this reopens:** no working TURN relay exists anywhere in the app
now (it didn't functionally exist before either, since it was already dead --
this fix just makes that explicit and removes the dead weight from ICE
gathering time). A genuinely restrictive-NAT/CGNAT pair that needs a relay
to connect at all will still fail. If that turns out to matter in practice,
it needs a real, verified-working TURN service (ideally self-hosted coturn),
not another unverified free one.

Also applied per this round's separate ask: the drain loop's
`handleRemoteInput(next).catch(() => {})` in `input-helper/index.ts` no
longer swallows injection errors silently -- it now logs the message type
and full error/stack to the same file. See §13 for what testing this
surfaced.

## 13. Addendum: keyboard injection is silently broken in the helper (separate bug, confirmed locally)

Reported from real usage of a build with the §12 fix: in a helper-backed
session, the mouse works normally but **typing (Thai and English) and
keyboard shortcuts don't work at all** -- silently, no error, same data
channel the working mouse messages ride on.

**Reproduced locally, conclusively, without needing real hardware:**

- Isolated `@nut-tree-fork/nut-js` calls under `ELECTRON_RUN_AS_NODE=1`
  (`keyboard.pressKey`/`releaseKey` for A/B/C, `keyboard.type` for ASCII,
  single Thai characters, a full Thai string, and a Ctrl+C combo) **never
  throw** -- ruling out a load/init failure of the keyboard provider and
  ruling out anything Thai/Unicode-specific as the visible symptom.
- But promise-resolving isn't the same as the OS receiving the keystroke.
  Testing end to end -- focusing a real Notepad window, then injecting from
  a separate `ELECTRON_RUN_AS_NODE` process and reading Notepad's actual
  text back via `WM_GETTEXT` -- showed the truth: `keyboard.type("HELLO-
  FROM-HELPER-TEST")` produced exactly `"---"` in Notepad (only the 3
  hyphens landed; every letter silently vanished), and direct
  `pressKey(Key.A/B/C)` + `releaseKey` -- the path `keyToggle()` uses for
  both raw keydown/keyup *and* shortcuts -- produced **nothing at all**,
  0 characters. Both fully match the reported symptom and required no
  guessing: the injection call resolves successfully while doing nothing (or
  next to nothing) at the OS level.
- Mouse injection from the exact same process, same session, has been
  reliably confirmed working throughout this entire investigation (every
  earlier addendum's "connected" sessions had real mouse input flowing).
  Same native module (`@nut-tree-fork/libnut` → `libnut-win32`) backs both
  mouse and keyboard, so this isn't a "wrong/missing binary" problem --
  keyboard injection specifically behaves differently for this process.
- Two natural theories were tested and **both ruled out**:
  1. *"Needs a Win32 message loop"* -- a real Electron process (not
     `ELECTRON_RUN_AS_NODE`, `app.whenReady()` genuinely resolved, real
     message pump running) but with **no `BrowserWindow` ever created**
     still produced 0 characters for `pressKey`/`releaseKey`, identical to
     the headless case.
  2. *"Headless-Node-specific"* -- disproven by the same test: a real,
     non-headless Electron process without a window fails exactly the same
     way, so it isn't about `ELECTRON_RUN_AS_NODE` / lacking Node's own
     event loop integration with Windows messages.

  The common factor across both failing configurations is the same: **the
  process has never created (and doesn't own) any window at all.** Whatever
  libnut-win32's keyboard path needs -- most likely some window/thread
  association Windows requires for injected keyboard input specifically
  (mouse `SendInput` is coordinate-based and doesn't seem to need this;
  keyboard likely needs to reach a specific thread's input queue, which may
  require the calling thread/process to itself be window-owning) -- isn't
  present in the pure-Node helper, and isn't fixed by giving that process a
  full Electron runtime, only by giving it an actual window. No source is
  shipped for `libnut-win32` (prebuilt binary only), so the exact internal
  mechanism isn't directly inspectable from here.
- **Not yet tested:** whether creating an actual `BrowserWindow` inside the
  helper process (even permanently hidden, `show: false`, never shown) fixes
  keyboard injection. This is the obvious next experiment, but it plausibly
  reopens the *original* problem this whole architecture exists to solve --
  §5-6's investigation already found that a window which starts hidden and
  is never shown gets the exact same throttling treatment as one that's
  shown and then hidden (that's why `ready-to-show`'s `--hidden` path has to
  stealth-*show* rather than just never show). A hidden window inside the
  helper process would be a separate throttling domain from the agent main
  process's own window, so it's a genuinely open question whether it would
  suffer the same fate or not -- not yet tested either way.

**Fix candidates, not yet implemented (this needs a decision, not just a
diagnosis -- see options below):**

1. **Give the helper a real (permanently hidden) `BrowserWindow`.** Only
   fixes this if such a window doesn't itself get throttled while hidden --
   unverified per above. If it does get throttled, this reopens exactly the
   bug the helper exists to fix, just scoped to the helper's own window
   instead of the agent's.
2. **Route keyboard specifically through the agent's main process instead of
   the helper**, keeping mouse in the helper (confirmed working there).
   The main-process injection path is the pre-existing, already-proven
   renderer-fallback code (`ipcMain.handle('input:key', ...)` etc.) -- this
   is guaranteed to work for keyboard, at the cost of reintroducing the
   *original* window-hidden freeze, but **only for keyboard**, not mouse.
   Net effect vs. the current (helper-everything) state: mouse stays fixed
   in all cases; keyboard goes from "always silently broken in helper mode"
   to "works whenever the window is visible, dies when hidden" -- worse than
   the goal, better than today's helper-mode reality.
3. **Find or build a different Windows keyboard-injection path** that
   doesn't share whatever requirement `libnut-win32` has (e.g. calling
   `SendInput` directly from a small native addon/FFI without going through
   nut.js, if the raw Win32 call turns out not to need a window either --
   not yet tested, would need its own isolated repro before trusting it).

No fix implemented in this round for #13 -- reported for a decision on which
candidate (or combination) to pursue, per this round's own instruction to
investigate before changing code.

## 14. Addendum: keyboard fixed -- candidate C (koffi + raw SendInput), the Notepad oracle was the bug

Branch `fix/ice-servers-and-keyboard`. §13 concluded raw `SendInput` also
failed and the "must own a window" theory held even for the direct Win32
API, not just libnut. That conclusion was wrong, and the *test* was the
reason why, not the injection: Notepad's `WM_GETTEXT`/`GetWindowTextLength`
on this system reported the document as "modified" (`*` in the title bar --
real proof *something* was delivered) while its edit control's own text
length stayed 0. A broken read, not a broken write.

Rebuilt with a trustworthy oracle instead of trusting an external app: added
a real accumulating `<input>` plus a running keydown log (key/code/shiftKey/
ctrlKey/altKey) to `CaptureTestView.tsx` (the existing `INPUT_TEST=1` dev
harness), and drove it from the same kind of windowless
`ELECTRON_RUN_AS_NODE` process the real helper runs as. Full matrix result:

| method | input | landed in the real oracle? |
|---|---|---|
| libnut `keyboard.type()` | `"abc-123"`, `"ABC"` | no -- 0 characters, 0 keydown events |
| libnut `pressKey`/`releaseKey` | `A` alone, Shift+`B` | no -- same as above |
| raw `SendInput` `KEYEVENTF_UNICODE` | `"xyz-789XYZ"`, Thai `"สวัสดี"` | **yes -- 100%, exact, both cases, no shift handling needed** |
| raw `SendInput` VK-based | `C` alone, Shift+`D` | delivered, but character translated through the active (non-US) keyboard layout (`"u"`/`"g"` instead of `"c"`/`"D"`) |

So: libnut is confirmed broken in this windowless context (matches the
original bug report exactly, now with a reliable oracle instead of a
possibly-broken one), raw `SendInput` with `KEYEVENTF_UNICODE` works
perfectly and is layout-independent (exactly what's needed for the `'text'`
message path), and VK-based `SendInput` works too but is layout-sensitive
for letter keys -- irrelevant here since letters/symbols only ever go
through the Unicode path; VK-based injection is reserved for modifiers/
navigation/function keys (`Ctrl`, `Alt`, `Shift`, arrows, `F1`-`F24`, Enter,
Backspace, Home/End/PageUp/PageDown/Insert/Delete), which are layout-
invariant in Windows and where an app's shortcut recognition keys off the
VK code, not the character.

One real edge case found and deliberately avoided rather than fixed: mixing
a genuinely-held modifier key (real `VK_SHIFT` down) with `KEYEVENTF_UNICODE`
events at the same time produces inconsistent modifier-flag reporting and
occasionally-altered characters. Not a problem in practice -- the
implementation below never combines the two: `'text'` messages are pure
Unicode injection, `'keydown'`/`'keyup'` messages are pure VK injection,
matching the protocol's own existing separation between those message
types.

**Implementation** (`koffi` chosen for the FFI layer -- N-API-based prebuilds
ship for every platform inside the npm package itself, so there's no
binary-swap step needed when cross-building from a Mac, unlike a
native/node-gyp addon):

- `src/main/input/keyMapWin32.ts` -- `CODE_TO_VK`, mirroring `keyMap.ts`'s
  `CODE_TO_KEY` one-for-one (same codes, same Cmd->Ctrl rationale for
  `MetaLeft`/`MetaRight`), mapping each `KeyboardEvent.code` to a raw VK
  constant plus whether `KEYEVENTF_EXTENDEDKEY` is required (arrows, Insert/
  Delete/Home/End/PageUp/PageDown, right-hand Ctrl/Alt, NumLock, Print
  Screen, numpad Enter/Divide).
- `src/main/input/injectorWin32.ts` -- `typeTextWin32(text)` sends one
  `KEYEVENTF_UNICODE` down+up pair per **UTF-16 code unit** (not per Unicode
  code point -- a supplementary-plane character like an emoji needs its
  surrogate pair delivered as two separate events, same as real Windows text
  input; Thai and everything else this app targets is single-code-unit
  BMP, but iterating by code unit keeps that case from silently mangling
  instead of only working for the common case). `keyToggleWin32(code, down)`
  looks up `CODE_TO_VK`, silently ignores unmapped codes (matching the
  existing `keyToggle()` behavior), and sends one `SendInput` call with the
  right VK + `KEYEVENTF_KEYUP`/`KEYEVENTF_EXTENDEDKEY` flags.
- `injector.ts` branches on `process.platform === 'win32'`: `typeText`/
  `keyToggle` go through the new Win32 module there, and fall back to the
  original nut.js path on any other platform (this app's dev/test harness
  is the only thing that ever runs non-Windows). Mouse
  (`moveMouse`/`clickMouse`/`mouseButtonToggle`/`scrollMouse`) is completely
  untouched -- it was never broken, stays on nut.js everywhere.

Re-verified end to end against the real (bundled, wired-up) `injector.ts`,
not just the raw spike: ASCII + Thai `typeText` landed correctly; a real
`Ctrl`+`C`-shaped `keyToggle` sequence correctly reported `ctrl=true`; a
held-`Shift`-then-three-letters `keyToggle` sequence correctly reported
`shift=true` consistently across all three letters (unlike the earlier
ad hoc test that mixed VK and Unicode injection); an Alt+Tab-shaped sequence
sent without error.

Temporary diagnostic added to the real helper (`input-helper/index.ts`):
every `'keydown'`/`'keyup'`/`'text'` message now logs the code/character(s)
to `%TEMP%\input-helper.log` before injecting, so a real session from the
Mac controller can be checked against that log for ground truth on real
hardware -- this sandboxed dev environment's own non-US keyboard layout and
general virtualization quirks mean its results, while now backed by a
trustworthy oracle, still aren't a substitute for a real round. Remove this
logging once real-hardware rounds confirm the Win32 path is solid.

## 15. Addendum: STUN second server + two-layer resilience safety net

Same branch. Two smaller, previously-proposed/approved items landed
alongside the keyboard fix:

- **Second STUN server**: a single STUN server is itself a single point of
  failure -- exactly what just went wrong with openrelay in §12. Added
  `stun:stun.cloudflare.com:3478` as a second entry in both `ICE_SERVERS`
  lists (`input-helper/index.ts` and `peerConnection.ts`), but only after
  sending it a real RFC 5389 Binding Request from this machine and getting a
  valid Binding Success Response back (6/6 across 3 separate runs) -- the
  same verification openrelay never got before it was originally added.
- **Safety net A** (helper): after `MAX_ATTEMPTS` (3) failed negotiation
  attempts, the helper now calls `process.exit(1)` (after a `setImmediate`
  tick to let the `'fatal'` IPC message flush) instead of sending `'fatal'`
  and just sitting alive. `inputHelperHost.ts` already had an unconditional
  respawn-on-exit handler (`RESPAWN_DELAY_MS` later) from the original
  self-healing-retry work, so this gets a genuinely fresh process -- new
  native module state, everything -- for the next pairing attempt, instead
  of an uncertain same-process retry after 3 attempts already failed
  identically.
- **Safety net B** (agent renderer): `AgentView.tsx`'s `onDown` handler
  previously only cleared `useHelperRef` and updated the status text,
  leaving an in-flight helper-backed session's video connection alive and
  looking "connected" while input was silently, permanently dead until a
  human noticed and manually reconnected. Added a `pcRef` (mirroring the
  existing `activePc` state for the same reason `clientRef`/`deviceIdRef`
  already exist -- `onDown` is registered in a separate, mount-once effect
  that can't read other effects' local variables or go stale-free off
  state) so `onDown` can now close the video pc outright when the crash
  happens during a session that was actually using the helper path. That
  turns a silent, zombie "video works, input doesn't" state into a real,
  visible disconnect the controller can see and retry against.

## 16. Addendum: clipboard-in-helper's Win32 segfault -- koffi `str16` stored a pointer, not the text

Branch `fix/clipboard-in-helper`. Moving clipboard sync into the helper
(so it survives the agent window hiding, same as input) shipped as v1.15.0
and was reverted the same day as v1.15.1 because the helper segfaulted in a
loop ("input helper crashed" flapping). Recovered here after finding and
fixing the actual crash.

**Reproduced first, deterministically:** an isolated harness running the real
`clipboardNative.ts` (Win32 koffi path) under `ELECTRON_RUN_AS_NODE`, doing
ASCII/Thai/CJK/empty read+write roundtrips in a loop, segfaults (exit 139)
reliably -- but non-deterministically in *timing* (crashed at iter 4, 59, 89
across runs), always on the empty-string cycle. A per-FFI-call stderr trace
pinned the crash to `koffi.decode(ptr, 'str16')` on the read *after* an
empty-string write.

**Root cause:** koffi's `str16` type is `const char16_t *` -- a POINTER to a
string, not the characters themselves. So `koffi.encode(ptr, 'str16', text)`
did NOT write the UTF-16 text into the clipboard's `GlobalAlloc`'d memory;
it allocated a *transient koffi-managed* UTF-16 buffer and wrote an 8-byte
POINTER to it into the clipboard memory (confirmed by hexdumping the encode
output: `90dbf1d3cb010000` = a little-endian heap address, not text bytes).
`koffi.decode(ptr, 'str16')` was symmetric -- it read that pointer back and
dereferenced it -- which is the only reason the in-process roundtrip ever
"passed": the test was reading koffi's own internal buffer, never the OS
clipboard. Two independent failures fell out of that:
  1. **Segfault:** the koffi-managed buffer is garbage-collected, so the
     pointer sitting in the clipboard went stale; a later `decode` chased a
     freed/unmapped address. The empty-string cycle (a tiny 2-byte alloc)
     just made the dangling-pointer read land on unmapped memory most often,
     hence "always empty, but not every time."
  2. **The feature never actually worked:** the clipboard held an 8-byte
     pointer where other apps expect UTF-16 text, so no real cross-app copy/
     paste (the entire point) could have synced -- it only looked fine in the
     self-referential roundtrip test.

**Fix:** read/write the UTF-16 code units INLINE via `koffi.array('uint16',
n)` instead of `str16`, so the actual bytes land in (and come out of) the
global memory. The read is bounded by `GlobalSize(handle)` so a buffer some
other app left un-terminated can't run the null-scan off the end, and it's
built in chunks so a very large paste can't blow the stack via
`String.fromCharCode(...spread)`. `OpenClipboard` is now passed an explicit
`null` rather than the integer `0`.

**Verified (real hardware, this machine):** 5x100 roundtrips including the
empty string -- 0 crashes, all exact; helper writes text that a *separate*
process (PowerShell `Get-Clipboard`) reads back exactly, and reads back
exactly what PowerShell `Set-Clipboard` puts there -- Thai + CJK + arrows in
both directions, proving real cross-app sync (which the reverted version
could not have done); 251 reads/sec against a clipboard being mutated by an
external process without a crash; and the real `runClipboardSync` +
`clipboardNative` integration (mock channel, real OS clipboard) syncing both
directions over a sustained session with no crash. Not yet verified: a full
two-machine paired session against the real Mac controller -- same sandbox
limitation as every prior round. Per the post-1.15.0 rule, native/FFI code
the Mac side can't test ships PRERELEASE only, not a direct full release.
