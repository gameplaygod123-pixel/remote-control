# Streaming baseline — v1.27.0-beta.3

Reference snapshot of the native-video pipeline as it actually ran on the real
Windows agent (RTX 3060 Ti), captured to keep as a known-good baseline for
future regression comparison.

- **Captured**: 2026-07-08, session 11:53–11:58Z, 330s continuous, Parsec running concurrently.
- **Build**: v1.27.0-beta.3 (installed over v1.26.0).
- **Verdict**: ✅ all checks pass. enc_ms 5.6ms avg, emit locked-60, error 0, BWE cap 25 confirmed.

## Setup

| item | value |
| --- | --- |
| version | 1.27.0-beta.3 (from 1.26.0) |
| launch | `schtasks /run PersonalRemoteAgent` (inherits `VIDEO_CAPTURER=1`) |
| spawn | `spawn capturer` ✅ (not ffmpeg) — log 11:53:32 |
| tune-file `%LOCALAPPDATA%\pr-capturer-tune.txt` | `bitrate=25000 maxrate=35000 fps=60 locked-idle-ms=86400000` (locked-60 never-decay still set) |
| dead env (overridden by tune-file) | `VIDEO_CAPTURER_BITRATE_KBPS=50000`, `VIDEO_CAPTURER_MAXRATE_KBPS=60000` — no effect |

## A. Capture (DXGI)

| item | value |
| --- | --- |
| capturer path | `...\resources\capturer\capturer.exe` (packed 230400 B = enc_ms build) |
| argv (from sender) | `--output stdout --monitor 0 --codec h264 --fps 60 --bitrate 25000 --maxrate <cfg> --gop 120` |
| effective (after tune-file) | 2560×1440, VBR 25000/35000, gop 120, no-intra-refresh, floor=off |
| monitor / res | monitor 0, 2560×1440 (native capture) |
| cadence | locked-60 ✅ (emit 60–61/s across 330s, avg 60.6) |
| idle-decay | never-decay (locked-idle-ms=86400000) |
| change-detection | ✅ working — mouse move on static screen = pointer-only = skip (capturer is cursorless). Static dip: skip spikes 10–19, real drops. Whole session had continuous motion (Parsec open) → real avg 59, no isolated fully-static second |

## B. Encode (NVENC) ⭐

| item | value |
| --- | --- |
| codec | H.264 (`--codec h264`) |
| preset | P1 (default) |
| VBR target/max | 25000 / 35000 kbps |
| GOP / intra-refresh | 120 (IDR ~2s) / **no** intra-refresh ✅ |
| **enc_ms (whole session)** | **3.4–6.6 ms (avg 5.6)** — n=330 |
| enc_ms (skip≥5 ≈ static) | 3.5–6.6 (avg 5.9) — nearly identical |
| GPU clock | 525–1920 MHz (avg 750) — no 210 MHz downclock (continuous 60fps encode holds clock up) |
| GPU power | 40–75 W (avg 46) |
| GPU enc% (nvidia-smi) | 0–36% (avg 29%) ⚠️ GPU-wide + Parsec daemon — can't isolate via CLI |
| vs Parsec | enc_ms ours 5.6ms **< Parsec overlay 8.72ms** (clean host-side metric). enc% not comparable via nvidia-smi (GPU-wide); use Task Manager per-process for an exact split |

## C. Encode → Mac HUD (new telemetry)

| item | result |
| --- | --- |
| chain packed | capturer(enc_ms) → getEncodeMs parse → reportStats → AgentView relay ✅ complete in beta.3 |
| agent-side enc_ms flowing | ✅ (log has enc_ms 5.6ms → encodeMs non-null → forwarded) |
| Mac HUD `Encode X.Xms` | owner confirmed "สถานะขึ้นครบ" → should show ~5–6ms (matches log). Pending final owner read of the exact number to close C 100% |

## D. BWE (beta.2 bufferbloat fix — the decider)

| item | value |
| --- | --- |
| adaptive | ✅ target ramps 21250 → 23250 → 25000 (+2 Mbps/s additive), both sessions |
| cap | 25000 (25 Mbps) ✅ — stops exactly at 25, not 60 (beta.2 fix confirmed) |
| floor | 5000 (untested — link too good) |
| backoff (loss/jitter) | 0 times — link steady, no loss/jitter spike → no backoff needed |
| smooth == v1.26.0 | owner "ใช้งานได้ปกติ" + error=0 + emit locked-60 + no double-cursor/freeze like beta.1 |
| capturer retune log | capturer doesn't log on retune — judge by sender `sent B<kbps>` ✅ all seen |

## E. Transport / input

| item | value |
| --- | --- |
| pc state | connected (offer 629B / answer 591B, connect ~1.3s) |
| RTT | on Mac HUD; sender log has none |
| errors | 0 (no fatal/fallback/access-lost/track-error across session) |
| input / cursor | normal, no stuck key |
| elevation | Medium (no elevated flag) — video/normal control OK; Task Manager/secure desktop not controllable |

## Log excerpts (real values)

Active (continuous motion):
```
11:54:00 emit=60 real=60 skip=0  idr=0 enc_ms=5.1
11:54:05 emit=60 real=59 skip=0  idr=1 enc_ms=5.2
11:54:09 emit=61 real=48 skip=12 idr=1 enc_ms=5.7   ← change-detection kick
```

Change-detection dip (static / mouse-only):
```
11:57:07 emit=61 real=59 skip=2  idr=0 enc_ms=5.6
11:57:08 emit=60 real=41 skip=19 idr=1 enc_ms=5.1   ← real drops, skip spikes = static
11:57:09 emit=60 real=56 skip=4  idr=0 enc_ms=5.5
```

BWE ramp → cap 25:
```
11:58:38 setBitrate() 21250kbps → sent B21250
11:58:39 setBitrate() 23250kbps → sent B23250
11:58:40 setBitrate() 25000kbps → sent B25000  (stops at cap 25)
```

## Summary

beta.3 = v1.26.0 (capturer + locked-60 + VBR 25/35 + H.264) + BWE (cap 25, +2
additive, backoff on loss/jitter) + enc_ms telemetry → HUD. 330s session: enc_ms
5.6ms, emit locked-60, error 0, BWE cap 25 confirmed. Passes every check — only
remaining item is the owner reading the exact `Encode` number on the HUD (~5–6ms)
to close C. Promotable to full v1.27.0.
