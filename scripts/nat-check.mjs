// NAT-type checker (dev diagnostic). Sends a STUN Binding Request from ONE local
// UDP socket to TWO different STUN servers and compares the PUBLIC (mapped) port
// each reports back:
//   - SAME public port from both servers  -> CONE NAT  = hole-punchable (STUN works,
//                                            no TURN needed for this router)
//   - DIFFERENT public port per server     -> SYMMETRIC NAT = NOT hole-punchable
//                                            (this router genuinely needs TURN)
//
// Run on the machine whose network you want to classify (no deps, needs only Node):
//   node scripts/nat-check.mjs
//
// NB: this classifies the ROUTER's NAT, which every machine on that LAN shares --
// so running it on any machine behind the target's router answers whether the
// target needs TURN. It does NOT catch per-machine issues (a machine's own
// firewall, a VPN/VM virtual adapter, or a second NAT from a WiFi extender).

import dgram from 'node:dgram'
import crypto from 'node:crypto'

const SERVERS = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
  { host: 'stun.nextcloud.com', port: 443 }
]
const MAGIC = 0x2112a442
const MAGIC_BUF = Buffer.alloc(4)
MAGIC_BUF.writeUInt32BE(MAGIC, 0)

function buildRequest() {
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0) // Binding Request
  buf.writeUInt16BE(0x0000, 2) // length 0
  buf.writeUInt32BE(MAGIC, 4) // magic cookie
  crypto.randomFillSync(buf, 8, 12) // transaction id
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
        // XOR-MAPPED-ADDRESS
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

function query(server) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      try {
        sock.close()
      } catch {
        /* already closed */
      }
      resolve(r)
    }
    sock.on('message', (msg) => finish(parseMapped(msg)))
    sock.on('error', () => finish(null))
    // Bind to a FIXED local port so all three queries share the same mapping test.
    sock.bind(54999, () => {
      const req = buildRequest()
      sock.send(req, server.port, server.host, (err) => {
        if (err) finish(null)
      })
    })
    setTimeout(() => finish(null), 4000)
  })
}

async function main() {
  console.log('NAT-type check -- querying STUN servers from local port 54999...\n')
  const results = []
  for (const s of SERVERS) {
    const r = await query(s)
    console.log(`  ${s.host}:${s.port}  ->  ${r ? `${r.ip}:${r.port}` : 'no response'}`)
    if (r) results.push(r)
  }
  console.log('')
  if (results.length < 2) {
    console.log('INCONCLUSIVE: not enough STUN responses (UDP may be blocked / firewall).')
    console.log('That itself is a red flag -- UDP being blocked would also break direct P2P.')
    process.exit(0)
  }
  const ports = new Set(results.map((r) => r.port))
  const ips = new Set(results.map((r) => r.ip))
  console.log(`public IP(s): ${[...ips].join(', ')}`)
  console.log(`public port(s): ${[...results.map((r) => r.port)].join(', ')}\n`)
  if (ports.size === 1) {
    console.log('=> CONE NAT (hole-punchable). STUN works; this router does NOT need TURN.')
    console.log('   The target failing cross-network is then a PER-MACHINE issue on it')
    console.log('   (its own firewall, a VPN/VM adapter, or a 2nd NAT via a WiFi extender).')
  } else {
    console.log('=> SYMMETRIC NAT (different public port per destination).')
    console.log('   NOT hole-punchable by STUN -- this router genuinely needs a TURN relay.')
  }
}

main()
