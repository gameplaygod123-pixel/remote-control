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

## Architecture (Parsec/AnyDesk model)

```
Controller (Mac) --WebRTC input pc--> input-helper (Windows, user session, medium)
                                           |
                                           |  named pipe (RemoteInputMessage)
                                           v
                                  Input Service (LocalSystem, session 0)
                                           |  OpenInputDesktop + SetThreadDesktop
                                           v
                                  SendInput on the ACTIVE desktop
```

Keep the network endpoint where it is; move ONLY the injection call across the
privilege boundary. Minimal blast radius.

### Components

1. **Input Service** — a new long-lived process installed as a Windows Service,
   `Start=auto`, account **LocalSystem**. Responsibilities:
   - Create a named pipe `\\.\pipe\personal-remote-input` with a tight security
     descriptor: allow the **interactive user** to connect+write, SYSTEM full,
     nobody else.
   - Read length-prefixed JSON `RemoteInputMessage`s (same shape as today:
     move/down/up/wheel/keydown/keyup/text).
   - **Desktop switching** before each inject (or on a change watcher):
     - `WTSGetActiveConsoleSessionId()` → the interactive session.
     - `OpenInputDesktop(0, FALSE, GENERIC_ALL)` → a handle to whatever desktop
       currently receives input (flips to `Winlogon` on the secure desktop).
     - `SetThreadDesktop(hDesk)` on the injecting thread, then `SendInput`.
     - Re-open/re-attach when the input desktop changes (cheap to re-check; the
       secure desktop appears/disappears around UAC prompts).
   - Injection itself is the **same Win32 calls we already use** (`SendInput`
     with `KEYEVENTF_UNICODE` for text, VK + `MapVirtualKeyW` scan codes for
     held keys/shortcuts, mouse move/click/wheel).

2. **input-helper (existing, user session)** — unchanged on the network side
   (owns the node-datachannel input pc, clipboard, liveness). Change: instead of
   calling koffi `SendInput` **directly**, it connects to the service's named
   pipe and **forwards** each `RemoteInputMessage`. Fallback: if the pipe isn't
   available (service not installed / stopped), inject locally as today (medium
   integrity) so a machine without the service still works for non-elevated
   windows — graceful degradation, never a hard dependency.

3. **Installer / lifecycle** — the service is installed once (needs admin):
   - electron-builder **NSIS** installer already runs elevated → install +
     start the service at app install, remove it on uninstall.
   - Also a runtime self-heal: if the agent starts and the service is missing,
     offer a one-click "enable full control" that elevates (UAC once) and
     installs it.

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

## Phasing

1. **Service skeleton**: install/uninstall via NSIS, LocalSystem, named pipe up,
   log to `%TEMP%`. No injection yet — prove lifecycle + pipe ACL.
2. **Inject on Default desktop**: forward from helper → service → SendInput.
   Verify Task Manager (Ctrl+Shift+Esc) + a "run as admin" app now take input.
3. **Desktop switching**: OpenInputDesktop/SetThreadDesktop watcher → verify
   UAC consent + lock screen take input (video still frozen there, expected).
4. **Hardening**: fallback-to-local-inject, service crash-respawn, ACL review,
   PRERELEASE → real-hardware sign-off → full release.

## Cross-refs

- Injection details + libnut/koffi background: `docs/native-input-plan.md`,
  `src/input-helper/`.
- Golden rules + release flow: `CLAUDE.md`.
