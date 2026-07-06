# Input elevation plan — inject into Task Manager, UAC, lock screen

Status: **PLANNED, not started.** Owner picked the full SYSTEM-service route
(2026-07-07) after hitting "open Task Manager → mouse dies instantly".

## The problem (why the mouse dies on Task Manager)

Not our bug — a Windows security boundary called **UIPI (User Interface
Privilege Isolation)** combined with **integrity levels**:

- Our agent + input-helper run at **medium integrity** (normal user rights).
- **Task Manager, any app run "as administrator", the UAC consent dialog, the
  Ctrl+Alt+Del / lock screen** run at **high integrity** or on the isolated
  **secure desktop** (owned by Winlogon/SYSTEM).
- Windows silently **drops `SendInput` from a lower-integrity process aimed at a
  higher-integrity window**. So the moment Task Manager takes focus, our
  injected mouse/keyboard events are discarded — the cursor "dies" until focus
  leaves it. Parsec/AnyDesk hit the exact same wall and solve it the same way:
  a service running as **LocalSystem**.

Two distinct sub-cases, important because they need different amounts of work:

| Trigger | Desktop | Video (user-session capture) | Input (needs) |
|---|---|---|---|
| Task Manager via **Ctrl+Shift+Esc**, "run as admin" apps | **Default** (normal) | ✅ already visible | high-integrity injector |
| **Ctrl+Alt+Del**, UAC consent, lock screen | **secure desktop** (Winlogon) | ❌ black/frozen (can't capture) | injector must switch desktops |

The SYSTEM service **fully** fixes the first row (video already works, only input
was blocked). For the second row it fixes **input** but the **screen stays
frozen** until we ALSO move capture to SYSTEM (bigger, separate future work —
see "Known limitation" below).

## Goal

Injected input lands on: Task Manager, elevated apps, the UAC consent prompt,
Ctrl+Alt+Del, and the lock screen — i.e. a high-integrity injector that follows
whatever desktop currently has input focus.

## CRITICAL: session-0 isolation (why a service alone can't inject)

A Windows **service runs in session 0**, a separate, non-interactive session
from the logged-in user (session 1+). Session 0 has its OWN window station
(`Service-0x0-3e7$`), not the interactive `WinSta0`. Consequences the first
draft of this plan got wrong:

- A session-0 thread **cannot** `SetThreadDesktop` onto the user's `Default`
  (or `Winlogon`) desktop — those live in a different session's window station.
  `SendInput` from session 0 lands nowhere the user can see.
- To inject into the interactive session you must have a process **running
  inside that session**. Only SYSTEM (via `WTSQueryUserToken` +
  `CreateProcessAsUser`) can spawn one there on demand.
- Only **SYSTEM** integrity (not merely "administrator") can `OpenDesktop`
  the **Winlogon** secure desktop with switch rights — that's the whole reason
  we need a service, not just "run the agent as admin".

So the real Parsec/AnyDesk shape is **two processes**, not one:

```
Controller(Mac) --WebRTC--> input-helper (session 1, MEDIUM)   [network endpoint, unchanged]
                                   |  named pipe (both ends in session 1 -> trivial ACL)
                                   v
                       injector-in-session (session 1, SYSTEM/high)   [does SendInput]
                                   ^  spawned + respawned via CreateProcessAsUser
                                   |
                       Input Service (session 0, LocalSystem)   [launcher/supervisor only]
```

### Components

1. **Input Service (session 0, LocalSystem, `Start=auto`)** — a *launcher*, it
   never injects itself. Responsibilities:
   - Enable `SeTcbPrivilege` / `SeAssignPrimaryTokenPrivilege` (SYSTEM has them).
   - `WTSGetActiveConsoleSessionId()` → the current interactive session; watch
     for changes (fast-user-switch, logon/logoff) and re-target.
   - `WTSQueryUserToken(sessionId, &hUserToken)` → duplicate it
     (`DuplicateTokenEx`, primary) → **`CreateProcessAsUserW`** to spawn the
     injector-in-session **as SYSTEM but inside session 1**, attached to
     `WinSta0\Default`.
   - Respawn the injector if it exits or the active session changes.

2. **injector-in-session (session 1, SYSTEM/high integrity)** — the process that
   actually injects. Responsibilities:
   - Host the named pipe `\\.\pipe\personal-remote-input` (both it and the
     helper are in session 1, so a default ACL already lets the interactive user
     connect — no custom SDDL needed; pipe-squatting hardening is a TODO).
   - Read length-prefixed JSON `RemoteInputMessage`s.
   - **Desktop follow**: before injecting, `OpenInputDesktop(0, FALSE,
     GENERIC_ALL)` → if its name (`GetUserObjectInformationW`/`UOI_NAME`)
     changed since last, `SetThreadDesktop` to it (flips `Default`↔`Winlogon`
     around UAC/lock), close the old handle. Same thread does the `SendInput`.
   - Inject via **raw `SendInput`** for BOTH mouse and keyboard (see
     `src/input-service/rawInject.ts`) — NOT nut.js: SetThreadDesktop only
     retargets the calling thread, and nut.js does its own thing that won't
     respect it. Mouse uses absolute normalized coords
     (`MOUSEEVENTF_ABSOLUTE|VIRTUALDESK`, x/y × 65535) so no screen-size query.

3. **input-helper (session 1, MEDIUM, existing)** — unchanged on the network
   side. Change: instead of calling koffi `SendInput` directly, connect to the
   pipe and **forward** each `RemoteInputMessage` (see
   `src/input-helper/serviceClient.ts`). **Fallback**: if the pipe isn't there
   (service not installed / injector not up yet), inject locally as today
   (medium integrity) — a machine without the service still controls
   non-elevated windows. Never a hard dependency.

4. **Installer / lifecycle** — service installed once (needs admin):
   - electron-builder **NSIS** runs elevated → `scripts/install-input-service.ps1`
     (`sc create`, LocalSystem, auto-start, set the ELECTRON_RUN_AS_NODE env via
     the service's `Environment` registry key); uninstall reverses it.
   - Runtime self-heal: if the agent starts and the service is missing, offer a
     one-click "enable full control" that elevates (UAC once) and installs it.

### Language / reuse decision (open)

- **Option 1 — reuse the Node/koffi injector as the service.** The service is a
  small Node entrypoint (the input-helper's injector module) run under a service
  wrapper, doing `OpenInputDesktop`/`SetThreadDesktop`/`SendInput` via koffi.
  Pro: reuse verified injection code (Thai-unicode path, scan codes) 1:1. Con:
  shipping a Node runtime as a SYSTEM service + service wrapper is heavier and
  another koffi-in-a-new-context risk (golden rule #1).
- **Option 2 — tiny dedicated native service** (Rust/C++/Go) doing only pipe +
  desktop-switch + SendInput. Pro: small, robust, no Node-as-service. Con:
  re-implement + re-verify the injection details (Thai text, scan codes) that
  took real effort to get right.
- **Lean:** start by trying Option 1 (reuse), fall back to Option 2 if the
  Node-as-SYSTEM-service route proves flaky on real hardware.

## Golden-rule gates (do NOT skip)

- Everything here is native/FFI + a privileged security surface → **golden rule
  #1: PRERELEASE first, verify on the real Windows machine** before any full
  release. A bad desktop-switch/SendInput loop as SYSTEM is far worse than the
  medium-integrity version.
- Build Windows only via `scripts/build-win.sh` (golden rule #3).
- The named-pipe ACL is the whole security story — get it tight (interactive
  user + SYSTEM only). An open pipe = any local process can synthesize input as
  SYSTEM.
- Keep the local-inject fallback so a failed/absent service never makes the app
  worse than today.

## Known limitation (documented, deferred)

Even with input working on the secure desktop, **video stays frozen during UAC /
Ctrl+Alt+Del / lock** because capture still runs in the user session and can't
see the secure desktop. Full secure-desktop VIDEO needs SYSTEM-level capture
(DXGI in session 0 / a capture helper in the service) — a separate, larger
project. The owner's actual pain (Task Manager via Ctrl+Shift+Esc) is on the
NORMAL desktop, so it's **fully** fixed by this plan (video already works there);
the secure-desktop rows are a bonus that lands input-only for now.

## Phasing (each phase verified on real hardware before the next)

De-risk the native FFI in the order it's most likely to break. Log everything to
`%TEMP%\input-service.log` / the injector's own log.

0. **`rawInject.ts` standalone (session 1, MEDIUM)** — prove raw `SendInput` for
   mouse (absolute) + keyboard (VK/scan/unicode) works from a plain user-session
   Node process, matching today's nut.js+injectorWin32 behavior (Thai text,
   shortcuts, wheel). No pipe, no service. Cheapest thing that can be wrong;
   nail it first. This file is written already (UNTESTED) — start here.
1. **Pipe forward (both ends session 1, MEDIUM)** — helper → `serviceClient.ts`
   → a plain session-1 process hosting the pipe → `rawInject`. Still medium
   integrity (won't beat Task Manager yet), but proves the transport + framing +
   fallback end to end without any service/token complexity.
2. **Service launches injector as SYSTEM-in-session** — the hard part:
   `WTSQueryUserToken` + `DuplicateTokenEx` + `CreateProcessAsUserW` from the
   session-0 service, injector attaches to `WinSta0\Default`. Verify Task
   Manager (Ctrl+Shift+Esc) + a "run as admin" app NOW take input.
3. **Desktop follow**: `OpenInputDesktop`/`SetThreadDesktop` watcher → verify UAC
   consent + lock screen take input (video still frozen there, expected).
4. **Hardening**: active-session change (fast-user-switch) re-targeting,
   injector crash-respawn, pipe-squatting check, uninstall cleanup, PRERELEASE →
   real-hardware sign-off → full release.

## Handoff status (2026-07-07, prepared on the Mac, ALL UNTESTED)

Written for Windows-Claude to build + test — **none of it has run on Windows**;
treat every FFI signature as a hypothesis until a real round confirms it
(golden rule #1). Nothing is wired into the shipping build yet (SAFETY BAR).

- `src/input-service/rawInject.ts` — raw SendInput mouse+keyboard (phase 0).
- `src/input-service/win32Session.ts` — koffi bindings + `syncInputDesktop()`
  implemented; `spawnInjectorInSession()` scaffolded with the exact call
  sequence + signatures (phase 2/3).
- `src/input-service/protocol.ts` — length-prefixed JSON pipe framing.
- `src/input-service/index.ts` — injector-in-session entry (pipe server + loop).
- `src/input-service/service.ts` — session-0 launcher entry.
- `src/input-helper/serviceClient.ts` — helper-side forward-or-fallback.
- `scripts/install-input-service.ps1` / `uninstall-input-service.ps1`.
- `src/input-service/README.md` — build/run/test notes for each phase.

## Cross-refs

- Injection details + libnut/koffi background: `docs/native-input-plan.md`,
  `src/input-helper/`.
- Golden rules + release flow: `CLAUDE.md`.
