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

## Silent launch on Windows (no visible console window)

`start-agent.bat` runs `pnpm.cmd dev` directly, so double-clicking it pops
up a visible cmd.exe console alongside the Agent window -- fine for
development (it's how every real Windows error in this whole project got
diagnosed), but not what a normal double-click-to-open program looks like.

`start-agent-silent.vbs` wraps it: `WScript.Shell.Run` with windowStyle 0
launches `start-agent.bat` with no visible window at all. The underlying
`pnpm dev` process (and the real Agent window it eventually opens) runs
exactly the same either way -- only the console host window is hidden.

Trade-off worth knowing: if something fails before the Agent window can
open (`pnpm` not on PATH, a dependency error, etc.), the silent version
shows nothing at all -- no window, no error, just silence. If the Agent
ever doesn't appear after using the silent launcher, the first thing to
try is running `start-agent.bat` directly to see the actual error.

A real "no console at all, ever, even on real crashes, still debuggable"
experience is what Phase 6 (packaging via `electron-builder` into a proper
installed .exe) is for -- this VBS wrapper is a lightweight stand-in for
day-to-day use before that's built.

## Rebrand: app icon, "Personal Remote" name, and launcher polish

The user provided an app icon design (SVG) and asked for it applied
everywhere, the app renamed to "Personal Remote" (their choice, English),
and the double-click launchers to look like normal programs instead of
generic script files.

- Icon assets (`build/icon.icns`/`.ico`/`.png`, `resources/icon.png`)
  generated from the provided SVG via `qlmanage -t` (no rsvg-convert/
  ImageMagick available) plus `iconutil` for the `.icns`; the `.ico` was
  hand-packed as a PNG-in-ICO container (no ico-writer package installed)
  and verified with `file`. `main/index.ts` now sets the `icon` window
  option on all platforms (was Linux-only) and the macOS Dock icon
  explicitly, so it shows in dev mode too, not just a packaged build.
- **"Personal Remote Controller.app"** (repo root) is a minimal real macOS
  app bundle -- `Info.plist` + a one-line shell launcher + `icon.icns` --
  replacing reliance on the classic "set icon of file to clipboard"
  Finder/AppleScript trick, which turned out to be unreliable on current
  macOS (repeatedly failed with "Finder got an error" during this session).
  A real bundle is the robust way to get a custom-icon double-click
  launcher; `start-controller.command` stays as a plain-output debug
  fallback.
- **`create-desktop-shortcuts.vbs`** (Windows) generates Desktop `.lnk`
  shortcuts with `IconLocation` pointing at `build/icon.ico`, since
  `.bat`/`.vbs` files can't carry a custom icon themselves.
- Recolored the shared blue/purple theme (`app.css` root variables, the
  `.app-icon` gradient, `wavy-lines.svg`) to the new orange/dark-brown
  palette to match the icon and the device list's existing theme --
  affects `AgentView` and the active-session view.
- Renamed everywhere user-visible: `electron-builder.yml`
  productName/appId/executableName, all `win.setTitle(...)` calls, the
  HTML `<title>`, the device list's in-content fake titlebar text, and the
  Agent header ("Agent" -> "Personal Remote Agent"). Left the internal
  `package.json` `name` fields alone (workspace-internal identifiers, not
  user-facing).

## Agent-side connection approval (accept/reject)

The user asked for a confirmation step so a correct PIN alone can't
silently open a live control session -- the person physically at the
agent machine has to explicitly let each connection through, like
AnyDesk/TeamViewer's "accept incoming connection" prompt (this was also
flagged as a Phase 7 hardening item in the original plan).

- Protocol: `connection-request` (server -> agent, sent right after PIN
  verification succeeds), `connection-response` (agent -> server,
  `{ accept: boolean }`), `pairing-pending` (server -> controller, so its
  UI can show "waiting for approval" instead of looking stuck on
  "pairing").
- Server (`pairing.ts`/`index.ts`): a correct PIN no longer immediately
  calls `pairController()` -- it stores the controller's `ws` as
  `AgentRecord.pendingControllerWs` and waits for the agent's
  `connection-response`. A 30s timeout (`PENDING_APPROVAL_TIMEOUT_MS`)
  auto-rejects with `"no response from agent"` if the operator doesn't
  answer (e.g. away from the machine). `connection-response` is only
  honored from the socket that actually matches `agent.ws`, same
  spirit as the thumbnail-update guard. `removeConnection()` now returns
  `{ offlineDeviceId?, orphanedPendingController? }` instead of a bare
  deviceId, so the agent disconnecting while a request is pending notifies
  the waiting controller instead of leaving it hanging, and a pending
  controller disconnecting while waiting clears itself out of the agent's
  record.
- Agent UI: a `connection-request` message shows an "Incoming connection
  request" card (`.connection-request` in `app.css`) with Accept/Reject
  buttons, replacing the status pill until answered. Accepting sends
  `connection-response` with `accept: true`; the existing `pair-result:true`
  handling (unchanged) then starts the screen share exactly as before --
  the new step only gates *whether* that handler ever fires, not what it
  does once it does.
- **Verification status**: the two new/tricky pieces -- the agent showing
  the Accept/Reject prompt on `connection-request`, and the controller
  showing "waiting for approval on the other computer..." on
  `pairing-pending` -- were both confirmed live via an isolated local
  agent+controller+signaling-server triple (separate port, cleaned up
  after). Clicking Accept itself was not click-verified: a macOS
  Accessibility permission dialog (for VS Code, unrelated to this app)
  happened to pop up and intercept the test click. Rather than retry with
  more coordinate-based clicking (unreliable per the Phase 5 incident
  earlier in this session, and this one hit a similar snag), verification
  stopped there and relied on code review instead -- accepting just calls
  the same `connection-response`/`pair-result:true` path that was already
  proven working throughout this whole session, so the risk of a real bug
  in that specific step is low. Recommended: confirm Accept/Reject for
  real against the actual Windows agent, which is also a more meaningful
  test (two separate physical machines, not a Mac self-test).

### Trusted controllers -- approve once, not every time

Requiring a human click on *every single* connection attempt was flagged
by the user as impractical given how often this app already reconnects on
its own (network drops, agent restarts, idle timeouts all trigger a fresh
`pair-request`). Fix: remember a controller after the first accept, and
skip the prompt for it going forward.

- Controllers didn't have any persistent identity before this -- only
  agents had a `deviceId`. `shared/controllerId.ts` adds
  `getOrCreateControllerId()` (a `crypto.randomUUID()`, persisted in the
  controller's own `localStorage` -- nobody types it, so a UUID is fine
  unlike the human-facing numeric device ID). Sent as `controllerId` on
  every `pair-request` (all four call sites in `ControllerSession.tsx`)
  and relayed through unchanged in the server's `connection-request`.
- Trust lives entirely on the **agent's own** `localStorage`
  (`shared/trustedControllers.ts`), not the signaling server -- the
  server's in-memory `agents` map resets on restart, and the security
  decision of "do I trust this controller" is inherently the agent
  machine's to own and persist regardless of server uptime.
- On `connection-request`, the agent checks
  `isTrustedController(controllerId)` *before* ever showing the prompt:
  trusted -> immediately sends `connection-response { accept: true }`
  with no human interaction at all; untrusted -> shows the Accept/Reject
  card as before. Clicking Accept calls `trustController(controllerId)`
  so the *next* attempt from that same controller skips the prompt too.
- Agent UI gained a "Trusted devices" list (only rendered when non-empty)
  showing each trusted controller's ID (truncated to 8 chars -- there's no
  human-friendly name for a controller, unlike agents which have
  `name`/`set-device-name`) with a **Remove** button
  (`revokeController()`) that forces that controller back through the
  Accept/Reject prompt on its next connection attempt. Revoking doesn't
  touch the agent's PIN/deviceId at all -- it's purely "forget this
  specific controller was previously approved."
- Not click-verified for the same reason as the accept/reject feature
  itself (coordinate-based clicking proved unreliable twice in this
  session); the `controllerId` plumbing through `pair-request` ->
  `connection-request` *was* confirmed live (no schema/validation
  regressions, prompt still renders correctly with the new required
  field) via another isolated local triple.

## Auto-start at boot + system tray (Windows agent, Parsec-style)

The user wants the Windows agent to behave like Parsec's host app: start
automatically when Windows logs in, live in the system tray, and not
force a window in front of you just to sit there running.

- `main/index.ts`: agent-mode windows now get a real `Tray` icon (16x16,
  from the same app icon) with a context menu ("Show Personal Remote
  Agent" / "Quit"). Closing the window (`X` button, Cmd/Alt+F4, etc.)
  calls `event.preventDefault()` and hides it instead of quitting --
  standard Electron "minimize to tray" idiom. Only the tray menu's Quit
  (which sets a module-level `isQuitting` flag before `app.quit()`) can
  actually end the process. Controller mode is untouched -- this is
  agent-only, gated on `appMode === 'agent'`.
- A `START_HIDDEN=1` env var (read once at module load as `startHidden`)
  makes the window start hidden entirely -- tray icon only, no window
  flash -- for the auto-start-at-boot path specifically. Manual launches
  (`start-agent.bat`/`start-agent-silent.vbs`, no env var set) still show
  the window normally, since seeing Device ID/PIN/trusted-devices during
  setup or troubleshooting is the point of launching it by hand.
- New `window:show` IPC lets the renderer un-hide itself: when a
  `connection-request` arrives from an *untrusted* controller (the one
  case that genuinely needs a human decision), `AgentView.tsx` calls
  `window.api.window.show()` before showing the Accept/Reject card --
  otherwise a request could arrive while the window is hidden in the tray
  and nobody would ever see the prompt. Trusted-controller auto-accepts
  don't need this, since there's no human decision to surface.
- Windows auto-start scripts (repo root, following the existing
  `start-agent.bat`/`.vbs` pattern rather than Electron's
  `app.setLoginItemSettings()` -- the app isn't packaged yet (Phase 6),
  so there's no stable installed .exe path for that API to point at):
  - `start-agent-background.bat` -- same as `start-agent.bat` plus
    `START_HIDDEN=1`, and deliberately has **no** trailing `pause` (unlike
    `start-agent.bat`) since this always runs with its console hidden --
    a `pause` nobody can ever see or respond to would just leave a
    zombie `cmd.exe` in Task Manager after the agent quits.
  - `start-agent-background.vbs` -- silent (no console) wrapper around
    the above, same `WScript.Shell.Run(..., 0, False)` technique as
    `start-agent-silent.vbs`.
  - `enable-autostart.vbs` -- run once by the user; drops a shortcut to
    `start-agent-background.vbs` (with the real app icon via
    `IconLocation`) into the Windows Startup folder
    (`WshShell.SpecialFolders("Startup")`). Undo by deleting it from
    `shell:startup`.
- **Verification status**: typecheck clean. Visually confirmed on Mac
  (Tray API is cross-platform) that the tray icon appears correctly and
  the window displays normally on a manual (non-hidden) launch. The
  close-to-tray interception itself was not fully confirmed interactively
  -- the live test was interrupted (a test window unexpectedly appearing
  on the user's own screen understandably needed an explanation first;
  see the session transcript). Given `win.on('close', ...)` with
  `event.preventDefault()` is a standard, well-documented Electron pattern
  (not novel/fragile code like the WebRTC or nut.js integration work),
  and the surrounding logic typechecks and follows the same structure
  already proven for `window:set-fullscreen`, this is believed correct
  but not independently confirmed end-to-end. Recommended: verify for
  real on the Windows agent -- close the window and confirm it survives
  in the tray, click the tray icon to bring it back, and try
  `enable-autostart.vbs` + a real reboot to confirm the hidden auto-start
  path.

### Bug found live: trust didn't survive fully quitting the agent

Confirmed working end-to-end by the user (accept once, reconnects skip
the prompt) -- but clicking "Quit" in the tray menu and starting the
agent again required accepting all over. Root cause: `trustController()`
and `getOrCreateControllerId()` originally lived in the *renderer* and
used `localStorage`, which is scoped per-origin -- and this app's
renderer loads from a Vite dev server (`http://localhost:PORT`), where
`PORT` isn't actually fixed. If 5173 is still occupied when a process
restarts (this project has hit that exact "Port 5173 is in use, trying
another one" fallback more than once during development, including
earlier in this same session), the new instance gets a different origin
and a completely empty `localStorage` -- silently forgetting every
trusted controller (and, in principle, the device ID/name/PIN cache too,
though those happened not to be hit by the user's test).

Fixed by moving both to the **main process**, persisted as plain files
under `app.getPath('userData')` (`main/trustedControllers.ts`,
`main/controllerIdentity.ts`) instead of renderer `localStorage`:
`userData` is keyed only by the OS user profile and `appMode`, with no
dependency on which port Vite happened to bind to. Exposed to the
renderer via new IPC (`trusted:list`/`is-trusted`/`trust`/`revoke`,
`controller:get-id`), all necessarily async now (`window.api.trusted.*`,
`window.api.controllerId.get()`) since IPC always is -- `AgentView.tsx`'s
trusted-list state is now fetched in a `useEffect` on mount rather than a
synchronous `useState` initializer, and `ControllerSession.tsx`'s pairing
effect waits for `controllerId` to load (a single IPC round-trip) before
sending its first `pair-request`. The old renderer-side
`shared/trustedControllers.ts` and `shared/controllerId.ts` were deleted
outright rather than left as dead code.

Not independently re-verified live after this change (avoided further
same-machine UI testing after an earlier test window unexpectedly
appeared on the user's screen mid-session and needed explaining -- see
the session transcript). The fix itself is straightforward, well-trodden
Electron main-process `fs` file I/O, structurally simple enough that
typecheck + code review is reasonable confidence here. The real test is
exactly the one that surfaced the bug: accept once, Quit from the tray,
relaunch, reconnect, and confirm it does *not* ask again.

## Mac auto-connect to last device

Confirmed working after the trust-persistence fix, the user asked for the
Mac controller to also jump straight back into its last session on
launch (previously explicitly changed *away* from a hardcoded
single-device auto-connect to default to the picker -- this is the
proper successor: dynamic, based on whatever was last actually used, not
one fixed device baked into a launcher script).

- `main/controllerMemory.ts` -- same file-in-`userData` pattern as
  `trustedControllers.ts`/`controllerIdentity.ts` (not renderer
  localStorage, for the same port-drift reason). Tracks cached PINs per
  device (migrated from the old renderer-local `shared/devicePins.ts`,
  now deleted) plus a `lastDeviceId`. `getLastDevice()` only returns a
  device if its PIN is *also* still cached -- no point auto-connecting
  into something that would just prompt for a PIN anyway.
- `ControllerView.tsx` checks `window.api.controllerMemory.getLastDevice()`
  once on mount (behind a `checkedLastDevice` loading flag, to avoid a
  flash of the device list before the IPC round-trip resolves) and, if
  present, skips straight to `ControllerSession`. The env-var
  (`VITE_DEVICE_ID`/`VITE_PIN`) auto-connect path from the old
  single-device launcher scripts still takes priority if set, unchanged.
  Pressing Back returns to the picker for that session only -- it doesn't
  clear the remembered last-device, so relaunching still jumps back in.

## Phase 6: packaging -- first-run mode picker + a real Windows installer

The user asked for the app to be "install and go" on a new Windows
machine: no environment variables, no editing a `.bat` file, no `pnpm`
knowledge required -- just run an installer and pick "controller" or
"agent" once.

### First-run mode picker

`APP_MODE` (the env var dev/test runs use) has no equivalent for a
double-clicked installed `.exe` -- there's no convenient way to set an
environment variable for it. Fixed by resolving the mode at startup from,
in order: `APP_MODE` env var (dev) -> a previously saved choice
(`main/appModeConfig.ts`, a file under `userData`) -> asking the person,
shown once via a small `ChooseModeView.tsx` screen
(`role=choose-mode`, created by a new `promptForMode()` in
`main/index.ts` that resolves a Promise when the renderer calls
`window.api.chooseMode(mode)`). The pick is saved immediately and never
asked again on that install.

This required restructuring `main/index.ts`'s bootstrap: `appMode` used
to be a plain top-level `const` computed synchronously from the env var
alone. It's now resolved *inside* `app.whenReady()` (which can `await`
the picker), and `app.setPath('userData', ...)`'s mode-subfolder nesting
-- previously always applied -- is now conditional on `envMode` actually
being set. That nesting was originally a dev-only convenience (running an
agent and a controller side by side on one dev machine without them
sharing a Chromium profile); a real single-purpose install never needs
it, since only one mode ever runs from a given install, and nesting would
have created a chicken-and-egg problem (needing to know the mode, chosen
via a file *inside* userData, before userData's own path could be set).

### Building the actual installer

Genuinely uncertain going in whether this would work at all: nut.js's
native addon is platform-specific, and building a Windows target *from
macOS* ("cross-compiling" in electron-builder's terms) could plausibly
have failed outright if it required actually compiling native code for
the target platform.

**It works.** `@nut-tree-fork/libnut-win32` ships a **prebuilt** native
binary (`libnut.node`, a real PE32+ x86-64 Windows DLL, confirmed via
`file`) rather than requiring local compilation -- so electron-builder's
Windows/NSIS target build is just packaging already-built files, which
works fine from macOS with no Wine or Windows machine needed. Built and
verified via `pnpm build:win` (from `apps/desktop`):
`dist/desktop-1.0.0-setup.exe`, a genuine `PE32 executable ... Nullsoft
Installer self-extracting archive` per `file`, ~98MB, containing a real
x64 `libnut.node`.

- `electron-builder.yml`'s `win.target` now explicitly pins `arch: [x64]`
  -- electron-builder defaults to the *host* machine's architecture when
  unspecified, which meant the very first build attempt produced an
  **arm64** Windows installer (matching this Apple Silicon Mac, useless
  for a typical x64 Windows PC) before this was caught and fixed.
- The packaged app bundles all three platforms' `libnut.node` variants
  (win32/linux/darwin, ~500KB each) rather than just the target one --
  nut.js's own runtime `require()` picks the right one by `process.platform`
  so this isn't a correctness problem, just a little unnecessary size.
  Left as-is (not worth the added `files`/`asarUnpack` config complexity
  for ~1MB on a 98MB installer).
- `dist/` is already gitignored -- the installer itself isn't (and
  shouldn't be) committed. Rebuild with `pnpm build:win` from
  `apps/desktop` any time; the resulting `.exe` needs to be copied to the
  Windows machine some other way (shared drive, cloud storage, USB) since
  it's built here on the Mac.
- Not yet verified: actually running the installer and the first-run mode
  picker on a real Windows machine (only typechecked + built successfully
  from the Mac side; the mode-picker screen itself was visually confirmed
  in dev mode with a fresh isolated `--user-data-dir`, but the full
  install -> first-launch -> pick-a-mode -> works flow hasn't been run
  end-to-end on Windows).

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
