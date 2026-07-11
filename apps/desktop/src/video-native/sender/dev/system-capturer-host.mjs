// Standalone pipe-host harness for the secure-desktop SYSTEM capturer (docs/
// secure-desktop-plan.md "2b pipe/CLI contract"). Lets Windows-Claude prove the
// capturer's `--output pipe:<name>` path in ISOLATION before the real sender
// (SystemCapturerFrameSource) is wired.
//
// It plays the SENDER's role: HOSTS the duplex named pipe (Fix A — the user-side
// process hosts, the SYSTEM capturer connects), dumps the capturer's WRITE stream
// (Annex-B video, byte-identical to today's stdout) to a .h264 file you can decode
// with ffmpeg, and forwards single-line stdin commands to the pipe (`i`=force IDR,
// `b<kbps>`=set bitrate, `l`=LTR) — the control bytes the capturer reads off the
// pipe exactly as it reads stdin today (`I` / `B<kbps>\n` / `L`).
//
// Run on the Windows agent (plain node — no Electron needed):
//   node system-capturer-host.mjs [--pipe \\.\pipe\pr-capturer-test] [--out cap.h264]
// then launch the capturer as SYSTEM against the same pipe, e.g.:
//   PsExec -s -i <sess> capturer.exe --output pipe:\\.\pipe\pr-capturer-test \
//     --desktop-follow --codec h264 --fps 60 --bitrate 25000 --maxrate 50000 --gop 120
// Win+L / trigger a UAC prompt, then Ctrl+C here and decode cap.h264.

import net from 'node:net'
import fs from 'node:fs'
import readline from 'node:readline'

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

const PIPE = arg('--pipe', '\\\\.\\pipe\\pr-capturer-test')
const OUT = arg('--out', 'cap.h264')

const outFile = fs.createWriteStream(OUT)
let bytes = 0
let frames = 0 // rough: count 4-byte Annex-B start codes seen
let carry = Buffer.alloc(0)
let client = null

function countStartCodes(buf) {
  // Rough frame/NAL counter for a sanity readout only (00 00 00 01).
  const b = Buffer.concat([carry, buf])
  let n = 0
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === 1) n++
  }
  carry = b.subarray(Math.max(0, b.length - 3)) // keep tail for split start codes
  return n
}

const server = net.createServer((sock) => {
  console.log(`[host] capturer connected on ${PIPE}`)
  client = sock
  sock.on('data', (chunk) => {
    bytes += chunk.length
    frames += countStartCodes(chunk)
    outFile.write(chunk)
  })
  sock.on('close', () => {
    console.log('[host] capturer disconnected (pipe closed)')
    client = null
  })
  sock.on('error', (e) => console.log(`[host] pipe error: ${e.message}`))
})

server.on('error', (e) => {
  console.error(`[host] cannot host ${PIPE}: ${e.message} (a stale instance? pick another --pipe)`)
  process.exit(1)
})

server.listen(PIPE, () => {
  console.log(`[host] hosting ${PIPE} -> writing video to ${OUT}`)
  console.log('[host] commands: i = force IDR | b<kbps> = set bitrate | l = LTR | q = quit')
})

// Forward terminal commands to the pipe as the capturer's control bytes.
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const s = line.trim()
  if (!client) return console.log('[host] no capturer connected yet')
  if (s === 'i') client.write('I')
  else if (s === 'l') client.write('L')
  else if (s[0] === 'b') client.write(`B${parseInt(s.slice(1), 10) || 25000}\n`)
  else if (s === 'q') process.exit(0)
  else return console.log('[host] unknown; use i / b<kbps> / l / q')
  console.log(`[host] sent control: ${s}`)
})

setInterval(() => {
  console.log(`[host] rx ${(bytes / 1024).toFixed(0)} KB, ~${frames} NAL start codes`)
}, 2000)

process.on('SIGINT', () => {
  console.log(`\n[host] done: ${(bytes / 1024).toFixed(0)} KB -> ${OUT}. Decode: ffmpeg -i ${OUT} -f null -`)
  process.exit(0)
})
