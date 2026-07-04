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

### Bug found live: the packaged installer had no auto-start at all

The VBS/Startup-folder auto-start above only ever applied to the dev-mode
source checkout (`enable-autostart.vbs` drops a shortcut to
`start-agent-background.vbs`, a file that only exists in that checkout).
Once the user actually installed the real packaged app and deleted the old
dev-mode folder (see the earlier "Folder In Use" troubleshooting in the
session transcript), there was **no auto-start mechanism left at all** --
the installed app never registered itself to launch at login by any means.
Surfaced as: close/reboot Windows, agent never comes back, have to launch
it by hand every time.

Fixed with Electron's own `app.setLoginItemSettings()` -- the API the
original tray section above explicitly avoided because "the app isn't
packaged yet ... no stable installed .exe path for that API to point at."
That blocker is gone now that Phase 6 packaging is done:

```js
if (app.isPackaged && appMode === 'agent') {
  app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })
}
```

Called on every launch of a packaged agent (cheap, and keeps the
registered path in sync if the install location ever changes). Windows
starts the app with a `--hidden` argv flag on login; `startHidden` now
checks `process.argv.includes('--hidden')` in addition to the existing
`START_HIDDEN=1` env var (which still covers the dev-mode scripts), so
both paths land on the same tray-only-no-window-flash behavior. Only
wired for agent mode -- the controller is meant to be opened by hand when
you actually want to connect somewhere, not run unattended.

The old `.vbs` auto-start scripts are left in the repo since they still
serve dev-mode (`pnpm dev`) testing, but are no longer relevant to the
packaged/installed workflow -- that now "just works" out of the box with
zero extra setup scripts to run.

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

### Bug found live: delete + reinstall skips the mode picker

User uninstalled and reinstalled to test a fresh setup, expecting the
mode picker to show again -- it didn't, silently landing back in Agent
mode. Cause: `getSavedMode()` reads `userData/app-mode.json`, and NSIS's
default uninstaller does **not** delete `userData` (`%APPDATA%\Personal
Remote`) -- nothing in `electron-builder.yml` sets
`deleteAppDataOnUninstall`. So a reinstall finds the old saved choice and
skips `promptForMode()` entirely, same as a normal update would (correctly
-- you don't want an update to re-ask this). The picker only shows on a
machine that has genuinely never run the app before.

Deliberately did **not** make uninstall wipe `userData` -- that would
throw away trust/PIN/device-id on every reinstall, which is worse for the
common case (reinstalling to pick up a fix, not to switch roles) than the
rarer case (actually wanting to switch Agent/Controller). Instead added an
explicit, user-initiated escape hatch: `resetMode()` in
`appModeConfig.ts` deletes just `app-mode.json` (not trust/PIN/anything
else), wired to a small "Switch mode" link (bottom-left corner,
`SwitchModeLink.tsx`, opposite `UpdateBadge`) on both `AgentView` and the
device list. Clicking it confirms via a native `dialog.showMessageBox`
(explains that trust/PIN survive, only the mode choice resets) before
`app.relaunch()` + `app.exit()`, which brings the app back through
`promptForMode()` on the next launch.

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

## Settings: user-set/resettable PIN, no more hardcoded PIN in git

The launcher scripts (`start-agent.bat`, `start-agent-background.bat`) used
to set `VITE_PIN=807302` -- a real, working PIN, committed in plaintext.
That was an acceptable trade-off only while the repo stayed private; going
public (a prerequisite for the planned GitHub-Releases auto-update feature)
would have exposed it to anyone.

Replaced the whole mechanism instead of just rotating the value:

- `apps/desktop/src/main/agentIdentity.ts` -- new main-process file store
  (`userData/agent-identity.json`), same pattern as
  `trustedControllers.ts`/`controllerIdentity.ts`/`controllerMemory.ts`.
  Holds `deviceId`, `name`, and `pin`. `getOrCreateDeviceId()` migrates the
  device ID off renderer localStorage too (same port-drift risk class
  flagged earlier for the agent side, fixed here as part of the same
  sweep). `getOrCreatePin(legacyFixedPin?)` seeds from the old `VITE_PIN`
  env var *only* if no persisted PIN file exists yet, then the file wins
  forever after -- but since the env var line is now deleted from the
  launcher scripts in this same change, that seeding path won't actually
  fire for the real Windows install; see the transition note below.
- New IPC surface (`agent-identity:*`) and `window.api.agentIdentity.*` in
  the preload, mirroring the existing trusted/controllerMemory shape.
- `AgentView.tsx`: the PIN field in the credential grid is now an editable
  input (was a static `<span>`), plus a "generate a new one" link for a
  one-click reset. Both call into `agentIdentity` and then update local
  state -- since `pin` is a dependency of the connect effect, changing it
  tears down and re-establishes the signaling connection with a fresh
  `register-agent` (the server only checks the PIN hash captured at
  register time, so anything less would leave the server still accepting
  the old PIN). This intentionally drops any live paired session, which is
  the right behavior for a credential-rotation action. Device name and
  device ID were also moved off `localStorage` onto the same IPC calls,
  closing out that latent risk.
- `start-agent.bat`/`start-agent-background.bat`: the `VITE_PIN=807302`
  line is deleted outright, not just changed to a placeholder -- the whole
  point was to stop a real secret from living in a committed file.

**One-time transition on the real Windows machine**: since the env var
line is gone in the same commit that adds the persisted-PIN file, the
first `update-agent.bat` + restart after this change will generate a
brand-new random PIN (no persisted file exists yet, no env var to seed
from). This invalidates the Mac's cached PIN for that device, which will
surface as an "incorrect pin" on next connect and clear itself from
auto-connect. Fix is exactly the new feature: open the Agent window, read
the new PIN or just type a memorable one into the PIN field, and re-enter
it once on the Mac's device list. Deliberately not more automated than
that -- a manual one-time step here is simpler and more obviously correct
than migration logic for a case that only ever happens once.

## Auto-update wiring (electron-updater + GitHub Releases)

Added the client-side half of auto-updating.

- Added `electron-updater` and `apps/desktop/src/main/updater.ts`:
  `initAutoUpdater()` is a no-op unless `app.isPackaged` (running via
  `pnpm dev` has no real feed or installer to update against). Checks once
  at startup and every 6 hours after -- long enough intervals to not spam
  GitHub, frequent enough that the agent (which can run unattended for
  days after auto-starting at boot) doesn't need a manual restart to pick
  up a release. On `update-downloaded`, shows a native dialog with
  "Restart now" / "Later"; if left running, `autoInstallOnAppQuit` applies
  it the next time the app actually closes anyway.
- `electron-builder.yml`'s `publish` block now points at
  `provider: github, owner: gameplaygod123-pixel, repo: remote-control`
  (was a placeholder `generic` URL). This is what both the *read* side
  (the installed app's update feed) and the *write* side (`electron-builder
  --publish always`) resolve against.
- New script `pnpm release:win` (in `apps/desktop`) = build + `electron-builder
  --win --publish always`. Needs a `GH_TOKEN` env var (a GitHub PAT with
  `repo` scope) set on the Mac when run -- `gh auth token` works if the
  `gh` CLI is already logged in. This is the actual "cut a release" command
  going forward: bump the version in `apps/desktop/package.json` first,
  then run this from `apps/desktop` with `GH_TOKEN` set.

**Now live**: the repo went public on 2026-07-04 (asked the user
explicitly first, since the old commits containing the now-retired real
PIN 807302 become permanently visible once public -- they confirmed going
ahead once the Windows installer had been test-installed). First real
release published the same day: `v1.2.0`, via `GH_TOKEN=$(gh auth token)
pnpm release:win` from `apps/desktop`. One gotcha: electron-builder's GitHub publish creates the release as a
**draft** by default -- draft releases don't show up in the public
releases list and electron-updater can't see them either. Had to manually
`gh release edit v1.2.0 --repo gameplaygod123-pixel/remote-control
--draft=false` for this first release; fixed for good after that by
adding `releaseType: release` to the `publish` block in
`electron-builder.yml`, so future `pnpm release:win` runs publish live
immediately with no extra step. Verified the published asset
(`latest.yml`) is reachable with a plain anonymous `curl` (no token),
confirming the feed is actually usable by an installed app with no
credentials.

**Known flaky quirk**: `pnpm release:win` has twice thrown a GitHub API
error (visible as a raw HTTP response dump, e.g. rate-limit headers) right
after `overwrite published file` / `already exists on GitHub`, non-
deterministically. Checking the actual release afterward showed it can go
either way -- fully published, or missing `latest.yml`/`.blockmap`
(uploaded the .exe but not the rest). If the command exits non-zero, don't
assume the release is broken *or* fine -- always check with
`gh release view vX.Y.Z --repo gameplaygod123-pixel/remote-control` and
count the assets (should be exactly 3: the `.exe`, its `.blockmap`, and
`latest.yml`). If assets are missing, just re-run `pnpm electron-builder
--win --publish always` (skips the rebuild, reuses the existing
`dist/` output) -- it detects what's already uploaded and finishes the
rest.

### Manual "check for updates" control

The periodic background check (every 6h) is too slow for iterating on a
personal build -- publish a release, then want to grab it immediately
without waiting or needing to fully restart the app. Added:

- `updater.ts` now broadcasts a typed `UpdaterStatus` to every window over
  `updater:status`, and exposes `updater:check-now` / `updater:restart-now`
  IPC handlers (both registered even in dev mode, so the button never
  throws -- in dev they just report back "packaged build only").
- `UpdateBadge.tsx` -- a small fixed-position pill (bottom-right corner,
  self-styled so it reads over both app themes) showing the current state
  (`Check for updates` / `Checking...` / `Downloading...` /
  `Restart to install vX`) and triggering the matching action on click.
- Deliberately **not** rendered inside `ControllerSession` (the fullscreen
  remote-video view) -- a fixed corner button sitting on top of the video
  would eat clicks meant for that corner of the *remote* screen. Only
  rendered in `AgentView` and `DeviceListView`, where there's no
  interactive remote content underneath it.

## Agent view: full-bleed layout + footer buttons that don't overlap content

Two visual complaints from a real screenshot: (1) the floating
`UpdateBadge`/`SwitchModeLink` corner pills sat directly on top of the
device list's own footer text, visibly clipping it (`online: 4` read as
`ffline: 4`); (2) `AgentView` was still using the **unmodified
electron-vite starter template's** `.app-shell` -- a small `max-width:
460px` card, centered by `body`/`#root` flex rules in `main.css`, floating
over that template's decorative `wavy-lines.svg` background. Never
customized away from scaffolding in earlier work.

- **Footer buttons**: `UpdateBadge`/`SwitchModeLink` no longer carry their
  own `position: fixed` pill styling. Replaced with one shared
  `.footer-link` class (plain text-button, `color: inherit`, no
  background/border) meant to be rendered *inside* each screen's existing
  footer bar rather than floating on top of it. `.dl-footer` already sets
  a text color on itself, so `color: inherit` picks that up automatically
  in the device list; `.agent-footer` (new, see below) does the same for
  the agent screen. `DeviceListView`'s footer is now two `.dl-footer-group`
  clusters (left: online/offline count + Switch mode; right: update status
  + last-updated time) instead of two bare `<span>`s with the buttons
  floating separately on top.
- **Full-bleed agent shell**: new `.agent-shell` (`position: fixed; inset:
  0`, solid `#171210` background matching the device list's base color for
  consistency) replaces `.app-shell` for `AgentView` specifically --
  same technique `.dl-shell` already used to escape the starter
  template's centering. Structure now mirrors the device list: a slim
  draggable `.agent-titlebar` (dots + "Personal Remote — Agent"), a
  scrollable `.agent-body` (the existing header/credentials/video/trusted-
  list content, now capped at `max-width: 640px` and centered *within* the
  full-bleed shell so text doesn't stretch uncomfortably wide on a large
  window, while the window chrome itself still fills edge-to-edge), and an
  `.agent-footer` bar holding Switch mode / Up to date. `.app-shell` itself
  is untouched and still used by `ChooseModeView` and `ControllerView`'s
  brief loading state -- neither was part of this complaint.

## Removing stale devices from the Computers list

The device list is a live view of the signaling server's in-memory agent
roster, which only clears on server restart (see `pairing.ts`'s note on
why that's an acceptable trade-off for a personal relay) -- old test
devices from earlier development sessions (`883429247`, `835540922`, etc.)
just accumulate forever otherwise, since they'll never come back online to
naturally get cleaned up. Added an explicit remove action:

- New protocol messages (`packages/protocol/src/messages.ts`):
  `RemoveDeviceMessage` (controller -> server) and `DeviceRemovedMessage`
  (server -> every subscribed controller, so all open device lists drop it
  live, not just the one that clicked Remove).
- `pairing.ts`'s `removeDevice(deviceId)` only deletes the record if the
  device is currently **offline** -- silently a no-op otherwise. Removing
  a live/reachable device as a side effect of a list-cleanup click would
  be surprising; if you actually want to stop a device from being
  reachable, that's an agent-side decision (quit the agent), not a
  controller-side list edit.
- `DeviceListView.tsx`: a small "Remove" text link under the Connect
  button, shown only for offline cards (matches the server's guard, so it
  never appears to silently fail). Doesn't optimistically update local
  state -- waits for the server's `device-removed` broadcast, consistent
  with how renaming/thumbnails already work here.
- The signaling server runs via `tsx watch` (see `server/signaling`'s
  `dev` script), so this took effect immediately on save with no manual
  restart -- confirmed via `lsof -i :8080` showing a freshly-spawned
  process right after editing.

## Bidirectional file transfer (AnyDesk-style drag & drop)

User asked after seeing AnyDesk's drag-a-file-onto-the-remote-screen
feature. Built as peer-to-peer, not through the signaling server -- files
never touch the relay, same trust model as video/input.

- **New data channel, not the existing "input" one**: `peerConnection.ts`
  gained `createFileChannel`/`onFileChannel` options, mirroring
  `createInputChannel`/`onInputChannel` exactly (same offerer-creates-it,
  bidirectional-once-open pattern). Deliberately a *separate* channel --
  data channels preserve message order by default, so interleaving large
  binary file chunks with real-time mouse/keyboard on the same channel
  would head-of-line-block cursor movement for the duration of a transfer.
  Both `AgentView` (`createFileChannel: true`) and `ControllerSession`
  (receives via `onFileChannel`) wire it up, since either side can
  initiate a send once the channel is open.
- **Chunked transfer protocol** (`shared/fileTransfer/fileTransferChannel.ts`):
  a JSON `file-start` (name + size) control message, then the file's bytes
  as a sequence of 16KB binary `ArrayBuffer` messages, then a JSON
  `file-end`. No per-chunk index/ID needed -- channel ordering guarantees
  every binary message between one `file-start` and the next `file-end`
  belongs to that transfer, which is enough for a personal tool that only
  ever has one transfer in flight per direction at a time.
  `bufferedAmountLowThreshold` + the `bufferedamountlow` event throttle
  sending so a large file can't balloon `channel.bufferedAmount` far ahead
  of what's actually been delivered.
- **Receiving side never writes to disk directly** -- the renderer has no
  Node/fs access, so the assembled `Uint8Array` crosses into the main
  process via a new `file-transfer:save` IPC call
  (`main/fileTransfer.ts`), which writes to `app.getPath('downloads')`,
  de-duplicating an existing filename by appending `(1)`, `(2)`, etc.
  (never overwrites), and fires a native `Notification` on completion --
  important on the agent side especially, since nobody's typically
  watching that window.
- **Shared orchestration**: `useFileTransferChannel()` (a hook) and
  `TransferStatus.tsx` (a small progress banner/bar) are used identically
  by both `AgentView` and `ControllerSession` rather than duplicating
  send/receive state machine logic per screen -- same channel, same
  protocol, same UI, regardless of which side is sending.
- **Drop targets**: the `<video>` element in `ControllerSession` (drop a
  file onto the remote screen while it's fullscreen); the entire
  `.agent-shell` in `AgentView` (no equivalent "video you're looking at"
  there to scope it to). Progress renders as an overlay docked to the
  bottom of the video in the controller session
  (`.session-video-area .transfer-status`), and as a normal block under
  the video-frame in the agent view.
- Entirely peer-to-peer over the data channel -- deliberately does **not**
  touch `packages/protocol/src/messages.ts` or the signaling server, which
  only ever relay SDP/ICE/pairing and never see file contents.

### First real test: stuck at 0%, and no error handling anywhere to explain why

User's first real test (a 3.8MB file) showed both ends frozen at "...0%"
with no indication of whether it was slow, stuck, or dead.

**Verified the algorithm itself is correct** before looking anywhere else:
wrote a standalone test (no Electron, no real WebRTC) using a fake
data-channel pair that feeds `sendFileOverChannel`'s output straight into
`createFileReceiver` -- sent a real 3.8MB buffer through the exact same
chunking code the app uses, and the received bytes matched the original
byte-for-byte, with progress correctly reaching 100% on both sides. This
ruled out a logic bug in the chunking/reassembly itself.

The real problem: **zero error handling anywhere in the send/receive
path**. `sendFiles`'s loop had no try/catch, so a `channel.send()` throwing
(dropped channel, closed connection mid-transfer, any WebRTC hiccup) would
silently die, leaving the UI frozen at whatever percentage it last
reached -- indistinguishable from "still going, just slow." Fixed in
`useFileTransferChannel.ts`:

- try/catch around both the send loop and the receive handler, setting a
  new `error` field on `TransferState` instead of leaving state stuck.
- A stall watchdog: tracks the timestamp of the last progress event: if
  15 seconds pass with no movement, the transfer is marked failed
  (`"stalled -- no response from the other side"`) even if the underlying
  promise never actually resolves/rejects on its own (e.g. hung forever on
  a `bufferedamountlow` event that'll never fire because the channel died)
  -- gives up on tracking it rather than displaying nothing useful forever.
- `TransferStatus.tsx` renders an `.is-error` state (red-tinted) instead
  of the progress bar when this happens.

Whether the original test was a genuine stall (network/TURN-relay hiccup)
or just still in progress when the screenshot was taken is unresolved --
this at least guarantees the *next* attempt either completes or shows a
concrete reason instead of an ambiguous frozen "0%".

### User asked for a faster transfer -- added a diagnostic instead of guessing

Before changing anything, worth being honest: the chunking code itself was
already verified correct and reasonably efficient (see above). The much
more likely explanation for a slow transfer is the **connection path**,
not this app's protocol -- if the two machines can't reach each other
directly (common between two home networks/CGNAT), traffic falls back to
the free Open Relay Project TURN server, which is a shared public demo
service with real bandwidth limits that have nothing to do with this
app's code.

- New `shared/webrtc/connectionType.ts`: `getConnectionType(pc)` inspects
  `RTCPeerConnection.getStats()` for the selected/nominated
  `candidate-pair`, and checks whether either side's candidate is of type
  `relay`. Both `AgentView` and `ControllerSession` call this once
  `connectionState` becomes `'connected'` and show a small badge next to
  the status pill: "via relay" or "direct connection".
- Also bumped `CHUNK_SIZE` 16KB -> 64KB and
  `BUFFERED_AMOUNT_LOW_THRESHOLD` 1MB -> 4MB in `fileTransferChannel.ts` --
  a legitimate, if modest, improvement (fewer send()/onmessage round-trips
  per file) that's very unlikely to be the dominant factor if the
  connection is relayed, but there's no reason not to take a free win
  regardless of what the diagnostic shows.
- Re-ran the standalone chunking/reassembly test (see above) after the
  chunk-size change to confirm it's still byte-exact.

Next real step once the user reports back what the badge shows: if it
says "via relay", the honest options are accepting the free tier's
limits, or self-hosting a real coturn TURN server on a small VPS (already
flagged as the natural upgrade path in the original plan's known-risks
section) -- not something fixable by changing this app's own protocol
code further.

### The connection badge showed "direct" -- and the chunk-size bump was the actual bug

Badge confirmed a direct P2P connection, ruling out TURN relay entirely.
Then the *next* file-transfer attempt (same 3.8MB file, now on v1.5.0 with
the new error handling) immediately surfaced `"Dungeon": failed to send`
-- a real, reproducible failure, not a stall or a slow-but-working
transfer.

Root cause: **the 64KB chunk-size bump from the previous change**.
`RTCDataChannel.send()` throws synchronously if a single message exceeds
the max message size actually negotiated between the two peers for that
specific connection -- a per-connection SCTP negotiation outcome, not a
fixed constant this app can know in advance. 16KB is conservative enough
to stay under that ceiling essentially always; 64KB apparently wasn't, at
least for this connection. Reverted `CHUNK_SIZE` back to 16KB and
`BUFFERED_AMOUNT_LOW_THRESHOLD` back to 1MB (the exact values from before
the "faster transfer" attempt) -- re-verified byte-exact with the
standalone test again after reverting.

This is exactly why the earlier "let's bump chunk size, it's a free win"
reasoning was wrong: message-size limits aren't discoverable or
guaranteed portable across connections, so a value that's "obviously
safe" on one path can silently break another. Not worth revisiting
without a real, measured need -- 16KB stays.

Also improved error visibility while looking at this: **`describeError()`**
in `useFileTransferChannel.ts` now surfaces the actual `Error.message`
from a failed send/receive/save (e.g. the real DOMException text) instead
of a generic hardcoded string like "failed to send" -- important because
this is a packaged app with no accessible devtools console, so the
in-app error banner is the only diagnostic channel available at all.

### That error-visibility fix immediately paid off: real bug #2

The very next retry (still the same 3.8MB "Dungeon" file, v1.5.1) surfaced
a *different*, more specific error thanks to `describeError()`: `"A
requested file or directory could not be found at the time an operation
was processed."` -- verbatim the browser's standard `DOMException`
message for `NotFoundError`, not a generic string I wrote. Without the
previous fix this would have been indistinguishable from any other
silent/generic failure.

**Root cause**: `sendFileOverChannel` was calling
`file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()` *per chunk*,
spread out across the whole transfer (~232 calls for this file at 16KB
chunks, each potentially delayed by `waitForDrain()`'s backpressure wait).
A `File` obtained from a drag-and-drop isn't guaranteed to stay readable
for an extended period this way -- on Windows in particular, the
underlying OS-level file reference backing the `File` object apparently
went stale partway through, and the browser reports that as
`NotFoundError` when a subsequent `slice().arrayBuffer()` call tries to
read from it.

**Fix**: read the entire file into memory *once*, immediately, via a
single `await file.arrayBuffer()` right after sending `file-start` --
before any backpressure-related delay has a chance to occur. Chunking now
happens via plain `ArrayBuffer.prototype.slice()` on that already-read
buffer, which has no dependency on any external OS file handle and can
never go stale mid-transfer. Re-verified byte-exact with the standalone
test (updated its fake File to also implement a direct `.arrayBuffer()`
method matching the real `File`/`Blob` interface).

This is the second real, reproducible bug found in two consecutive
manual tests -- both only diagnosable *because* the previous fix added
real error-message visibility instead of a generic string or silent
freeze. Worth remembering as a pattern: for a packaged app with no
devtools access, investing in "show the real error" pays for itself
almost immediately.

### Same error, persisted after the fix -- the actual cause was a folder, not a file

The user retested, confirmed they'd genuinely restarted into v1.5.2 (the
"read the whole file upfront" fix), and got the *exact same*
`NotFoundError` on the same file, from a real local file on their own
Mac's Finder (ruled out the earlier remote-video-drag theory too). The
"read once immediately" fix from the previous entry didn't touch the
actual cause at all.

**Real root cause**: "Dungeon" is a **folder**, not a file (a game
folder). The browser's File/Blob drag-and-drop API has no concept of
directory content -- a dropped folder still shows up in
`dataTransfer.files` as a `File`-shaped object with a name and even an
apparent size, but calling `.arrayBuffer()` (or `.slice().arrayBuffer()`)
on it throws `NotFoundError` immediately, because there's no actual byte
content behind a directory entry. Neither of the two previous fixes stood
a chance -- this was never about *when* or *how* the file was read, it
was that there was no file to read in the first place.

**Fix**: detect this *before* ever attempting a read, using
`DataTransferItem.webkitGetAsEntry()` (only available via
`dataTransfer.items`, not `dataTransfer.files` -- `File` objects
themselves have no `isDirectory` property). New
`findDroppedDirectory(dataTransfer)` in `fileTransferChannel.ts` checks
every dropped item's entry and returns the first directory's name, or
`null` if everything dropped is a real file. Both `ControllerSession`'s
and `AgentView`'s `handleDrop` check this first and, if found, call a new
`rejectDrop(name, reason)` from `useFileTransferChannel` -- shows the same
error banner UI but with an actionable message ("folders aren't supported
-- zip it first and drop the .zip instead") instead of a cryptic browser
exception, and never attempts a doomed read at all.

Three attempts, three different (wrong, wrong, then right) theories --
the pattern that actually worked was: ship a fix, ask the user to
literally confirm the version before re-testing, and take the *exact*
error text at face value rather than assuming the previous theory must
still be right just because it seemed sound. "A requested file or
directory could not be found" -- was, quite literally, about a directory
the whole time.

## Follow-up hardening: concurrent-transfer guard, cancel, and file size

Bug hunt over, user confirmed working end-to-end. Asked what else was
worth improving before moving on -- code review of the file-transfer
feature as a whole (not chasing a specific bug report this time) surfaced
one real latent correctness bug plus two requested UX additions.

**The real bug**: `sendFiles` had no re-entrancy guard. The documented
assumption ("only one transfer in flight per direction at a time") was
never actually enforced -- dropping a second file while the first was
still sending would start a *second* concurrent call into
`sendFileOverChannel` on the same channel, interleaving both files'
binary chunks with no per-transfer ID to tell them apart. The receiver
(`createFileReceiver`) tracks exactly one transfer's state via closures,
so the second file's `file-start` arriving mid-stream would silently
reset that state, discarding whatever of the first file had arrived and
corrupting the second file's assembly with leftover chunks from the
first -- with **no error at all**, unlike every bug found so far in this
feature. Fixed with a queue: `useFileTransferChannel.ts`'s `sendFiles` now
always just appends to `sendQueueRef`, and only kicks off `drainSendQueue`
if nothing is already draining it -- new drops during an active send get
picked up by the same loop once it's free, never run concurrently.

**Cancel button**: `sendFileOverChannel` takes a `shouldCancel: () =>
boolean` callback, checked once per chunk -- cheap, and the loop is the
only place sending happens. `cancelTransfer()` in the hook sets that flag
*and* sends a new `file-cancel` control message immediately, regardless of
which direction is currently active (if we're receiving, this tells the
sender to stop; if we're sending, our own loop notices `shouldCancel()` on
its next iteration). `createFileReceiver` handles an incoming
`file-cancel` by resetting its state and calling a new `onCancel` handler.
One subtlety: that `onCancel` handler *also* sets `cancelRequestedRef`,
not just `setTransfer(null)` -- otherwise cancelling while receiving would
clear the UI locally but leave the other side's send loop running
unnoticed in the background, still burning bandwidth on chunks nobody's
assembling anymore.

**File size display**: `TransferState` gained an optional `totalBytes`,
set from `file.size` (sending) or the `file-start` message's `size`
(receiving). `TransferStatus.tsx` formats it as e.g. "(2.4 MB of 100 MB)"
next to the percentage, via a small `formatBytes()` helper.

Extended the standalone chunking test with a second scenario exercising
cancellation end-to-end (a fake sender aborts mid-transfer via
`shouldCancel`, a fake receiver confirms it sees the resulting
`file-cancel` message and fires `onCancel`) -- both scenarios pass.

## Session header redesign + rename-from-controller

Complaint: the session header (shown while actively controlling a
device) just displayed the raw numeric Device ID with no name, and its
layout looked cluttered -- Back button, ID+subtitle, connection badge,
and status pill all crammed together with `justify-content` left at its
flex default.

- **Layout**: `.session-header` now has three explicit zones --
  `.session-header__back` (fixed), `.session-header__info` (flexible,
  takes remaining space), `.session-header__status` (fixed, connection
  badge + status pill grouped together on the right) -- instead of four
  loose children with no structure.
- **Name display + inline rename**: the device's name is now the primary
  heading, editable directly via a borderless `<input>` that only shows
  its border on hover/focus (same interaction pattern as the Agent's own
  "Device name" field), with the raw Device ID demoted to small subtitle
  text. Renaming from the controller sends the *same* `set-device-name`
  message the agent itself uses to rename itself -- the signaling server
  never checked which side sent it, so this worked with zero server
  changes. Doubles as a way to leave yourself a note ("downloading
  game") rather than strictly a hostname.
- **Threading the name through**: `DeviceListView`'s `onConnect` callback
  gained an optional third `name` parameter (passed from the already-known
  `device.name` when connecting from the discovered list), threaded through
  `ControllerView`'s `ActiveDevice` state into a new `name` prop on
  `ControllerSession`. Manual "Add device" and last-device auto-connect
  paths don't know a name in advance, so they just fall through to
  showing the Device ID as the input's placeholder -- same UI, nothing
  broken, just an empty starting point to type into.

## Three bugs from the name-field feature, one real regression underneath

User tried the new inline rename field immediately: couldn't type into it
at all, and separately asked to remove two auto-behaviors (auto-connect
to the last device on launch, auto-fullscreen on every successful
connection) that turned out to actively fight the new field.

**The real bug**: `ControllerSession` already had a `window`-level
`keydown`/`keyup` listener pair whose whole job is to capture every
keystroke in this window and forward it to the remote agent as remote
input (that's how typing during a session reaches the controlled
machine). Adding a real local `<input>` into this same window without
teaching that listener to leave it alone meant every keystroke aimed at
the name field got `preventDefault()`-ed and shipped off to the remote
machine instead of updating local state -- from the user's side, the
field was just inert. Fixed with a new shared helper,
`isEditableTarget()` in `inputProtocol.ts` (checks `instanceof
HTMLInputElement || HTMLTextAreaElement`), checked first thing in both
the remote-forwarding handler and the separate Escape-to-disconnect
handler -- the latter needed the same fix for a related reason: pressing
Escape while editing the name (e.g. to cancel) was disconnecting the
whole session instead of just leaving the field.

**The two auto-behaviors**, now both removed as unwanted rather than
buggy:

- `ControllerView.tsx` no longer calls `controllerMemory.getLastDevice()`
  on mount to auto-populate `activeDevice` -- landing straight into a
  session (and, combined with the next point, straight into fullscreen)
  on every launch was the opposite of "let me pick a device." Removed the
  whole read path along with its now-dead IPC handler
  (`controller-memory:get-last-device`) and preload exposure -- confirmed
  via `grep` that nothing else called it before deleting. Left
  `setLastDeviceId` in place (still called on every connect) since it's
  cheap and harmless to keep recording even without a current reader.
- `ControllerSession.tsx`'s `pc.onconnectionstatechange` no longer calls
  `window.api.window.setFullScreen(true)` when a connection succeeds --
  a small window is sometimes exactly what's wanted (e.g. keeping an eye
  on the remote screen while doing something else locally). The OS's own
  fullscreen control (green button / Ctrl+Cmd+F on macOS) still works
  whenever fullscreen is actually wanted; `setFullScreen(false)` on
  leaving a session is untouched, so that part of the cleanup still
  happens correctly either way.

## Smoothness pass: capture resolution/framerate + a real stats readout

User reported remote control not feeling smooth and asked for options.
Given the input (mouse/keyboard) channel is already a small, throttled
data channel unlikely to be the bottleneck, the video feed was the prime
suspect -- specifically, the agent was capturing at *native* screen
resolution with no cap, meaning a 1440p/4K monitor was encoding and
transmitting far more pixel data per frame than necessary, which is a
classic cause of choppy-feeling remote control (this is why AnyDesk/
TeamViewer/Parsec all cap capture resolution rather than sending native).
Picked two of three suggested fixes to try first, deferring further
tuning until real numbers are in:

- **Capture resolution cap + higher frame rate target**
  (`AgentView.tsx`'s `getDisplayMedia` call): now requests
  `1920x1080 @ 60fps` (was uncapped resolution @ 30fps). The resolution
  cap is what actually makes 60fps achievable without exploding bandwidth
  -- doubling frame rate while *also* leaving resolution uncapped on a
  high-res monitor would have made things worse, not better.
- **`degradationPreference: 'maintain-framerate'`** on the video sender's
  encoding parameters, alongside bumping `maxBitrate` 4Mbps -> 6Mbps to
  give the higher frame rate headroom. Without this, WebRTC's default
  bandwidth-adaptation ('balanced') will trade off *both* resolution and
  frame rate under pressure -- for a control session, a choppy-but-sharp
  frame is worse than a soft-but-smooth one, so frame rate is now
  explicitly protected first.
- **Mouse-move throttle tightened** 33ms -> 16ms (`ControllerSession.tsx`)
  to match the new 60fps target -- the video being smoother doesn't help
  if cursor position updates are still capped at ~30/sec.
- **Real stats readout** (`shared/webrtc/useVideoStats.ts`): polls
  `RTCPeerConnection.getStats()` every second for the inbound video RTP
  stats (actual fps, resolution, and a computed bitrate from the
  `bytesReceived` delta between samples) and shows it as a small badge
  next to the connection-type badge in the session header, e.g. "58fps ·
  1920×1080 · 5.2 Mbps". This answers "is it actually achieving what was
  asked, or is something else limiting it" with real numbers instead of
  guessing -- e.g. distinguishes "capped by my own settings" from
  "bandwidth-limited" from "something else entirely (CPU encode limits,
  capture overhead)".
- Tracking the peer connection as React state (`activePc`, alongside the
  existing `pcRef`) was necessary for the stats hook's effect to actually
  re-run when the connection is replaced -- mutating a ref doesn't trigger
  a re-render on its own, so `useVideoStats` would otherwise keep polling
  a stale (or the very first) connection object forever.
- Hit one linter-flagged React anti-pattern while writing the hook: calling
  `setState(null)` synchronously inside an effect body (to reset stats
  when `pc` goes null) triggers cascading renders. Fixed by deriving the
  exposed value at render time (`return pc ? stats : null`) instead of
  mutating state to represent "no active connection."

Deferred: the third original suggestion (letting quality/resolution be
adjustable, or auto-tuning based on the new stats readout) until the user
reports back what the actual fps/bitrate numbers look like in practice.

## Special keyboard shortcuts: Cmd mapped to the wrong key entirely

Asked to check on special shortcuts specifically. Found a real, previously
unnoticed bug rather than a missing feature: `keyMap.ts`'s `CODE_TO_KEY`
mapped `MetaLeft`/`MetaRight` (Cmd on a Mac keyboard) to
`Key.LeftSuper`/`Key.RightSuper` -- nut.js's *literal Windows key*. Since
the agent is always Windows, this meant Cmd+C, Cmd+V, Cmd+Z, Cmd+A,
Cmd+S, Cmd+F -- the shortcuts anyone controlling from a Mac reaches for
by muscle memory -- were injecting "Windows key + letter" on the remote
machine the whole time, which does nothing useful (or occasionally
something unrelated, like Win+C's Windows-version-dependent behavior).
This had gone unnoticed because everything *tested* up to this point had
been mouse/typing/video-focused, not modifier combos.

**Fix**: `MetaLeft`/`MetaRight` now map to `Key.LeftControl`/
`Key.RightControl` instead. This is the same default every other
cross-platform remote-desktop tool ships -- copy/paste/undo/etc. working
is far more commonly needed than sending a literal Windows-key shortcut
from a Mac. Trade-off, stated plainly: there's now no way to send an
actual Windows-key combo (Win+D, Win+E, Win+L) from a Mac's Cmd key. Not
addressed further since nobody's asked for that yet.

**Also added while in this file**: media key mappings that nut.js
already supports but weren't wired up --
`AudioVolumeMute/Down/Up`, `MediaPlayPause`, `MediaStop`,
`MediaTrackNext/Previous` (real `KeyboardEvent.code` values, present on
Mac keyboards as Fn-modified F-keys) -> `Key.AudioMute` / `AudioVolDown`
/ `AudioVolUp` / `AudioPlay` / `AudioStop` / `AudioNext` / `AudioPrev`.

**Known limitations, not bugs, worth stating explicitly**:
- **Ctrl+Alt+Delete cannot be injected by any user-mode software**,
  including nut.js -- Windows routes that combo to the secure desktop
  specifically to prevent this. Already flagged in the original plan's
  known-risks section; would need a signed Windows service running in
  the right session to work around, well out of scope here.
- **Cmd+Tab, Cmd+Space (Spotlight), and similar macOS system-level
  shortcuts never reach this app's renderer at all** -- macOS's window
  server intercepts them before any application's keydown handler sees
  them, remote-control app or not. Same is true for every other
  remote-desktop tool.
- **Cmd+Q / Cmd+W could quit or close the controller app itself** rather
  than reaching the remote machine -- there's no custom
  `Menu.setApplicationMenu()` in this app, so Electron's default macOS
  menu (with standard Quit/Close/Minimize accelerators) is active. That
  same default menu is also *why* Cmd+C/V/X/A/Z already work for local
  text fields (the rename input, PIN field) in the first place -- macOS
  Electron apps need an Edit menu with `role: 'copy'/'paste'/etc.` for
  those to function at all in `<input>` elements, so removing the whole
  menu to fix the Cmd+Q risk would break local field editing as a side
  effect. Left as-is; flagged rather than "fixed" since a real fix needs
  either scoping Quit/Close out of the default menu specifically or
  guarding it with a confirmation while a session is active -- not done
  without the user confirming they actually want that trade-off.

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
