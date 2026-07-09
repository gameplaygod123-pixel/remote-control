// All-in-one network diagnostic for deciding how a machine can be reached across
// the internet (native P2P vs needs TURN vs can HOST a free TURN). Runs three
// checks and prints ONE verdict. No dependencies -- just Node.
//
// Run ON the machine you want to classify (e.g. the target agent):
//   node scripts/net-diag.mjs
//
// Checks:
//   1. NAT type (STUN, cone vs symmetric)      -> why libjuice/native may fail
//   2. CGNAT? (traceroute for a 100.64/10 hop)  -> can this host a free TURN?
//   3. Virtual/VPN adapters (ipconfig/ifconfig) -> junk ICE candidates (errno 65)

import dgram from 'node:dgram'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'

const isWin = process.platform === 'win32'
const MAGIC = 0x2112a442
const MAGIC_BUF = Buffer.alloc(4)
MAGIC_BUF.writeUInt32BE(MAGIC, 0)
const LOCAL_PORT = 54999
const STUN_SERVERS = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
  { host: 'stun.nextcloud.com', port: 443 }
]

function buildRequest() {
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0)
  buf.writeUInt16BE(0x0000, 2)
  buf.writeUInt32BE(MAGIC, 4)
  crypto.randomFillSync(buf, 8, 12)
  return buf
}

function parseMapped(msg) {
  let off = 20
  while (off + 4 <= msg.length) {
    const type = msg.readUInt16BE(off)
    const len = msg.readUInt16BE(off + 2)
    const val = msg.subarray(off + 4, off + 4 + len)
    if (type === 0x0020 || type === 0x0001) {
      let port = val.readUInt16BE(2)
      let ip
      if (type === 0x0020) {
        port ^= MAGIC >>> 16
        const a = Buffer.from(val.subarray(4, 8))
        for (let i = 0; i < 4; i++) a[i] ^= MAGIC_BUF[i]
        ip = `${a[0]}.${a[1]}.${a[2]}.${a[3]}`
      } else {
        ip = `${val[4]}.${val[5]}.${val[6]}.${val[7]}`
      }
      return { ip, port }
    }
    off += 4 + len + ((4 - (len % 4)) % 4)
  }
  return null
}

// One socket bound to a FIXED local port, queried against each STUN server in
// turn -- so the public port each reports is a clean symmetric-vs-cone test.
async function natCheck() {
  const results = []
  const sock = dgram.createSocket('udp4')
  await new Promise((res) => sock.bind(LOCAL_PORT, res)).catch(() => {})
  for (const s of STUN_SERVERS) {
    const r = await new Promise((resolve) => {
      let done = false
      const finish = (v) => {
        if (!done) {
          done = true
          resolve(v)
        }
      }
      const onMsg = (msg) => finish(parseMapped(msg))
      sock.once('message', onMsg)
      sock.send(buildRequest(), s.port, s.host, (err) => {
        if (err) finish(null)
      })
      setTimeout(() => {
        sock.removeListener('message', onMsg)
        finish(null)
      }, 3500)
    })
    console.log(`  ${s.host}:${s.port}  ->  ${r ? `${r.ip}:${r.port}` : 'no response'}`)
    if (r) results.push(r)
  }
  try {
    sock.close()
  } catch {
    /* ignore */
  }
  return results
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    return e.stdout ? String(e.stdout) : ''
  }
}

function checkCgnat() {
  // traceroute the first few hops; a 100.64.0.0/10 address = carrier-grade NAT.
  const out = isWin
    ? run('tracert -d -h 4 -w 1000 8.8.8.8')
    : run('traceroute -n -m 4 -w 2 8.8.8.8')
  const ips = out.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || []
  const cgnat = ips.find((ip) => {
    const [a, b] = ip.split('.').map(Number)
    return a === 100 && b >= 64 && b <= 127 // 100.64.0.0/10
  })
  return { cgnat: cgnat || null, hops: ips.slice(0, 6) }
}

function checkAdapters() {
  const out = isWin ? run('ipconfig /all') : run('ifconfig 2>/dev/null || ip addr')
  const junkRe = /vmware|virtualbox|hyper-?v|vethernet|\bwsl\b|\btap\b|tunnel|\bvpn\b|wireguard|zerotier|tailscale|utun|virtual/i
  const lines = out.split(/\r?\n/)
  const flagged = []
  // Windows: adapter headers look like "Ethernet adapter vEthernet (WSL):"
  for (const line of lines) {
    if (/adapter\s+.+:/i.test(line) && junkRe.test(line)) {
      flagged.push(line.trim().replace(/:\s*$/, ''))
    } else if (!isWin && /^[a-z0-9]+:/i.test(line) && junkRe.test(line)) {
      flagged.push(line.split(':')[0])
    }
  }
  return [...new Set(flagged)]
}

async function main() {
  console.log('=== NETWORK DIAGNOSTIC ===\n')
  console.log(`platform: ${process.platform}`)

  console.log('\n[1] NAT type (STUN from local port 54999)')
  const nat = await natCheck()
  const ports = new Set(nat.map((r) => r.port))
  const ips = new Set(nat.map((r) => r.ip))
  let natType = 'UNKNOWN'
  if (nat.length >= 2) natType = ports.size === 1 ? 'CONE' : 'SYMMETRIC'

  console.log('\n[2] CGNAT check (traceroute)')
  const cg = checkCgnat()
  console.log(`  first hops: ${cg.hops.join('  ')}`)

  console.log('\n[3] Virtual / VPN adapters')
  const adapters = checkAdapters()
  console.log(adapters.length ? `  FOUND: ${adapters.join(' | ')}` : '  none found (clean)')

  console.log('\n=== VERDICT ===')
  console.log(`public IP : ${[...ips].join(', ') || 'unknown (UDP blocked?)'}`)
  console.log(`NAT type  : ${natType}${natType === 'SYMMETRIC' ? '  <- libjuice/native cannot hole-punch this' : ''}`)
  console.log(`CGNAT     : ${cg.cgnat ? `YES (hop ${cg.cgnat}) -- CANNOT host a free TURN here` : 'no -- has a real public IP path'}`)
  console.log(`adapters  : ${adapters.length ? 'JUNK PRESENT -- likely the errno=65 (disable to clean ICE)' : 'clean'}`)

  console.log('\n=== WHAT THIS MEANS ===')
  if (natType === 'UNKNOWN') {
    console.log('- STUN got no answer: UDP may be blocked/firewalled (that alone breaks P2P).')
  }
  if (adapters.length) {
    console.log('- Try disabling the virtual/VPN adapter(s) above, then retest native --')
    console.log('  they advertise unroutable ICE candidates (the errno=65) that trip up libjuice.')
  }
  if (!cg.cgnat && natType !== 'UNKNOWN') {
    console.log('- NOT CGNAT + real public IP => THIS machine can HOST a free coturn (TURN),')
    console.log('  which fixes native for every hard-NAT peer -- no VPS rental needed.')
    console.log('  (needs a router port-forward for the coturn UDP ports.)')
  }
  if (cg.cgnat) {
    console.log('- CGNAT => cannot host TURN here (no reachable public port). Need a machine')
    console.log('  that is NOT behind CGNAT, or accept WebRTC fallback for this pair.')
  }
  if (natType === 'SYMMETRIC') {
    console.log('- SYMMETRIC NAT is exactly why the native (libjuice) path fails while Chromium')
    console.log('  (WebRTC/file transfer) still gets through. A working TURN relay fixes native.')
  }
}

main()
