# input-service — elevated input injection (Windows)

**Status: PLANNED / handoff scaffold. NONE of this has run on Windows.** Prepared
on the Mac for Windows-Claude to build + test. Full design + rationale:
[`docs/input-elevation-plan.md`](../../../../docs/input-elevation-plan.md).

Fixes "open Task Manager → mouse dies": our medium-integrity injector can't
`SendInput` into high-integrity windows (Task Manager, admin apps, UAC, lock).
This adds a SYSTEM path that can.

## Why two processes (read this first)

A Windows **service runs in session 0** and physically cannot reach the logged-in
user's desktop. So:

- `service.ts` — session-0 **launcher** (LocalSystem). Spawns/respawns the
  injector into the interactive session via `CreateProcessAsUserW`. Never injects.
- `index.ts` — **injector-in-session** (SYSTEM, high integrity, inside session 1).
  Hosts the pipe, follows the active desktop, does the `SendInput`.
- `serviceClient.ts` (in `../input-helper/`) — the medium-integrity helper
  forwards input over the pipe; **falls back to local injection** if the service
  isn't there.

```
helper (session1, medium) --pipe--> injector (session1, SYSTEM) --SendInput--> active desktop
                                        ^ spawned by
                                     service (session0, LocalSystem)
```

## Files

| file | role | state |
|---|---|---|
| `rawInject.ts` | raw SendInput mouse+keyboard | written, UNTESTED |
| `protocol.ts` | length-prefixed JSON pipe framing | written |
| `win32Session.ts` | `syncInputDesktop()` (done) + `spawnInjectorInSession()` (scaffold) | mixed |
| `index.ts` | injector-in-session entry (pipe server + inject loop) | written, UNTESTED |
| `service.ts` | session-0 launcher/supervisor | written, scaffold |
| `../input-helper/serviceClient.ts` | helper forward-or-fallback (gated) | written |
| `../../../scripts/{install,uninstall}-input-service.ps1` | service lifecycle | written, UNTESTED |

## Build

WIRED into electron-vite (2026-07-07) as two Node-target entries, mirroring the
input-helper — verified `pnpm build` emits them on macOS:

- `service.ts`  → `out/main/input-service.js`   (session-0 launcher)
- `index.ts`    → `out/main/input-injector.js`  (SYSTEM injector-in-session)

They are always built but **inert** — nothing spawns them; the default runtime
is byte-identical (SAFETY BAR). koffi is externalized (required at runtime from
node_modules), same as the helper. `install-input-service.ps1` should point
`-ScriptPath` at the packaged `.../out/main/input-service.js`; the launcher finds
the injector as its `input-injector.js` sibling automatically.

STILL TODO for Windows-Claude: confirm `scripts/build-win.sh` packs koffi for the
win32 target for these entries too (it already does for the helper), and keep
asar disabled (golden rule #6).

## Test order (matches plan phases — verify each before the next)

Golden rule #1: this is native FFI; a wrong koffi struct/signature **segfaults**
(JS try/catch can't catch it). Ship as PRERELEASE only after real-hardware
sign-off. Logs: `%TEMP%\input-service.log` (the SYSTEM service's TEMP is
`C:\Windows\Temp`).

- **Phase 0** — run `rawInject` from a plain user-session Node script; confirm
  mouse (absolute move, buttons, wheel) + keyboard (Thai text, Ctrl+C, held
  keys) match today's behavior. Tune `WHEEL_DELTA`.
- **Phase 1** — host `index.ts`'s pipe server as a normal user process; set
  `PR_INPUT_SERVICE=1` on the agent; confirm the helper forwards and input still
  works on normal windows (still medium integrity — Task Manager NOT yet).
- **Phase 2** — implement `spawnInjectorInSession()` (the WTSQueryUserToken +
  DuplicateTokenEx + CreateProcessAsUserW plumbing — the riskiest FFI; wire it
  step by step logging every GetLastError). Install via the ps1. Confirm Task
  Manager (Ctrl+Shift+Esc) + a run-as-admin app now take input.
- **Phase 3** — verify `syncInputDesktop()` flips to `Winlogon`: UAC consent +
  lock screen take input (video stays frozen there — expected, that's a separate
  SYSTEM-capture project).
- **Phase 4** — hardening: active-session change re-target, injector
  crash-respawn, pipe-squatting check, uninstall cleanup.

## Env flags

- `PR_INPUT_SERVICE=1` on the **agent** — helper forwards to the pipe instead of
  local inject. Off/absent = today's behavior, byte-identical.
