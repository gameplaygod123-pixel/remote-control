// Keeps the whole signaling stack alive and self-healing on the machine
// that hosts it (currently the Mac), and -- the important part -- publishes
// the tunnel's current URL to signaling-url.json on GitHub automatically,
// so a tunnel restart needs zero human steps: installed apps (v1.13.0+)
// re-fetch that file on every reconnect and find their way back on their
// own. Run via the com.personalremote.signaling LaunchAgent (see
// launchagent.plist next to this file), which starts it at login and
// restarts it if it ever dies.
//
// What it supervises:
//   1. The signaling server (dist/index.js) -- only spawned if nothing is
//      already listening on the port, so a manually-started server (or a
//      second copy of this supervisor) is left alone rather than fought.
//   2. A cloudflared quick tunnel -- respawned with backoff when it dies.
//      Quick tunnels get a NEW random URL on every start; the URL is
//      parsed from cloudflared's output and pushed to GitHub whenever it
//      differs from what's already published.
//
// The GitHub update goes through `gh api` (the contents API) rather than
// a local git commit+push -- this machine's working copy is actively used
// for development, and a background process mutating it (or racing its
// pushes) would corrupt work in progress. The API writes a clean commit
// to main directly; the dev checkout just `git pull`s it eventually.

import { spawn, execFile } from 'node:child_process'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = 8080
const REPO = 'gameplaygod123-pixel/remote-control'
const FILE_PATH = 'signaling-url.json'
const GH = '/opt/homebrew/bin/gh'
const CLOUDFLARED = '/opt/homebrew/bin/cloudflared'
const NODE = process.execPath
const SERVER_ENTRY = join(__dirname, 'dist', 'index.js')

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
const SERVER_CHECK_INTERVAL_MS = 30_000
const RESPAWN_DELAY_MS = 5_000

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

// ---------- signaling server ----------

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

let serverProcess = null

async function ensureServer() {
  if (serverProcess) return
  if (await isPortListening(PORT)) return // already running (started by hand, or earlier)
  log('signaling server not detected on port', PORT, '-- starting it')
  serverProcess = spawn(NODE, [SERVER_ENTRY], { stdio: 'inherit' })
  serverProcess.once('exit', (code) => {
    log('signaling server exited with code', code, '-- will recheck shortly')
    serverProcess = null
  })
}

// ---------- GitHub publication ----------

function ghApi(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(GH, args, { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
    if (input !== undefined) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

let lastPublishedUrl = null

async function publishUrl(wssUrl) {
  if (wssUrl === lastPublishedUrl) return
  try {
    // Need the current blob sha to update an existing file via the
    // contents API; also tells us if the published value already matches
    // (e.g. supervisor restarted but the tunnel URL didn't change).
    const current = JSON.parse(await ghApi(['api', `/repos/${REPO}/contents/${FILE_PATH}`]))
    const existing = JSON.parse(Buffer.from(current.content, 'base64').toString('utf8'))
    if (existing.url === wssUrl) {
      lastPublishedUrl = wssUrl
      log('GitHub already has the current URL, nothing to publish')
      return
    }
    const newContent = Buffer.from(JSON.stringify({ url: wssUrl }, null, 2) + '\n').toString(
      'base64'
    )
    await ghApi(
      [
        'api',
        '-X',
        'PUT',
        `/repos/${REPO}/contents/${FILE_PATH}`,
        '-f',
        `message=Update signaling URL to ${wssUrl} (auto-published by supervisor)`,
        '-f',
        `content=${newContent}`,
        '-f',
        `sha=${current.sha}`
      ],
      undefined
    )
    lastPublishedUrl = wssUrl
    log('published new signaling URL to GitHub:', wssUrl)
  } catch (error) {
    // Leave lastPublishedUrl unset so the next tunnel-output line (or the
    // periodic retry below) attempts the publish again.
    log('failed to publish URL to GitHub (will retry):', String(error))
  }
}

// ---------- cloudflared tunnel ----------

let currentTunnelUrl = null

function startTunnel() {
  log('starting cloudflared quick tunnel')
  const tunnel = spawn(CLOUDFLARED, ['tunnel', '--url', `http://localhost:${PORT}`])

  function scan(chunk) {
    const match = TUNNEL_URL_PATTERN.exec(chunk.toString())
    if (match) {
      const wssUrl = match[0].replace('https://', 'wss://')
      if (wssUrl !== currentTunnelUrl) {
        currentTunnelUrl = wssUrl
        log('tunnel URL:', wssUrl)
        void publishUrl(wssUrl)
      }
    }
  }

  // cloudflared prints the assigned URL to stderr (inside an ASCII box).
  tunnel.stdout.on('data', scan)
  tunnel.stderr.on('data', scan)

  tunnel.once('exit', (code) => {
    log('cloudflared exited with code', code, `-- restarting in ${RESPAWN_DELAY_MS}ms`)
    currentTunnelUrl = null
    setTimeout(startTunnel, RESPAWN_DELAY_MS)
  })
}

// ---------- main ----------

log('supervisor starting (server port', PORT, ')')
void ensureServer()
setInterval(() => void ensureServer(), SERVER_CHECK_INTERVAL_MS)
startTunnel()
// Retry a failed GitHub publish periodically even if cloudflared prints
// nothing new -- covers "GitHub was briefly unreachable right after the
// tunnel came up".
setInterval(() => {
  if (currentTunnelUrl && currentTunnelUrl !== lastPublishedUrl) {
    void publishUrl(currentTunnelUrl)
  }
}, SERVER_CHECK_INTERVAL_MS)
