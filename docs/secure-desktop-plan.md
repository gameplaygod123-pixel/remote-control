# Secure-desktop remote control — make Track 2 TRULY usable

**Owner ask (2026-07-11):** "เอาให้ใช้งานได้จริงๆ" — lock the PC (Win+L) / hit a UAC
prompt from the remote Mac and actually **see AND control** the Windows secure
desktop, log back in, click UAC yes/no. Right now we can *control* it but not *see*
it, and it's off-by-default behind a PowerShell script — so in practice it's unusable.

This doc is the handoff brief. **Windows-Claude (WC) leads** the native + hardware
parts (MSVC, the real RTX agent, secure-desktop testing); **Mac-Claude** owns the TS
wiring, the pipe/CLI contracts, the in-app toggle UI, and review/merge. Ship per golden
rule #1 (native/FFI → PRERELEASE + real-hardware verify before any full release).

---

## Where we are today

| Capability | State |
|---|---|
| **Input** on Task Manager / run-as-admin apps (Track 1, elevated agent) | ✅ shipped v1.23.0 |
| **Input** on the secure desktop — UAC / Ctrl+Alt+Del / lock screen (Track 2, SYSTEM injector following the active desktop) | ✅ code done + proven on real hardware (owner locked screen, controlled input) |
| Track 2 permanent from the **installed** app | ⚠️ `scripts/setup-track2-permanent.ps1` exists; last full reboot-proof was partly a dev rig — must re-verify on the current v1.37.0 build |
| Enable Track 2 **without PowerShell** (in-app toggle) | ❌ not done |
| **Video** of the secure desktop (SEE the UAC / lock screen) | ❌ never started — the real blocker; input is "blind" without it |

Track 2 details + phasing: [`docs/input-elevation-plan.md`](input-elevation-plan.md)
and [`apps/desktop/src/input-service/README.md`](../apps/desktop/src/input-service/README.md).
Native capturer: [`docs/step3-dxgi-capturer.md`](step3-dxgi-capturer.md).

**The goal of this doc = close the last two rows.**

---

## Part 1 — make the INPUT side usable (fast, ships first)

Delivers "control the secure desktop for real, turned on from the app, permanent
across reboot." Blind (no video yet) but working — a quick, verifiable win before the
big video project.

### 1a. In-app toggle (Mac-Claude does the UI + IPC; WC does the elevation call)
An **agent-side** setting "อนุญาตคุมหน้าจอที่ต้องใช้สิทธิ์ผู้ดูแล (UAC / ล็อกหน้าจอ)"
that runs the equivalent of `setup-track2-permanent.ps1` on toggle-on:
- Set `PR_INPUT_SERVICE=1` as a **machine** env var (persisted — see
  [[agent-env-overrides-must-be-persisted]]; a shell `set` gets clobbered on the
  Track-1 task handoff, so it MUST be `HKLM\...\Environment` / `[Machine]`).
- Register the `PersonalRemoteInput` SYSTEM launcher task pointing at the **installed**
  `out/main/input-service.js` (reuse `install-input-service.ps1` path auto-resolve).
- Toggle-off = uninstall the task + clear the machine env var (byte-identical to today).
- The toggle needs one elevation (UAC) the first time — surface that in the UI copy.
- Persist the toggle state like the existing per-machine config files (mirror
  `pipelineConfig.ts` / `themeConfig.ts`).

**Mac-Claude:** the toggle component, the persisted-config module, the `ipcMain`
handler shape, and the Thai copy. **WC:** the actual elevated install/uninstall
(spawn the ps1 or a koffi/`schtasks`+`setx /m` sequence), and confirm it's idempotent
and reboot-permanent from the packaged `.exe`.

### 1b. Re-verify permanent-from-installed on the current build (WC)
Install the current prerelease over v1.36.0, enable via 1a's toggle, **reboot**, then
remote-test: Task Manager takes input (Track 1) AND Win+L / a real UAC prompt take
input (Track 2) with nothing set up by hand afterward. This closes the "dev rig vs
installed" gap.

### 1c. Phase 4 hardening (WC, from the README's remaining list)
- Fix B pipe trust: injector OWNS the pipe via `CreateNamedPipeW` + SDDL +
  `FIRST_PIPE_INSTANCE` (removes the same-user squat/leak on the medium-hosted pipe).
- Active-session-change re-target + injector crash-respawn.
- Uninstall cleanup (task + env + pipe) leaves no residue.

---

## Part 2 — SEE the secure desktop (SYSTEM video capture) — the real work

This is what makes it genuinely usable. Blind input on a lock/UAC screen is nearly
useless; the owner needs to see it.

### Why the video freezes today
`capturer.exe` runs in the user session on `WinSta0\Default`. When Windows switches to
the secure desktop (`Winlogon` — UAC, lock, Ctrl+Alt+Del), a Default-desktop process
loses DXGI Duplication access → `DXGI_ERROR_ACCESS_LOST` → the frame stalls. A process
can only duplicate the desktop its thread is attached to, and attaching to `Winlogon`
requires **SYSTEM**.

### The good news — we reuse ~80% of what exists
1. **The capturer already recovers from `ACCESS_LOST`** by tearing down and rebuilding
   the D3D11 device + `IDXGIOutputDuplication` (Step 3a hardening). A secure-desktop
   switch IS an `ACCESS_LOST`. So the core capture loop mostly already does the right
   thing — it just can't *access* Winlogon because it's not SYSTEM, and it doesn't
   re-point its thread desktop.
2. **We already spawn a SYSTEM-in-session process** — Track 2's `spawnInjectorInSession()`
   (`win32Session.ts`) does the token dance + `CreateProcessAsUserW` into session 1 at
   high integrity. Generalize it to spawn `capturer.exe` too.
3. **We already follow the active desktop as SYSTEM** — `syncInputDesktop()` /
   `OpenInputDesktop` + `SetThreadDesktop` in the injector. Same primitive the capturer
   needs on each switch.
4. **We already have a named-pipe transport across the integrity boundary** — the Track 2
   input pipe (`protocol.ts` framing + helper-hosts/SYSTEM-connects role split). Reuse
   the exact role split for the video stream.

So the missing native work is smaller than it looks: **run the capturer as
SYSTEM-in-session, and in its existing ACCESS_LOST recovery, `SetThreadDesktop` to the
current input desktop before re-creating the duplication.** That's the Sunshine/Parsec
model.

### Architecture (layered, keeps the normal path safe)

```
NORMAL (no Track 2 / service down):
  video-sender (user session) --spawns--> capturer.exe (child, stdout) --> RTP
  # today's path, BYTE-IDENTICAL, no secure-desktop video. Safety net.

SECURE-DESKTOP CAPABLE (Track 2 installed + enabled):
  PersonalRemoteInput launcher (SYSTEM, session 0)
        --CreateProcessAsUserW--> capturer.exe (SYSTEM-in-session 1, HIGH)
              | follows active desktop (Default <-> Winlogon), DXGI+NVENC
              | writes Annex-B to a NAMED PIPE
              v
  video-sender (user session) CONNECTS to the pipe as its FrameSource --> RTP
```

- The SYSTEM capturer is the **sole source** when present (so Default and Winlogon both
  come from the one process that can see both — no seam on the switch). If the SYSTEM
  capturer isn't available, the sender falls back to spawning the user-session capturer
  child exactly as today.
- **Pipe role split = same as Track 2 input:** the **user-session sender HOSTS** the
  pipe, the **SYSTEM capturer CONNECTS** and writes the stream (SYSTEM can open any
  user-owned pipe; a SYSTEM-hosted pipe would deny the medium sender — the Fix-A lesson,
  README §"Fix A"). Later tighten with Fix B SDDL.
- The receiver (Mac) is **UNCHANGED** — same Annex-B / RTP contract. The switch to the
  secure desktop is just new frames; VideoToolbox keeps decoding. (It may need a forced
  IDR right after a desktop switch — the capturer already emits a fresh IDR after any
  ACCESS_LOST rebuild, so this should be free. Verify the receiver re-syncs cleanly.)

### The native change, concretely (WC)
1. **`capturer.exe` new mode `--desktop-follow`** (or auto when launched by the SYSTEM
   task): before creating the DXGI duplication, and on every `ACCESS_LOST`, do
   `HDESK h = OpenInputDesktop(0, FALSE, GENERIC_ALL); SetThreadDesktop(h);` then
   recreate D3D11 device + `DuplicateOutput`. Log each desktop switch to stderr
   (`[capturer] desktop -> Winlogon`). This is the crux — verify DXGI Duplication +
   NVENC actually initialize while attached to `Winlogon` as SYSTEM-in-session.
2. **Output to a pipe** instead of stdout when in this mode: `--output pipe:\\.\pipe\pr-capturer-<id>`
   (connect as client, write the same binary Annex-B / 4-byte start codes / in-band
   SPS-PPS / flush-per-frame contract as stdout mode). stdin control (`I`=IDR, `B<kbps>`,
   the existing commands) also over the pipe or a second control pipe — Mac-Claude will
   fix the exact contract with you before you build (mirror `capturerArgs.ts`).
3. **Generalize `spawnInjectorInSession()`** to spawn an arbitrary exe+args as
   SYSTEM-in-session, so the launcher can start the capturer the same proven way.
4. **NVENC-as-SYSTEM risks to check early** (golden rule #1): D3D11 device creation and
   `nvEncOpenEncodeSessionEx` succeeding while SYSTEM-in-session and while attached to
   `Winlogon`; NVENC session-count limits if both a user-session capturer and the SYSTEM
   one ever run at once (they shouldn't — sole-source — but guard it); GPU/adapter
   enumeration returning the same output. Fail LOUD to stderr with `GetLastError` /
   NVENC status, never a silent black frame.

### The TS wiring (Mac-Claude)
- New `SystemCapturerFrameSource` in `frameSource.ts`: HOSTS the named pipe, waits for
  the SYSTEM capturer to connect, reads the Annex-B stream through the existing
  `NalSplitter` / `AccessUnitAssembler` / RTP path (unchanged downstream). `forceKeyframe()`
  / `setBitrate()` write `I` / `B<kbps>` over the control channel.
- Gate: use the SYSTEM source only when Track 2 is installed+enabled AND the pipe
  connects within a timeout; else **silent fallback** to today's `CapturerFrameSource`
  (spawn child) → the normal path can never black-screen because of this feature.
- No receiver changes. No `contract.ts` codec change.

### 2b — pipe/CLI contract (FROZEN — WC builds the capturer against this)

`capturer.exe` already speaks a stdout/stdin contract (video on stdout, `I`/`L`/`B<kbps>`
on stdin — see `capturerArgs.ts` + `CapturerFrameSource`). Pipe mode is the SAME contract
with the sink/source moved from stdout/stdin to one duplex named pipe. Minimal change.

**CLI:** add `--output pipe:<name>` alongside `stdout` / `<file>`. `<name>` is a full
Windows pipe path the sender passes, e.g. `\\.\pipe\pr-capturer-<id>`. All other flags
(`--monitor --codec --fps --bitrate --maxrate --gop --vbv-ms --desktop-follow`) unchanged.

**Roles (Fix A — do not invert):** the **user-session sender HOSTS** the pipe
(`CreateNamedPipe`), the **SYSTEM capturer CONNECTS** (`CreateFile`). SYSTEM can open a
user-owned pipe; a SYSTEM-hosted pipe DACL-denies the medium sender (the proven Track 2
lesson). Pipe type = **duplex, BYTE mode** (`PIPE_ACCESS_DUPLEX`,
`PIPE_TYPE_BYTE|PIPE_READMODE_BYTE`), one instance.

**Bytes on the connected pipe:**
- **Capturer → sender (pipe WRITE) = today's stdout, byte-identical:** Annex-B, 4-byte
  start codes, in-band SPS/PPS before every IDR, flush per frame, first frame IDR. Only
  the sink handle changes.
- **Sender → capturer (pipe READ) = today's stdin, byte-identical:** `I` (force IDR),
  `B<kbps>\n` (set bitrate, newline-terminated), `L` (LTR, off by default). Point the
  existing stdin-reader thread at the pipe handle.

**Connect race / retry:** capturer retries `CreateFile` ~200ms×up-to-10s (the sender may
host slightly after the launcher spawns it — same race as the Track 2 input pipe); on
give-up → exit non-zero + `[capturer] pipe connect failed <GetLastError>`. Sender
`ConnectNamedPipe` with ~10s timeout; no connect → close pipe → **fall back to spawning
the in-session `CapturerFrameSource` child** (today's path) so the SYSTEM path can never
black-screen.

**No-orphan / die-with-parent:** the SYSTEM capturer is NOT the sender's child, so it gets
no parent-death signal ([[forked-helpers-die-with-parent]]). **The broken pipe IS its
death signal** — a WRITE/READ failing with `ERROR_BROKEN_PIPE`/`ERROR_NO_DATA` (sender
closed the pipe = session end or sender crash) → capturer exits 0 promptly. This is what
guarantees no orphaned `capturer.exe`; verify under a sender-kill in 2d.

**Logging:** unchanged `[capturer]` to stderr; the launcher redirects it to
`C:\Windows\Temp\pr-capturer-system.log` (SYSTEM's TEMP, no console). Per WC's 2a note:
**log the desktop name on EVERY re-init (not just on change) + log `OpenInputDesktop`/
`SetThreadDesktop` failures loudly** so the Default↔Winlogon switches are visible in 2c.

**Open (joint, decide in 2b — not blocking the capturer's pipe I/O):** how the
user-session sender triggers the SYSTEM launcher to spawn the capturer with `<name>`.
Recommend **on-demand** (spawn per session, exit on pipe-broken) over an always-idle
capturer; mechanism follows Fix A too (sender hosts a small request pipe, the SYSTEM
launcher connects + reads spawn requests). For a **standalone 2b test** Mac-Claude will
hand WC a tiny Node pipe-host harness (`dev/system-capturer-host.mjs`: hosts `<name>`,
dumps the WRITE stream to `.h264`, lets you type `I`/`B`) so the pipe path is proven
before the real sender is wired.

### 2b — spawn-trigger contract (FROZEN 2026-07-11, WC's proposal + refinements)

How the user-session sender asks the SYSTEM launcher to spawn the capturer. Reuses the
Track 2 primitives (WC's proposal — accepted).

**Request pipe (Fix A):** the **sender HOSTS** `\\.\pipe\personal-remote-capturer-spawn`,
the **SYSTEM launcher CONNECTS** (polls on its existing ~2s `service.ts` tick). Framing =
`input-service/protocol.ts` `encodeFrame`/`FrameDecoder` (4-byte LE length + UTF-8 JSON).
**One frame = one spawn request.**

**Request JSON (STRUCTURED — the launcher validates each field and builds the argv ITSELF;
it must NOT accept a raw command string from the pipe):**
```json
{ "pipeName": "\\\\.\\pipe\\pr-capturer-<id>", "monitor": 0, "codec": "h264",
  "fps": 60, "bitrate": 25000, "maxrate": 50000, "gop": 120, "desktopFollow": true }
```
- **Validation (launcher, before spawn — a same-user squatter could write this pipe):**
  `pipeName` must match `^\\\\\.\\pipe\\pr-capturer-[A-Za-z0-9._-]+$`; `codec` ∈
  `{"h264","h265"}`; `monitor`/`fps`/`bitrate`/`maxrate`/`gop` positive ints clamped to
  sane ranges; `desktopFollow` bool. Invalid → log + skip, never spawn. The exe is always
  the launcher's own resolved `capturer.exe`, never from the request.
- **No arg drift:** the fields are 1:1 with `buildCapturerArgs`. Mac ships
  `buildCapturerSpawnRequest(config, opts)` colocated with `capturerArgs.ts`, derived from
  the SAME config/BWE values, so the SYSTEM path's argv == the user path's argv exactly.
- **`<id>`:** the **sender** generates a unique `pipeName`, hosts the video pipe, and puts
  it in the request. ✔

**Launcher action:** `spawnCapturerInSession(activeSessionId, request)` →
`createProcessInSession(capturerExe, "--output pipe:<pipeName> --desktop-follow --monitor N
--codec X --fps N --bitrate N --maxrate N --gop N", activeSessionId)`. Capturer connects the
video pipe → streams.

**Logging:** capturer stderr → `C:\Users\Public\personal-remote-capturer-system.log`
(world-readable so the medium helper/owner can read it — accepted over `C:\Windows\Temp`,
which SYSTEM's DACL hides from the user).

**Lifecycle / no-orphan (no kill message needed):** session end/crash → sender closes the
VIDEO pipe → capturer hits broken pipe → exit 0 (WC verified ~45ms). Two refinements:
- The **sender keeps the REQUEST pipe hosted for the whole session** (close at session end),
  so a slow ~2s launcher poll can't miss the request via a write-then-close race.
- The sender **hosts the request pipe + writes the request EARLY** (at session setup, in
  parallel with ICE negotiation) so the ~2s poll overlaps negotiation instead of adding
  ~2s to first-frame.

**Active-session change re-honor = 2d (not in this freeze):** launcher caches the last
valid request and re-spawns into the new active session on a session switch (rare for a
solo user; Default↔Winlogon within one session is handled by the capturer's own
desktop-follow, no re-spawn).

### Phasing (prerelease per substep, golden rule #1)
- **2a** — capturer `--desktop-follow` + `OpenInputDesktop`/`SetThreadDesktop` on
  ACCESS_LOST; run it **standalone as SYSTEM** (via `PsExec -s -i 1` or the task) and
  prove it captures the **lock screen / UAC** to an `.h264` file that decodes clean.
  THE DECIDER for feasibility — do this first, in isolation, before any wiring.
- **2b** — pipe output mode + generalize the SYSTEM spawn; launcher starts the capturer;
  Mac's `SystemCapturerFrameSource` connects; e2e over RTP on the **normal** desktop
  first (prove the pipe path == stdout path, no regression).
- **2c** — joint e2e: lock the screen / trigger UAC from the Mac → **see** the secure
  desktop live + control it → log back in remotely. PRERELEASE, real-hardware verify.
- **2d** — hardening: seamless Default↔Winlogon switch (no long freeze — forced IDR on
  switch), SYSTEM capturer crash-respawn, coexist-with-Parsec, no orphaned capturer
  ([[forked-helpers-die-with-parent]] — the SYSTEM capturer must die when its pipe EOFs
  / the sender exits).

### Known caveat to accept up front
Multi-monitor secure desktop and any per-app DRM/protected content on the lock screen
are out of scope. The target is: the standard lock screen, the standard UAC consent
dialog, Ctrl+Alt+Del — the things the owner actually hits.

---

## Division of labor

| | Mac-Claude | WC |
|---|---|---|
| Part 1a toggle | UI + persisted config + IPC + Thai copy | elevated install/uninstall, reboot-permanent |
| Part 1b/1c | review | verify + Phase 4 hardening |
| Part 2 native (desktop-follow, SYSTEM spawn, NVENC-as-SYSTEM, pipe output) | pipe/CLI contract | **build + hardware-prove** |
| Part 2 TS (`SystemCapturerFrameSource`, gate, fallback) | **build** | review on device |
| Receiver | unchanged | — |
| Releases / prereleases / merge | **owns** (build-win.sh, golden rules) | verifies on real hardware |

## Acceptance = "usable for real"
1. Toggle it on in the app (one UAC), reboot, no scripts.
2. From the Mac: lock the Windows PC → **see** the lock screen → type the password →
   logged back in.
3. Trigger a UAC prompt remotely → **see** it → click Yes.
4. Normal desktop video/latency/GPU unchanged (the SYSTEM path is sole-source but must
   match today's feel); with the feature off or the service down, everything is
   byte-identical to v1.36.0.
5. No orphaned `capturer.exe` / `PersonalRemote.exe` after disconnect, reboot, or a
   Default↔Winlogon storm.
