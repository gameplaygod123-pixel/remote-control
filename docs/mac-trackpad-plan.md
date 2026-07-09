# Mac-native control — smooth trackpad plan

Goal (owner, 2026-07-09): controlling the Windows agent **from the Mac** should
feel 100% like using a Mac — above all the **trackpad must scroll smoothly**
(fluid two-finger scroll with momentum, horizontal scroll, pinch-zoom), not the
current chunky notch-scroll.

## Why it's janky today (root cause)

The whole scroll pipeline throws away the trackpad's high-resolution signal:

1. **Controller** (`ControllerSession.tsx:314`): `sendInput({t:'wheel', dy: e.deltaY / 40})`
   — only `deltaY`, no `deltaX`; a fixed `/40`.
2. **Agent input-helper** (`injector.ts:90` `scrollMouse`): `steps = Math.round(Math.abs(dy))`
   then `nut.js mouse.scrollDown/Up(steps)`.
   - `Math.round` **drops any sub-step scroll**: a gentle trackpad flick
     (deltaY≈8px → dy=0.2 → round=0) scrolls **nothing**.
   - nut.js only scrolls in **whole 120-unit notches** (no sub-notch), so even
     when it does move it jumps a full line/notch at a time = chunky.
3. **No horizontal scroll** at all (`deltaX` never sent; no `MOUSEEVENTF_HWHEEL`).
4. **No momentum**: macOS keeps firing decaying `wheel` events after the finger
   lifts — but rounding to integer notches destroys the fine tail, so inertia
   never reaches the remote.
5. **No pinch-zoom**: Chromium delivers a trackpad pinch as a `wheel` event with
   `ctrlKey=true`; we ignore the modifier, so pinch does nothing (or scrolls).

Windows itself is NOT the limit: `SendInput` `MOUSEEVENTF_WHEEL` accepts a
`mouseData` **smaller than `WHEEL_DELTA` (120)**. Sending many small fractional
deltas = genuine high-resolution smooth scroll that every modern app (browsers,
Explorer, Office) honors. The bottleneck is purely nut.js's notch API + our
rounding. (Confirmed: MS docs on WM_MOUSEWHEEL; the "delta 120 so finer wheels
send smaller values" design note.)

## Design principle — no mode button (auto, like the Parsec keyboard)

The owner asked for a "Mac mode", but a manual toggle isn't needed and a
high-resolution accumulator serves **both** input devices:
- a **trackpad**'s fine pixel deltas → smooth continuous scroll;
- a **real mouse**'s discrete notch (one ~120px/wheelDelta event) → accumulates
  to one chunk = the correct notchy mouse feel.

So we make the scroll pipeline high-resolution **always-on**, with no user-facing
toggle — the same philosophy that retired the Text/Game keyboard toggle. (If the
owner still wants an explicit switch, it's a thin wrapper on top; noted, not
recommended.)

## Plan (phased; native FFI ⇒ golden rule #1 prerelease each time)

### Phase 1 — high-resolution smooth scroll (the 90% win)

**Protocol** (`inputProtocol.ts`) — extend the wheel message, backward-compatible:
```ts
// dy/dx are RAW pixel deltas (deltaMode-normalized), floats, NOT rounded.
// `dx` absent on an older controller => agent scrolls vertical only (graceful).
| { t: 'wheel'; dy: number; dx?: number }
```
Keep `dy` meaning the same *sign* it has today so an un-upgraded agent still
scrolls (just chunkier).

**Controller** (`ControllerSession.tsx handleWheel`):
- Forward the raw high-res delta, no rounding: normalize `deltaMode` to pixels
  (`deltaMode===1` line → ×16; `===2` page → ×height), send `{t:'wheel', dy, dx}`.
- **Backpressure/coalesce** on the reliable input channel: wheel rides the
  ordered channel (like keys), so under jitter a fast flick could backlog. If
  `bufferedAmount` is high, **sum** the pending wheel delta into one message
  instead of queuing many (never drop scroll — summing preserves total travel).

**Agent — Win32 high-res wheel via koffi** (the core fix, native FFI):
- New `injectWheelWin32(dx, dy)` doing `SendInput`:
  - vertical → `MOUSEEVENTF_WHEEL`, `mouseData = accumulate(dy)`
  - horizontal → `MOUSEEVENTF_HWHEEL (0x01000)`, `mouseData = accumulate(dx)`
  - **fractional accumulator**: `acc += px * GAIN`; emit `trunc(acc)` (can be
    < 120), keep the remainder — so slow scrolls aren't lost and fast ones are
    smooth. Sign: Windows wheel +up, browser deltaY +down ⇒ negate (as today);
    HWHEEL +right matches deltaX +right (no negate).
- Route the Windows `scrollMouse` (input-helper path) to `injectWheelWin32`,
  **bypassing nut.js** — mirrors how the keyboard already moved to koffi
  SendInput (`injectorWin32.ts`). Non-Windows keeps nut.js.
- **SYSTEM injector** (`rawInject.ts injectWheel`): add the same accumulator +
  `MOUSEEVENTF_HWHEEL` so the secure-desktop path matches.
- **Agent coalescing** (`input-helper/index.ts`): the queue already collapses
  consecutive `move`s; do the same for `wheel` — sum dx/dy of queued wheels so a
  burst never builds a stale backlog.

**Feel tuning**: expose `GAIN` (px→wheel) via env like other knobs
(e.g. `INPUT_WHEEL_GAIN`) so we can dial it on real hardware without a rebuild;
bake the winning value as the default.

### Phase 2 — trackpad gestures

- **Pinch-to-zoom — DONE (controller-only, Mac-gated).** Chromium sends a pinch as
  `wheel` + `ctrlKey=true` with no physical key. `handlePinchZoom` (in `handleWheel`,
  Mac branch only) synthesizes a real **Ctrl (scancode)** held for the pinch burst
  and releases it `PINCH_IDLE_MS`(140ms) after the last pinch wheel → the agent reads
  Ctrl+wheel = zoom. Guard: a genuine physical Ctrl+scroll already forwards a real
  Ctrl via the key path, so we only synthesize when `ctrlKey` is set AND no physical
  Ctrl is held (`heldKeysRef`, now shared between the keyboard effect and the wheel
  handler). Panic-release (blur/hide) drops the synthetic Ctrl too. **No agent/FFI or
  protocol change** — reuses the verified scancode-key + px-wheel paths. A Windows
  controller never enters the Mac branch → byte-identical (no regression).
- **Two-finger swipe navigation** (optional): map horizontal swipe-nav to
  Back/Forward. Lower value; most horizontal intent is covered by HWHEEL. Skip
  unless asked.

### Phase 3 — 0-latency pointer (the real "glued to the mouse" feel; optional, big)

The remaining non-scroll gap is pointer latency: the remote cursor lives inside
the 60fps video + network, so it trails the Mac. The fix is the **dormant local
cursor overlay** (`PR_CURSOR_OVERLAY`, built in beta.4, kept behind a flag):
draw the **local Mac cursor** over the video (0 latency, native shape via the
`cursor` data channel) and hide the composited remote one. This is a larger,
separate effort (interacts with `draw_mouse` compositing + the cursor channel) —
list it, don't bundle it into the trackpad work.

## Safety / process

- `injectWheelWin32` is **koffi SendInput = native FFI** → **golden rule #1**:
  ship as a PRERELEASE, verify on the real Windows agent (WC) before any full
  release. The `scan?` design showed the pattern: opt-in/additive so the default
  path stays byte-identical.
- Backward compatible both directions: old agent (no `dx`/accumulator) still
  scrolls vertically; old controller (no `dx`) still works against a new agent.
- Non-Windows agent unaffected (nut.js path untouched off win32).

## WC real-hardware test checklist (Phase 1)

1. Gentle two-finger trackpad scroll → smooth, no dead zone on slow flicks.
2. Momentum: flick + lift → inertia continues and decays on the remote.
3. Horizontal two-finger scroll → remote scrolls sideways (HWHEEL).
4. Fast flick under load → no runaway/backlog (coalescing holds).
5. A real USB mouse wheel → still notchy/normal (accumulator degrades correctly).
6. Tune `INPUT_WHEEL_GAIN` until 1:1 with local Mac feel; bake the default.

## Open decision for the owner

- **No toggle (recommended)** vs an explicit "Mac trackpad mode" switch. Default
  plan assumes auto/no-toggle.
- Do Phase 1 now; Phase 2 (pinch) right after if it feels worth it; Phase 3
  (cursor overlay) only if the pointer-trail still bugs you.
