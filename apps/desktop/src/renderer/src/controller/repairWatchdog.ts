// Proactive re-pair watchdog.
//
// The controller's pair retries are otherwise all REACTIVE -- scheduled only when
// a specific message is RECEIVED (a 'pair-result: unknown device id', or a pc
// 'failed' event). During the reconnect FLAPPING after a lid-close wake (agent +
// controller + tunnel all reconnecting at once), a pair-request OR its
// pair-result can simply be LOST -- then no reactive retry is ever scheduled and
// the session strands "connected to signaling but never paired" indefinitely
// (the ~4-min hang the owner hit). This watchdog ticks the whole session and,
// while nothing is actually 'connected', keeps re-sending pair-request
// (idempotent server-side) so a lost message can't wedge us.
//
// Extracted from ControllerSession into a pure module so the decision + loop are
// deterministically unit-testable (see dev/verify-repair-watchdog.mjs) -- no lid
// cycling required.

// 6s is comfortably longer than a healthy direct-link negotiation (~1-2s), so the
// watchdog only nudges genuinely-stuck sessions, never a still-progressing one.
export const REPAIR_WATCHDOG_INTERVAL_MS = 6000

export interface RepairWatchdogState {
  // The WebRTC / non-helper-input peer connection is 'connected'.
  pcConnected: boolean
  // The separate helper-input peer connection is 'connected'.
  inputConnected: boolean
  // Our signaling WebSocket is up (nudging while it's down is pointless -- the
  // client's own reconnect handles that).
  signalingOpen: boolean
  // A human must approve on the other machine right now -- don't re-send
  // pair-request into that wait.
  pendingApproval: boolean
}

// Pure predicate: should the watchdog re-send pair-request on this tick? Either pc
// reaching 'connected' means we're paired and live, so no nudge.
export function shouldNudgeRepair(s: RepairWatchdogState): boolean {
  if (s.pcConnected || s.inputConnected) return false // healthy -- paired & live
  if (!s.signalingOpen) return false // WS down -> its own reconnect handles it
  if (s.pendingApproval) return false // human approving on the other end -- don't spam
  return true // stuck "connected to signaling but not paired" -> nudge
}

export interface RepairWatchdogHandle {
  stop(): void
}

export interface RepairWatchdogDeps {
  // Reads the LIVE state each tick (so it reflects the current pc/WS/approval
  // situation, not a snapshot from when the watchdog started).
  getState: () => RepairWatchdogState
  // Sends one pair-request (idempotent server-side).
  sendPairRequest: () => void
  // Overridable for tests (fake clock); defaults to the real timers.
  intervalMs?: number
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void
}

// Starts the watchdog loop. Returns a handle whose stop() clears the timer.
export function startRepairWatchdog(deps: RepairWatchdogDeps): RepairWatchdogHandle {
  const ms = deps.intervalMs ?? REPAIR_WATCHDOG_INTERVAL_MS
  const setFn = deps.setIntervalFn ?? setInterval
  const clearFn = deps.clearIntervalFn ?? clearInterval
  const handle = setFn(() => {
    if (shouldNudgeRepair(deps.getState())) deps.sendPairRequest()
  }, ms)
  return {
    stop() {
      clearFn(handle)
    }
  }
}
