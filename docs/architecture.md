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
    controller/ControllerView.tsx   real controller UI: pairing form, renders video
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
- **Phase 5** (input over data channel, full remote-control loop): not started.
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
