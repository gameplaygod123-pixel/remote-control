#!/usr/bin/env node
// Auto-test / session analyzer for the native video pipeline.
//
// The owner shouldn't have to eyeball raw logs to know if a session was smooth --
// this parses the receiver's (and optionally the sender's) structured log lines and
// prints ONE report: the deep metrics + a plain-language smoothness verdict. It's the
// "run it, read the verdict" replacement for scrolling video-receiver.log by hand.
//
// Usage (from the repo root or anywhere):
//   node scripts/analyze-session.mjs [receiver.log] [sender.log] [--json] [--all]
// Defaults to $TMPDIR/video-receiver.log (where the Mac receiver writes). Pass the
// Windows video-sender.log too (copied over) to also see encode/IDR + loss↔IDR
// correlation. --all analyzes every session in the log; default = the last one.
//
// Parsed receiver lines (see video-native/receiver/index.ts):
//   stats fps=.. jitter=..ms kbps=.. loss=.. lostpkts=.. pli=.. WxH
//   hitch recovered in Nms (loss -> keyframe)
//   requestKeyframe (reason) -> PLI
//   codec detected from offer: <codec> ...   |   resolution WxH (from SPS)
//   startSession id=N   |   bwe loss=..% -> target ..kbps
// Parsed sender lines (video-native/sender/index.ts, optional):
//   <locked-cadence line with> emit=.. real=.. skip=.. idr=.. enc_ms=..

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const paths = args.filter((a) => !a.startsWith('--'))
const JSON_OUT = flags.has('--json')
const ALL = flags.has('--all')

const receiverPath = paths[0] ?? join(tmpdir(), 'video-receiver.log')
const senderPath = paths[1] // optional

// ── small stats helpers ───────────────────────────────────────────────────────
const num = (v) => (Number.isFinite(v) ? v : 0)
const sum = (a) => a.reduce((s, x) => s + x, 0)
const avg = (a) => (a.length ? sum(a) / a.length : 0)
const min = (a) => (a.length ? Math.min(...a) : 0)
const max = (a) => (a.length ? Math.max(...a) : 0)
function pct(a, p) {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
function stddev(a) {
  if (a.length < 2) return 0
  const m = avg(a)
  return Math.sqrt(avg(a.map((x) => (x - m) ** 2)))
}
const tsMs = (line) => {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)
  return m ? Date.parse(m[1]) : NaN
}

// ── parse one session's receiver lines ────────────────────────────────────────
function analyzeReceiver(lines) {
  const fps = [],
    jitter = [],
    kbps = [],
    hitches = [], // recovery ms per hitch
    bweTargets = [],
    lossTimes = [] // ts of stats windows that had loss (for burst/spread)
  let lossEvents = 0,
    lostPkts = 0,
    pli = 0,
    codec = 'h264',
    resolution = '?',
    startTs = NaN,
    endTs = NaN

  for (const line of lines) {
    const t = tsMs(line)
    if (Number.isFinite(t)) {
      if (!Number.isFinite(startTs)) startTs = t
      endTs = t
    }
    let m
    if ((m = line.match(/stats fps=(\d+) jitter=([\d-]+)ms kbps=(\d+)(?: loss=(\d+) lostpkts=(\d+) pli=(\d+))?/))) {
      fps.push(num(+m[1]))
      if (m[2] !== '-') jitter.push(num(+m[2]))
      kbps.push(num(+m[3]))
      if (m[4] != null) {
        const l = +m[4]
        lossEvents += l
        lostPkts += +m[5]
        pli += +m[6]
        if (l > 0 && Number.isFinite(t)) lossTimes.push(t)
      }
    } else if ((m = line.match(/hitch recovered in (\d+)ms/))) {
      hitches.push(+m[1])
    } else if (/requestKeyframe .* -> PLI/.test(line)) {
      // pli also counted from stats; this catches session-start PLIs (window may roll)
    } else if ((m = line.match(/codec detected from offer: (\w+)/))) {
      codec = m[1]
    } else if ((m = line.match(/resolution (\d+x\d+)/))) {
      resolution = m[1]
    } else if ((m = line.match(/target (\d+)kbps/))) {
      bweTargets.push(+m[1])
    }
  }

  const durationSec = Number.isFinite(startTs) && Number.isFinite(endTs) ? (endTs - startTs) / 1000 : 0
  const perMin = (n) => (durationSec > 0 ? (n / durationSec) * 60 : 0)
  // inter-loss gaps (s) -> is loss bursty or spread evenly? (root-cause hint)
  const interLoss = []
  for (let i = 1; i < lossTimes.length; i++) interLoss.push((lossTimes[i] - lossTimes[i - 1]) / 1000)

  return {
    codec,
    resolution,
    durationSec,
    fps: { avg: avg(fps), min: min(fps), p5: pct(fps, 5), stddev: stddev(fps), n: fps.length },
    jitter: { avg: avg(jitter), p95: pct(jitter, 95), max: max(jitter) },
    kbps: { avg: avg(kbps), min: min(kbps), max: max(kbps) },
    loss: { events: lossEvents, packets: lostPkts, perMin: perMin(lossEvents), interLossAvgSec: avg(interLoss) },
    hitches: {
      count: hitches.length,
      perMin: perMin(hitches.length),
      avgMs: avg(hitches),
      medianMs: pct(hitches, 50),
      maxMs: max(hitches)
    },
    pli,
    bwe: { min: min(bweTargets), max: max(bweTargets), adaptations: bweTargets.length }
  }
}

function analyzeSender(lines) {
  const enc = [],
    emit = [],
    skip = []
  let idr = 0
  for (const line of lines) {
    const m = line.match(/emit=(\d+).*?real=(\d+).*?skip=(\d+).*?idr=(\d+).*?enc_ms=([\d.]+)/)
    if (m) {
      emit.push(+m[1])
      skip.push(+m[3])
      idr += +m[4]
      const e = +m[5]
      if (e > 0) enc.push(e)
    }
  }
  if (!emit.length) return null
  return {
    emit: { avg: avg(emit), min: min(emit) },
    encodeMs: { avg: avg(enc), p95: pct(enc, 95), max: max(enc) },
    idrTotal: idr
  }
}

// Split a log into sessions on "startSession id=N"; return the requested set.
function splitSessions(lines) {
  const sessions = []
  let cur = []
  for (const line of lines) {
    if (/startSession id=\d+/.test(line) && cur.length) {
      sessions.push(cur)
      cur = []
    }
    cur.push(line)
  }
  if (cur.length) sessions.push(cur)
  return sessions.length ? sessions : [lines]
}

// ── verdict ───────────────────────────────────────────────────────────────────
function verdict(r) {
  const notes = []
  let level = 'SMOOTH'
  if (r.hitches.maxMs > 500) {
    level = 'FREEZING'
    notes.push(`hitches up to ${r.hitches.maxMs}ms (a lost packet is NOT recovering fast — PLI-on-loss not working?)`)
  } else if (r.hitches.count > 0) {
    level = 'MINOR JUDDER'
    notes.push(
      `${r.hitches.count} hitch(es), recovery avg ${Math.round(r.hitches.avgMs)}ms / max ${r.hitches.maxMs}ms — fast IDR recovery working, but the losses themselves cause tiny blips`
    )
  }
  if (r.loss.perMin > 0.5)
    notes.push(
      `loss ${r.loss.perMin.toFixed(1)}/min (every ~${r.loss.interLossAvgSec ? r.loss.interLossAvgSec.toFixed(0) : '?'}s) — eliminate at the source for 100% smooth (NACK/FEC or find the cause)`
    )
  if (r.jitter.p95 > 25) {
    if (level === 'SMOOTH') level = 'MINOR JUDDER'
    notes.push(`jitter p95 ${Math.round(r.jitter.p95)}ms (>25) — uneven frame pacing`)
  }
  if (r.hitches.count === 0 && r.loss.events === 0 && r.jitter.p95 <= 25)
    notes.push('no loss, no hitches, low jitter — clean session')
  return { level, notes }
}

// ── render ────────────────────────────────────────────────────────────────────
const c = (code, s) => (JSON_OUT || !process.stdout.isTTY ? s : `\x1b[${code}m${s}\x1b[0m`)
const bold = (s) => c('1', s)
const dim = (s) => c('2', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const red = (s) => c('31', s)
const f1 = (n) => (Math.round(n * 10) / 10).toString()

function render(r, s, sessionLabel) {
  const v = verdict(r)
  const badge = v.level === 'SMOOTH' ? green(`● ${v.level}`) : v.level === 'FREEZING' ? red(`● ${v.level}`) : yellow(`● ${v.level}`)
  const L = []
  L.push('')
  L.push(bold(`  Session report ${dim(sessionLabel)}`))
  L.push(`  ${badge}   ${dim(`${r.codec.toUpperCase()} · ${r.resolution} · ${f1(r.durationSec)}s`)}`)
  L.push('')
  const row = (k, val, note = '') => L.push(`  ${k.padEnd(16)} ${bold(val).padEnd(28)} ${dim(note)}`)
  row('fps', `${f1(r.fps.avg)} avg`, `min ${r.fps.min} · p5 ${r.fps.p5} · σ ${f1(r.fps.stddev)}`)
  row('jitter', `${f1(r.jitter.avg)}ms avg`, `p95 ${f1(r.jitter.p95)} · max ${f1(r.jitter.max)}`)
  row('bitrate', `${f1(r.kbps.avg / 1000)} Mbps avg`, `${f1(r.kbps.min / 1000)}–${f1(r.kbps.max / 1000)}`)
  if (r.bwe.adaptations) row('bwe target', `${f1(r.bwe.min / 1000)}–${f1(r.bwe.max / 1000)} Mbps`, `${r.bwe.adaptations} adaptations`)
  L.push('')
  row('loss events', `${r.loss.events}`, `${r.loss.packets} pkts · ${f1(r.loss.perMin)}/min · ~1 per ${r.loss.interLossAvgSec ? f1(r.loss.interLossAvgSec) : '—'}s`)
  row('PLI sent', `${r.pli}`, r.loss.events > 0 ? `${(r.pli / r.loss.events).toFixed(1)} per loss` : '')
  const hcolor = r.hitches.maxMs > 500 ? red : r.hitches.count ? yellow : green
  row('hitches', hcolor(`${r.hitches.count}`), r.hitches.count ? `recovery avg ${f1(r.hitches.avgMs)}ms · med ${r.hitches.medianMs} · max ${r.hitches.maxMs}` : 'none — no perceived freeze')
  if (s) {
    L.push('')
    L.push(dim('  ── sender (agent) ──'))
    row('encode', `${f1(s.encodeMs.avg)}ms avg`, `p95 ${f1(s.encodeMs.p95)} · max ${f1(s.encodeMs.max)}`)
    row('emit fps', `${f1(s.emit.avg)}`, `min ${s.emit.min} · IDRs ${s.idrTotal}`)
  }
  L.push('')
  L.push(bold('  Verdict'))
  for (const n of v.notes) L.push(`  ${dim('•')} ${n}`)
  L.push('')
  return L.join('\n')
}

// ── main ──────────────────────────────────────────────────────────────────────
if (!existsSync(receiverPath)) {
  console.error(`receiver log not found: ${receiverPath}`)
  console.error('pass a path, or control a session first (the Mac writes $TMPDIR/video-receiver.log).')
  process.exit(1)
}
const rxLines = readFileSync(receiverPath, 'utf8').split('\n')
const sessions = splitSessions(rxLines)
const chosen = ALL ? sessions : [sessions[sessions.length - 1]]
const senderLines = senderPath && existsSync(senderPath) ? readFileSync(senderPath, 'utf8').split('\n') : null
const s = senderLines ? analyzeSender(senderLines) : null

const reports = chosen.map((lines, i) => {
  const r = analyzeReceiver(lines)
  const label = ALL ? `(session ${i + 1}/${chosen.length})` : ''
  return { r, label, text: render(r, i === chosen.length - 1 ? s : null, label) }
})

if (JSON_OUT) {
  console.log(JSON.stringify(reports.map((x) => ({ ...x.r, sender: s })), null, 2))
} else {
  for (const rep of reports) console.log(rep.text)
}
