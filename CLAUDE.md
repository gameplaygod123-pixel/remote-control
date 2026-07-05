# Personal Remote — Claude working notes

Parsec-like personal remote desktop (Electron + WebRTC). Owner is the sole user
for now (family multi-controller use planned). Owner speaks Thai — reply in Thai.

**Keep this file current: at the end of every working session, update the
"Current status" and "Backlog" sections below and commit, so a fresh chat on
either machine can resume without re-explaining anything.**

## Machines & division of labor

- **Mac** (this repo's home): controller + infrastructure hub — signaling server,
  cloudflared tunnel, supervisor LaunchAgent (`com.personalremote.signaling`),
  source of truth. Mac-side Claude reviews, merges, builds, releases.
- **Windows PC**: the agent (controlled machine). Has its own Claude Code for
  implementing/testing anything that needs real Windows hardware. Works on
  `fix/*` branches and pushes; Mac side merges.
- Diagnostics: agent-side helper log at `%TEMP%\input-helper.log`;
  signaling log at `~/Library/Logs/personal-remote-signaling.log` (Mac).

## Golden rules (learned the hard way — do not skip)

1. **Native/FFI code (koffi Win32 calls, node-datachannel) MUST ship as a
   PRERELEASE first** and be verified on the real Windows machine. A bad FFI
   signature segfaults natively; JS try/catch cannot catch it. v1.15.0 shipped
   untested Win32 clipboard FFI → helper crash-respawn loop → v1.15.1 revert.
2. Everything else ships directly as a **full release** (auto-update) while the
   owner is the only user. Reinstate the prerelease gate when family joins.
3. Build Windows installers ONLY via `scripts/build-win.sh` — it requires
   `VITE_SIGNALING_URL`, swaps the node-datachannel darwin→win32 binary, and
   verifies koffi/node-datachannel win32 binaries are packed. v1.11.0 shipped
   pointing at localhost because this was skipped.
4. Never add unverified ICE servers. libjuice picks ONE stun server per attempt
   with no fallback — a dead server (openrelay was) makes sessions fail
   alternately. Current: Google + Cloudflare STUN, both verified.
5. `koffi.load()` must be lazy (inside functions), never at module scope — it
   crashes the Mac controller at import time.
6. asar is disabled on purpose (the pure-Node input helper can't read asar).
7. Release flow: `gh release create --prerelease` → owner tests on real
   hardware (connect/Back cycles, Thai+English typing, X-close mid-session) →
   `gh release edit --prerelease=false`.

## Architecture crib notes

- **Core constraint**: Chromium throttles the ENTIRE Electron process (main
  process included — timers and socket I/O) when the agent window is hidden.
  Anything that must survive window-hide lives in the pure-Node **input helper**
  (`src/input-helper/`, forked with `ELECTRON_RUN_AS_NODE=1`, uses
  node-datachannel). Renderer keeps video + file-transfer.
- Two peer connections: video pc (renderer↔renderer) and input pc
  (controller renderer ↔ helper). Signaling messages carry
  `channel: 'video' | 'input'`; capability negotiation via `caps:
  ['input-helper']` on pair/connection messages (old servers strip unknown
  fields → graceful fallback).
- Input injection on Windows: raw `user32.SendInput` via koffi —
  `KEYEVENTF_UNICODE` for text (layout-independent Thai), VK + scan codes
  (MapVirtualKeyW) for held keys/shortcuts. libnut keyboard silently no-ops
  from windowless processes; mouse still uses nut.js.
- Self-healing: helper retries negotiation 3× then exits → host respawns
  (2s); ping/pong liveness (10s/5s); controller rebuilds input pc on every
  input-channel offer; agent drops video pc on helper-down → auto re-pair.
- Signaling URL is resolved at runtime from `signaling-url.json` on GitHub
  (raw.githubusercontent.com, ~5-min CDN cache), re-resolved on every
  reconnect; the supervisor auto-publishes tunnel URL changes.

## Current status (updated 2026-07-06)

Latest release: **v1.19.3** (file-transfer picker fix: hidden <input type=file> .click() does not open the dialog in this Electron build → switched to main-process dialog.showOpenDialog + file:read IPC; send takes a SendableFile interface). v1.19.2 = chosen-files list. v1.19.1 = live send button + select-all + zip hint. v1.19.0 = (controller sidebar + multi-machine file-transfer page: headless per-target pushes via pushFilesToDevice — no caps advertised so agents serve the legacy file channel; roster gained optional os/lastSeenAt; CAVEAT: pushing to a machine mid-session kicks that session). v1.18.3 = Parsec-style floating session controls. v1.18.2 = single-instance lock (relaunch surfaces the running window). v1.18.1 = UI pass 2: agent preview box removed, agent window fixed 680×700; controller stays resizable). v1.18.0 = titlebar (OS bar hidden, single app-drawn bar
with centered title — start of the owner's UI-redesign push; shared
`TitleBar` component; Windows uses titleBarOverlay whose 38px height must
match `.app-titlebar`). v1.17.1 = CSP hotfix (confirmed on the real Windows
agent); v1.17.0 = house token; v1.16.0 = clipboard-in-helper.

Working and verified on real hardware:
- Latency ≈ Parsec (direct connection, ~11 ms network).
- Mouse + keyboard survive agent window hidden/X-closed (native helper).
- Thai/English typing + shortcuts; Windows grave `~` layout toggle.
- Typed language follows the CONTROLLER machine's layout (deliberate design —
  each user switches language on their own machine).
- File transfer controller→agent (tested with a 580 MB file).
- Auto-update via GitHub Releases; signaling self-heals via supervisor.

Also working since v1.16.0:
- **Clipboard sync survives the agent window hiding** — runs in the input
  helper on the helper's pc (`clipboardNative.ts` + shared
  `clipboardSyncCore.ts`). The v1.15.0 segfault's root cause: koffi's `str16`
  is a POINTER type, so encode/decode stored a transient koffi buffer pointer
  in clipboard memory instead of the text (→ dangling-pointer crash AND
  cross-app paste never actually worked). Fix: inline UTF-16 code units via
  `koffi.array('uint16', n)`, reads bounded by `GlobalSize`, chunked string
  building, `OpenClipboard(null)`. NOTE for future clipboard tests: the owner
  sometimes runs Parsec, whose clipboard sync masks ours — close it first.
  Cosmetic nit for later: helper's `clipboard.onopen` log is overwritten by
  runClipboardSync, never prints.

Since v1.17.0 — **house token** (one shared secret per household):
- Gates register-agent, pair-request (checked BEFORE the PIN — no guessing
  oracle), list-devices (roster leaks names + live thumbnails), and
  remove-device. A wrong/rotated token routes the app back to the
  first-launch token screen via the new `server-error` message.
- Entered once per machine (TokenSetupView on first launch), persisted in
  userData `house-token.txt`; nothing secret is baked into builds anymore
  (`VITE_AGENT_TOKEN` is gone). Dev falls back to `dev-token-change-me`
  (unpackaged only); `HOUSE_TOKEN` env overrides for harnesses.
- The real token lives ONLY in: the LaunchAgent plist
  (`~/Library/LaunchAgents/com.personalremote.signaling.plist`,
  EnvironmentVariables.AGENT_TOKEN), a backup at
  `~/.personal-remote-house-token` (mode 600), and each machine's userData.
  NEVER commit it. Rotating it = edit plist → restart LaunchAgent → kill any
  stray server on 8080 → every machine re-enters via the auto-shown screen.
- Ops gotcha (2026-07-06): a leftover `tsx watch` DEV server was holding
  port 8080, so the supervisor had never spawned its real `dist/index.js` —
  production was silently running dev code with the default token. After
  changing server code: `pnpm --filter signaling-server build`, kill
  whatever holds 8080, let the supervisor's 60s ensureServer respawn it.
- Verified: 9/9 local enforcement tests + live server rejects the old
  default and accepts the new token.

**v1.17.1 CSP incident (2026-07-06) — big lesson:** the renderer CSP
(`connect-src 'self' ws: wss:`) had no `https:` source, so the packaged
app's fetch of `signaling-url.json` from raw.githubusercontent.com was
silently CSP-blocked since the mechanism shipped (v1.13) — the resolver
swallows failures and falls back to the build-time URL, so it only LOOKED
like dynamic URL resolution worked. First tunnel rotation after v1.17.0
bricked every installed app ("disconnected, reconnecting..." forever).
Lessons:
- Dev couldn't catch it (DEV mode skips the fetch). To test the real
  production network path on the Mac: `npx electron out/main/index.js` with
  `APP_MODE=agent` after `npm run build`, ideally with a deliberately dead
  `VITE_SIGNALING_URL` so only the GitHub path can succeed. NOTE: running
  electron against a bare file uses `~/Library/Application Support/Electron/`
  (not `desktop/`) for userData — seed house-token.txt there.
- Windows-side Claude can diagnose installed-app issues by reading the
  packed bundle under the install dir (CSP, baked constants) — no DevTools
  needed.
- A fallback that silently swallows failures hides dead code paths for
  months. Prefer logging/telemetry when a primary path falls back.
- Old (pre-v1.17.0) clients that fail the token check hammer the server in
  a ~1s connect/reject loop (server closes; client backoff resets on every
  successful open). Harmless at family scale; remember when reading logs.

## Backlog (rough priority)

1. Verify file transfer with the agent window actually hidden (works via the
   renderer video pc, which is subject to throttling — needs a real test).
2. Computers-page search/sort; per-controller device visibility (family use).
3. Known limitation: helper crash mid-session recovers input only at re-pair.
4. No TURN relay (only matters for CGNAT↔CGNAT pairs).
5. Mac installer (.dmg) — deferred by owner decision.
6. Owner plans a UI redesign + playful feature additions next.
