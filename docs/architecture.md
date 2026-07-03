# Remote Desktop Control App — Project Context

Personal remote-desktop tool: view screen + control mouse/keyboard on a
Windows PC from a Mac, over the internet (not same LAN). Similar in spirit to
AnyDesk/TeamViewer, single-codebase Electron app that runs as either an
**agent** (Windows target, `APP_MODE=agent`) or a **controller** (Mac,
default mode).

Full original plan (architecture rationale, all phases, risks) was written
during planning and is not itself committed here — this doc is the
durable summary for anyone (or any Claude session) picking this up on a
different machine.

## Architecture

- **Video**: Electron `desktopCapturer` → `getUserMedia`/`getDisplayMedia` →
  WebRTC `RTCPeerConnection` video track. Chromium's built-in WebRTC stack
  handles encoding.
- **Input**: `@nut-tree-fork/nut-js` for mouse/keyboard injection (agent
  side). Capture on the controller side is plain DOM mouse/keyboard events
  in the renderer (no OS-level hook needed).
- **Signaling**: `server/signaling` — Node + `ws` WebSocket server. Handles
  agent registration (pre-shared token) + Device ID/PIN pairing, then
  relays SDP offer/answer + ICE candidates between paired peers. Never
  touches video/input data once the WebRTC connection is up.
- **Connectivity**: currently STUN only (Google public STUN). TURN relay
  (free tier, Open Relay Project) and a public tunnel for the signaling
  server (Cloudflare Tunnel) are the Phase 4 work — needed for real
  cross-network (not just same-LAN) connections.
- **Pairing**: agent generates a persistent Device ID (stored in
  localStorage) and a PIN that rotates every app restart. Controller enters
  both to pair. PIN is hashed server-side (bcryptjs), never stored/sent in
  plaintext at rest.

Important correction from the original plan: `RTCPeerConnection` only
exists in the Chromium renderer context, not Electron's Node-based main
process — so WebRTC/signaling-client code lives under
`apps/desktop/src/renderer/src/shared/`, not `main/`.

## Project structure

```
apps/desktop/              Electron + Vite + React + TS app (agent + controller modes)
  src/main/                main process: window creation, screen capture permission
                            wiring, nut.js input injection + IPC handlers
  src/preload/              contextBridge API exposed to renderer
  src/renderer/src/
    agent/AgentView.tsx     real agent UI: registers, shows Device ID + PIN, shares screen
    controller/ControllerView.tsx   top-level nav: device list <-> session
    controller/DeviceListView.tsx   "Computers" list -- online/offline status, per-device PIN cache
    controller/ControllerSession.tsx  one active connection: pairing, video, fullscreen-on-connect
    loopback/               Phase 1 dev harness (same-process source/viewer video test)
    dev-test/               Phase 2 dev harness (injector-test / capture-test)
    shared/webrtc/peerConnection.ts     shared RTCPeerConnection setup
    shared/signaling/signalingClient.ts  WebSocket signaling transport
    shared/config.ts        SIGNALING_URL / AGENT_TOKEN (dev defaults, override via VITE_ env vars)
server/signaling/           Node + ws signaling/pairing server
packages/protocol/          shared Zod message schema (desktop app <-> signaling server)
```

## Status (phases from the original plan)

- **Phase 0** (scaffold): done.
- **Phase 1** (local screen capture + WebRTC video loopback): done, verified visually on Mac.
- **Phase 2** (input capture + nut.js injection): done, verified on Mac —
  real cursor moves, clicks, and typing into a real text field all confirmed
  via screenshot.
- **Phase 3** (real signaling server + Device ID/PIN pairing): done, verified
  end-to-end with two separate app processes (agent + controller) on the
  same Mac connecting through `server/signaling` on `localhost:8080`.
- **Phase 4** (cross-network connectivity, free-tier TURN + tunnel): **done,
  fully verified across two real separate machines.** Added free TURN (Open
  Relay Project) to the ICE server list in `peerConnection.ts`. Deployed
  `server/signaling` behind a public Cloudflare quick tunnel
  (`cloudflared tunnel --url http://localhost:8080`) running on the Mac, and
  confirmed a real Windows machine (agent) paired with the Mac (controller)
  over the internet — live desktop video from Windows rendered in the Mac's
  controller window. This is the actual target usage scenario from the
  original plan (two personal machines, different networks).
  - The Cloudflare quick tunnel URL is **temporary** — it changes every time
    `cloudflared` is restarted, and free quick tunnels aren't meant for
    long-term/production use (no uptime guarantee). Fine for testing; a
    named tunnel or small VPS is the eventual upgrade per the original plan.
  - Added an **auto-connect** convenience for personal use: set `VITE_PIN`
    to the same fixed value on both agent and controller (instead of the
    default rotating one-time PIN), and `VITE_DEVICE_ID` on the controller
    matching the agent's ID — the controller then pairs automatically on
    launch with no manual form/click needed. See `shared/config.ts`
    (`FIXED_PIN`, `AUTO_CONNECT_DEVICE_ID`). Manual entry still works if
    those env vars aren't set.
- **Phase 5** (input over data channel, full remote-control loop): **implemented,
  not yet live-verified end-to-end.** See the dedicated section below for what
  was built, how it was checked, and what's still open.
- **Phase 6** (packaging), **Phase 7** (security hardening): not started.

## Known issues found and fixed along the way

- **Node v26 (via Homebrew) broke Electron's install** on macOS —
  `extract-zip` silently extracted only 1 of 585 files with no error,
  leaving `node_modules/electron/dist` empty. Switched to Node 22 LTS
  (works correctly). If you hit "Electron uninstall" / missing binary
  errors on a fresh `pnpm install`, check the Node major version first.
  Windows may not have this exact issue, but stick to an LTS (even-numbered)
  Node version to be safe.
- **CSP blocked WebSocket signaling**: `apps/desktop/src/renderer/index.html`'s
  Content-Security-Policy had no `connect-src`, so it fell back to
  `default-src 'self'` and silently blocked `new WebSocket(...)` to the
  signaling server. Fixed by adding `connect-src 'self' ws: wss:`.
- **nut.js `mouse.getPosition()` is unreliable** on macOS — returns a
  stale/wrong value even though `mouse.setPosition()` itself works
  correctly (confirmed via screenshot with cursor visible). Don't trust
  `getPosition()` for verification; the real injection path never needs it
  anyway. Worth re-checking whether this also affects Windows.
- **Signaling WebSocket silently died after ~1-2 minutes idle** when routed
  through the Cloudflare quick tunnel — the tunnel (or some proxy in the
  path) drops idle connections, which wiped the agent's registration on the
  server without the agent's UI ever noticing (no reconnect/close handling
  existed). Fixed with an application-level heartbeat: the client sends a
  `{type: "ping"}` every 25s (`HEARTBEAT_INTERVAL_MS` in
  `signalingClient.ts`), server replies `pong`. Confirmed via a 200s soak
  test with no disconnect. If pairing ever again fails with "unknown device
  id" right after a period of inactivity, suspect this class of bug first.
- **Auto-reconnect added** for real network drops (not just idle timeouts):
  `signalingClient.ts` now retries with exponential backoff (1s up to a
  30s cap) on disconnect, and exposes `onReconnect`/`onDisconnect` hooks so
  `AgentView`/`ControllerView` can redo registration/pairing, since the
  server forgets all state when a connection drops. Two real bugs surfaced
  while building and testing this:
  - **React StrictMode (dev mode) double-invokes effects**, and the old
    cleanup only closed the RTCPeerConnection, not the signaling
    `SignalingClient` itself -- leaving an orphaned, never-registered
    WebSocket connection alive that could win a race and "steal" a
    registration slot from the real one after a reconnect. Fixed by
    tracking the client in the effect's closure and calling `client.close()`
    both in cleanup and in the cancelled-check path right after connecting.
  - **Reconnect race**: after a real drop, the agent and controller
    reconnect independently with no ordering guarantee -- the controller's
    re-sent `pair-request` can arrive before the agent finishes
    re-registering, permanently failing with "unknown device id" since
    there was no retry. Fixed by retrying the pair-request every 2s (up to
    15 attempts) specifically on that failure reason (not on a wrong PIN --
    that's a real error, not a timing race).
  - Verified by killing and restarting an isolated test signaling server
    mid-session and confirming both sides recover to a fully connected
    video call with no manual intervention.
  - **Asymmetric-drop gap found on the real Mac<->Windows link**: if only
    the *agent's* signaling connection drops and reconnects while the
    controller's own connection stays up the whole time, the controller
    never notices (its own `onReconnect` only fires when *its* connection
    drops) -- but the agent re-registering wipes the old pairing
    server-side, so the video link dies and the controller's
    `RTCPeerConnection` state goes to `failed` forever. Fixed by having the
    controller re-send `pair-request` whenever its peer connection state
    becomes `failed`, reusing the same retry-on-"unknown device id" path.
    Also added defensive `pc?.close()` before creating a replacement peer
    connection on both sides, since re-pairing can now happen more than
    once. Verified live against the real Windows agent (not just the local
    isolated test): killed the agent's connection, watched the controller
    self-heal back to `connection: connected` with a live video feed.

- **Multi-device support (post-Phase-4, ahead of schedule)**: added a
  Parsec/AnyDesk-style "Computers" list as the controller's default screen
  (`DeviceListView.tsx`), since the user plans to add more agent machines
  soon. Deliberately **no live thumbnails** (user's choice) -- just an
  online/offline status dot per device, updated in real time via a new
  `device-status-changed` broadcast from the server.
  - Server (`pairing.ts`) no longer deletes an agent's record when it
    disconnects -- it marks `online: false` and keeps the record, so the
    device still shows up (grayed out) in the list. This is a real
    behavior change from Phase 3/4: the device roster is now sticky for
    the life of the signaling server process (still wiped on server
    restart -- still in-memory only).
  - New protocol messages: `list-devices` (controller asks), `device-list`
    (full roster reply), `device-status-changed` (live push to any
    controller that has asked at least once -- tracked via a
    `subscribedControllers` Set in `pairing.ts`).
  - Controller UX: click a device -> if no PIN cached for it yet
    (`shared/devicePins.ts`, localStorage), prompt inline; on success the
    PIN is remembered for next time. Connecting fullscreens the window
    (`window.api.window.setFullScreen`, new IPC handler in `main/index.ts`);
    Escape or the Back button exits fullscreen and returns to the list.
  - The old single-device `VITE_DEVICE_ID`/`VITE_PIN` auto-connect env vars
    (used by `start-controller.command`) still work and bypass the list
    entirely -- `ControllerView.tsx` checks for them before rendering
    `DeviceListView`.
  - Verified locally end-to-end: device appears online with a green dot,
    Connect -> PIN prompt -> pair -> fullscreen -> live video; Escape
    returns to the list windowed; killing the agent flips the dot to gray
    in real time with no page refresh.

## Phase 5: remote input over a WebRTC data channel

Real mouse/keyboard control, not just video. Alongside the existing video
`RTCPeerConnection`, the agent opens an `RTCDataChannel` named `"input"`
(created before `createOffer()` so it's negotiated in the initial SDP --
data channels are bidirectional once open regardless of which side created
them, so the controller just picks it up via `pc.ondatachannel`).

- **Coordinates are fractions (0..1) of the video content, not pixels.**
  The controller only knows the decoded video's resolution, which may not
  exactly match the agent's real screen (window resize, different scale
  factors). `shared/input/inputProtocol.ts`'s `videoRelativePosition()`
  accounts for `object-fit: contain` letterboxing when mapping a raw click
  back to a 0..1 fraction, returning `null` for clicks that landed on a
  letterbox bar. The agent then multiplies by its own `screen.width()` /
  `screen.height()` (nut.js, hardware pixels -- matches what
  `mouse.setPosition()` expects) to get an absolute coordinate.
- **Mouse buttons use press/release (`mouse.pressButton`/`releaseButton`),
  not `click()`** -- lets the controller hold a button across separate
  mousemove events, which `click()` can't express. Needed for drag-to-select
  and drag-and-drop, not just instantaneous clicks.
- **Keyboard is a hybrid of two paths** (`isPrintableKey()` in
  `inputProtocol.ts` decides which):
  - **Printable characters** (`KeyboardEvent.key.length === 1`, no
    Ctrl/Alt/Meta held) are sent as `{ t: 'text', text: e.key }` and typed
    on the agent via nut.js's `keyboard.type()` (native `libnut.typeString`,
    Unicode-aware -- Windows injects via `SendInput`+`KEYEVENTF_UNICODE`
    under the hood). This is what makes **non-Latin text (Thai, etc.) work
    at all**: `main/input/keyMap.ts`'s physical-`code`→nut.js-`Key` map can
    only express a fixed, US-layout-shaped key set (confirmed by reading
    libnut's own key lookup table -- there is no way to represent a Thai
    character as a "physical key" in that model). `e.key` instead reflects
    whatever input layout/IME is active on the controller, so this works
    for any language the person can type on their own keyboard.
  - **Everything else** (modifiers, arrows, function keys, and any
    Ctrl/Alt/Meta combo) still goes through physical-key press/release by
    `KeyboardEvent.code`, so real shortcuts (Ctrl+C, Alt+Tab, Shift+Arrow
    selection) hold real modifier state on the agent's OS -- something a
    single `type()` call can't express.
  - `nut.js`'s `keyboard.config.autoDelayMs` defaults to **300ms per
    character**, meant for typing a whole string in one `type()` call. Since
    remote text now calls `type()` once per real keystroke, that 300ms would
    otherwise land on every character on top of network latency -- set to 0
    in `injector.ts` (the remote keystrokes are already paced by how fast
    the person is actually typing).
- Mousemove is throttled client-side (`MOUSE_MOVE_THROTTLE_MS` in
  `ControllerSession.tsx`) since it fires far more often than needed.
- The channel reference is cleared (`inputChannelRef.current = null`)
  everywhere the peer connection is torn down/replaced (reconnect,
  re-pairing on `failed`, unmount) so a stale channel is never written to.
- The active session uses its own edge-to-edge `.session-shell` layout, not
  the centered/max-width `.app-shell` card used by the setup screens --
  first shipped version accidentally reused `.app-shell`, so even after
  going fullscreen the video sat tiny in a 720px-wide box in the middle of
  the screen. Real bug, caught by the user on the first live test, not by
  local testing (see below).
- Screen-share capture requests `frameRate: { ideal: 30, max: 30 }` and sets
  `track.contentHint = 'motion'`, and the video sender's `maxBitrate` is
  raised to 4 Mbps via `RTCRtpSender.setParameters()` -- Chromium's default
  screen-capture/WebRTC settings are conservative enough to read as lag on
  their own, separate from real network latency.

**Verification status:** live-tested end-to-end against the real Windows
agent (not just locally) after the fixes above. Mouse move/click/drag and
the fullscreen layout confirmed working by the user on the first pass.
Typing was broken on that same first pass -- see the bug below -- fixed
before it was tested again; re-confirmation from the user on typing
(especially Thai) is the open item.

**Real bug found via the user's live test (not caught by local
review/typecheck):** the original implementation sent every key as a
physical `KeyboardEvent.code`, which can only reach nut.js's fixed,
US-layout-shaped `Key` enum. Typing failed because there's no physical-key
representation of Thai text (or, for Latin text on a non-US agent layout,
this approach would silently produce the wrong character rather than
failing loudly). Fixed by adding the printable-character `text` path
described above. Lesson: typecheck and reading the native library's own
key table gives confidence the code the compiler sees is correct, but
whether a given library call produces the *intended real-world effect*
(a Thai character actually appearing) still needs an actual test on the
target machine -- there was no way to catch this without either testing
against real Windows agent, or independently reasoning through what
`KeyboardEvent.code` can and can't represent (which is what turned up the
bug once the user reported the symptom).

Local same-Mac testing (agent+controller on one machine, or the
injector-test dev harness with real OS-level clicks/keystrokes) was
attempted earlier and abandoned because it's inherently self-referential
and risky: the agent screen-shares the *same physical screen* the
controller is also displayed on, so a real click routed through the
pipeline can land back on whatever's actually on that screen, and multiple
same-named `Electron` processes running at once (production controller + a
local test instance) made AppleScript UI automation dangerously ambiguous.

**Real incident from this session:** an AppleScript command scoped by
process *name* (`tell process "Electron"`) rather than PID, intended to
dismiss a menu in a local test window, instead sent an Escape keystroke to
the real production controller (there were two processes both named
"Electron" running simultaneously) and disconnected it from the real
Windows agent. No stray input reached the Windows agent itself -- Escape
only affects the controller's own local UI -- but it did unexpectedly drop
the live session. Recovered by killing and relaunching
`start-controller.command`. **Lesson for future automation on this
project: when more than one instance of the app might be running (very
likely, given production + any local test), always scope AppleScript/System
Events targeting by PID (`first process whose unix id is N`), never by
process name.** Given this, and that the Windows agent is a genuinely
separate machine (no self-mirroring risk, and no ambiguous-process-name
problem since only one agent instance runs there), the recommended way to
finish verifying Phase 5 is a real test against the actual Windows agent
rather than more same-machine Mac-only testing.

## Device names

Agents can set a human-friendly name (typed on the Agent's own screen,
persisted in its `localStorage`) that the controller's device list shows
instead of the raw numeric device ID. Renaming sends a dedicated
`set-device-name` message rather than re-sending `register-agent` --
re-registering resets the whole server-side `AgentRecord` (including
`controllerWs`), which would disconnect an active session just to change a
label. `pairing.ts`'s `setDeviceName()` mutates only the `name` field.
`index.ts`'s `broadcastDeviceUpdate(deviceId)` re-reads the full current
record (online + name) rather than taking them as params, so registration,
disconnect, and rename all broadcast from one place instead of each call
site needing to know the complete current state itself.

Note the PIN-remembering behavior the device list already had before this
(`shared/devicePins.ts`, cached in the controller's `localStorage` on first
successful connect via `DeviceListView`'s `submitPin()`, cleared only on an
"incorrect pin" pairing failure) -- reconnecting to an already-paired
device from the list should already skip the PIN prompt with no code
change needed here. Flagged as worth re-confirming live, since it hadn't
actually been exercised yet at the time of writing (real usage so far went
through the single-device `VITE_DEVICE_ID`/`VITE_PIN` auto-connect launcher
scripts, which bypass the device list entirely).

**Confirmed working live** (2026-07-04): both device naming and PIN
remembering tested by the user against the real Windows agent -- name
shows correctly in the Mac's device list, reconnecting to an already-paired
device no longer prompts for the PIN.

## Device list thumbnails

Originally deliberately skipped ("simple online/offline status dots... to
save bandwidth" -- see the multi-device-list entry above) but added after
the user asked for it once the list was actually in use. Each online agent
captures a low-res (320x200, JPEG quality 70) screenshot via Electron's
`desktopCapturer.getSources()` every `THUMBNAIL_INTERVAL_MS` (4s,
`AgentView.tsx`) and pushes it through the signaling server
(`device-thumbnail` message) to any controller currently browsing the
device list.

- This is deliberately **not** the real video track -- `desktopCapturer`'s
  own thumbnail is cheap (no separate capture/encode pipeline) and the real
  `getDisplayMedia`/WebRTC path only exists once a controller has actually
  paired and opened a session, which the device list is explicitly *not*
  doing yet.
- Paused while a call is actively connected
  (`pc?.connectionState === 'connected'` in `AgentView.tsx`) -- the
  controller already has full live video at that point, so capturing and
  sending a redundant low-res thumbnail nobody's looking at would just
  waste the agent's upload bandwidth during the one time it matters most.
- The server stores each agent's latest thumbnail (`AgentRecord.thumbnail`
  in `pairing.ts`) and includes it in the initial `device-list` response,
  so a controller that just opened the list sees a preview immediately
  instead of waiting up to 4s for the next tick.
- Sanity-checked server-side that the sender's `ws` actually matches the
  registered agent for that `deviceId` before accepting a thumbnail update
  -- cheap guard against a mismatched/rogue client, same spirit as the rest
  of the pairing logic even though this is a personal-use app.

## Device list visual redesign

The user provided a mockup (dark-brown/orange, monospace, full-window
layout with a device count header and an online/offline + last-updated
footer bar) and asked for the device list to match it, with the grid
reflowing nicely as the controller window is resized. Implemented as a
self-contained theme (`assets/deviceList.css`, `.dl-*` classes) scoped to
just `DeviceListView.tsx` -- the rest of the app (Agent, active session)
keeps the original blue/purple theme; only this one screen was reskinned.

- `.dl-shell` uses `position: fixed; inset: 0` to fill the whole window
  instead of the centered/max-width `.app-shell` card, and the grid is
  `repeat(auto-fill, minmax(230px, 1fr))` so it reflows into more columns
  as the window widens -- standard CSS, not manually recalculated.
- Kept the app's real native window chrome (macOS traffic lights) as-is
  rather than building a custom frameless titlebar to match the mockup's
  monochrome dots exactly -- the in-content "dots" row is purely
  decorative, matching the mockup's look without the added complexity of
  `frame: false` + custom drag regions + wiring real minimize/close.
- `StatusPill`'s `classify()` (ok/warn/error/idle) was exported so the new
  themed pill (`.dl-pill`) could reuse the same status-string
  classification instead of duplicating it, just rendered with the new
  color palette.
- Verified visually with a throwaway local agent+controller+signaling
  triple (separate ports, cleaned up afterward) rather than against the
  production Mac controller -- confirms the layout renders correctly
  including a real device thumbnail; resizing the test window to confirm
  grid reflow was attempted but skipped after AppleScript's window sizing
  command failed unreliably (same class of accessibility flakiness as the
  Phase 5 incident) -- trusted the standard CSS grid behavior instead of
  fighting the tooling further.

## Running locally

Root of the repo:

```
pnpm install
```

Agent mode (run from `apps/desktop`):

```
set APP_MODE=agent && pnpm dev        # Windows cmd
APP_MODE=agent pnpm dev               # macOS/Linux
```

Controller mode (default, just `pnpm dev` from `apps/desktop`). To run both
an agent and controller process on the *same* machine at once for testing,
give each a different renderer dev-server port: `set RENDERER_PORT=5174 && pnpm dev`.

Signaling server (from `server/signaling`):

```
pnpm dev
```

Defaults to `ws://localhost:8080` with `AGENT_TOKEN=dev-token-change-me`
(hardcoded dev fallback in `shared/config.ts` and `server/signaling/src/auth.ts`).
This only works for same-machine or same-LAN testing right now — Phase 4 is
what makes it reachable across the internet.
