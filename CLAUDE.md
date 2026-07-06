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

Latest release: **v1.21.2** — **glass opacity 12% → 40%** (owner asked; the
shell is more solid / less washed out) + a dev-launcher crash fix:
- **Glass opacity 12% → 40%.** `deviceList.css`
  `:root[data-theme='glass'] .ctl-shell`: `--dl-bg` .12→.40; rail .34→.55,
  card .44→.66 bumped alongside to keep the shell<rail<card readability
  hierarchy. Controller-only theme (agent stays dark), so this only changes
  the look of the Mac controller in glass mode.
- **FIX: `start-controller.command` crashed on launch when started from an
  Electron parent** (VS Code integrated terminal / Claude Code). Those parents
  export `ELECTRON_RUN_AS_NODE=1` (we set it to fork the input-helper), it
  inherits into `electron-vite dev`, and Electron then boots as plain Node —
  `electron.app` is undefined so `@electron-toolkit/utils` throws
  `Cannot read properties of undefined (reading 'isPackaged')` at import, the
  window never appears, the process exits (looks like "opens then closes
  itself"). NOT set globally (`launchctl`/`.zshrc` are clean) — pure per-process
  inheritance. Fix: the launcher now `unset ELECTRON_RUN_AS_NODE` before
  `pnpm dev`. Same root cause as the documented `env -u ELECTRON_RUN_AS_NODE`
  workaround. Verified: launching from a shell that has the var set now boots
  real Electron, window stays alive. Also `apps/desktop/.gitignore` ignores
  `*.tsbuildinfo` now.

Prior release: **v1.21.1** — **'glass' translucent see-through theme** (3rd
theme beside dark/light). The **macOS** controller window is now created
`transparent:true` **ALWAYS** (v1.21.0 gated it to the saved theme + relaunched
on toggle, but the owner runs the Mac controller via `electron-vite dev` where
`app.relaunch()`+exit just KILLS the app — the vite dev server dies with it).
Dark/light paint an opaque `.ctl-shell` over the transparent window (normal
look, rounded corners + shadow intact — verified on the real Mac), glass drops
to ~12%. So the theme toggle is fully LIVE, no relaunch, works in dev +
packaged. Verified on the real Mac: over a white window the glass shell goes
pale, over dark it stays dark (real see-through); dark theme stays opaque.
**Windows keeps opaque** because `transparent:true` breaks the titleBarOverlay
caption buttons, so glass there degrades to a solid dark tint (backgroundColor
'#171210' under the alpha) — a Windows acrylic/`backgroundMaterial` pass is a
TODO. New `GlassToggle.tsx` (droplet) in
the sidebar; `ThemeToggle` is now a CONTROLLED component — `ControllerView`
owns `theme` state and passes both toggles an `onChange`. `themeConfig` Theme is
now `'dark'|'light'|'glass'`; glass tokens live in `deviceList.css`
(`:root[data-theme='glass'] .ctl-shell` + a `body`/`#root` transparent
override). KNOWN: near-white shell text can wash out over a light wallpaper (no
text-shadow on the heading/footer yet — card name/status already have one);
owner picked 12%/no-blur in the glass-theme mockup artifact. To try on Mac:
`env -u ELECTRON_RUN_AS_NODE APP_MODE=controller ./node_modules/.bin/electron
out/main/index.js` (seed userData `theme.txt`=glass at ~/Library/Application
Support/Electron). v1.20.10 = Connect button inset 4px from the card
left/right/bottom via `.dl-btn { margin:0 4px 4px }` — dropped `width:100%` so
flex-stretch keeps it full-width-minus-margins, else it'd overflow; name
14→12, status 11→10. From a 3rd card-tuner export; the tuner grew a "ระยะปุ่ม
จากขอบ" (btnm) slider + a "ความมนจอ"/padding-min-0 pass earlier). v1.20.9 =
in-session floating control bar now starts COLLAPSED — `ControllerSession` `panelOpen` initial state `true`→`false`; on
connect you see just the small dim status-dot pill (`.session-float__toggle`,
top-center, opacity .45) and click it to expand the Back/name/stats/status
bar). v1.20.8 = thinner frame around the card's screen preview:
`.dl-card` padding 8→4, `.dl-thumb` radius 12→30 so it nests concentrically in
the 34px card corner and the screen hugs all 4 edges evenly). v1.20.7 = name +
online status are now TWO independently
placed labels over the screen — `.dl-name` at `left:2%;top:92%` (bottom-left),
`.dl-status-row` at `right:4px;top:92%` (bottom-right, right-anchored so
"online" can't clip on a narrower card); name 14px, status 11px; both
`position:absolute` inside `.dl-thumb`, no `.dl-overlay` wrapper anymore. Came
from a 2nd card-tuner export where the owner dragged name & status to separate
corners — the tuner now supports independent drag of each). v1.20.6 = card
thumbnail `object-fit: contain` — the live capture shows FULL/uncropped;
`cover` had zoomed it and clipped the left/right edges of the screen. A
streaming card gets `.dl-thumb.has-screen { background:#0d0f14 }` so contain's
letterbox bars read as a monitor bezel.
v1.20.5 rebuilt the device card from the owner's own
**card-tuner** export: name + online status now FLOAT over the screen preview
— an abs-positioned `.dl-overlay` INSIDE `.dl-thumb`, bottom-left `left:17%;
top:90%`, white text `#fff`/`#e8e0d8` with a strong outline shadow, no scrim
box — Parsec-style. Card is a fixed ~302px, `.dl-grid`
`repeat(auto-fill,minmax(258px,302px))` so it no longer stretches full-width;
card radius 34, padding 8, gap 4; thumb radius 12, aspect 16/10, still
transparent bg + live thumbnail when streaming else 28px MonitorIcon; name
12px, status 10px, Connect pill padding 8 / font 12. KNOWN weak spot: light
theme + icon-fallback (online but not yet streaming) = white text on cream,
legible via the outline shadow but not pretty; real machines stream a dark
screen so it's transient — offer theme-aware text color if it bugs the owner.
The **card-tuner artifact** (scratchpad `card-tuner.html`, favicon 🖥️) has a
canvas mock desktop + draggable text overlay + Export → owner sends the JSON,
we apply 1:1. LESSON from v1.20.3/4: don't infer card intent from screenshots
— the tuner ended the guessing loop. v1.20.4 restored the live preview
(v1.20.3 had wrongly removed it). v1.20.2 = transparent thumb bg so placeholder icon floats, 40px icon, 18px card radius, 12px rounder Connect button, bigger name/status; live thumbnails still shown when sent. v1.20.1 = taller thumbnail + ID line removed. v1.20.0 = **light mode (Amber Light) + a sliding sun/moon
theme toggle** at the bottom of the controller sidebar. The whole controller
shell themes through `--dl-*` tokens (deviceList.css); a
`:root[data-theme='light'] .ctl-shell` block redefines them. Persisted per
machine via `main/themeConfig.ts` (userData `theme.txt`, default dark);
`ThemeToggle.tsx` flips `document.documentElement.dataset.theme` + saves.
Session view + agent/setup screens stay dark for now (later pass); Windows
titleBarOverlay buttons keep their dark tint until re-themed dynamically.

The controller has an app-shell layout: a
slim icon sidebar (Computers / File Transfer) drawn by ControllerView, with a
single centered TitleBar (OS bar hidden — macOS hiddenInset traffic lights,
Windows titleBarOverlay whose 38px height must match `.app-titlebar`). A live
session takes the whole window with Parsec-style floating controls (collapsible
pill; only the ⠿ grip is a window-drag region). Recent release trail:
- v1.19.x — **multi-machine file transfer** (File Transfer page): tick online
  machines, pick (native OS dialog via `dialog:pick-files` — a hidden
  `<input type=file>` .click() does NOT open the dialog in this Electron
  build) or drop files, send to all at once. Each target = an independent
  headless `pushFilesToDevice` (own signaling+peer connection, advertises no
  caps so the agent serves the file channel on its legacy renderer path).
  Reliability (v1.19.4): progress = bytes flushed to network (offset −
  bufferedAmount), poll-based drain (the edge-triggered `bufferedamountlow`
  never fired on a 2nd consecutive send → wedged at ~18% while bytes still
  drained), 20s stall watchdog, double-send guard. Roster gained optional
  os + lastSeenAt. CAVEAT: an agent serves one controller at a time, so
  pushing to a machine mid-session kicks that session.
- v1.18.x — UI redesign pass: single centered titlebar; agent window fixed
  680×700 (preview box removed); single-instance lock (relaunch surfaces the
  running window / brings the tray agent back); floating session controls.
- v1.17.1 CSP hotfix; v1.17.0 house token; v1.16.0 clipboard-in-helper.

Working and verified on real hardware:
- Latency ≈ Parsec (direct connection, ~11 ms network).
- Mouse + keyboard survive agent window hidden/X-closed (native helper).
- Thai/English typing + shortcuts; Windows grave `~` layout toggle.
- Typed language follows the CONTROLLER machine's layout (deliberate design —
  each user switches language on their own machine).
- File transfer controller→agent, including multi-machine send from the File
  Transfer page — verified: repeated back-to-back sends, ~590 MB files.
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
