import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  session,
  desktopCapturer,
  clipboard,
  Tray,
  Menu,
  nativeImage,
  dialog
} from 'electron'
import { join, basename } from 'path'
import { statSync, existsSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { execSync } from 'child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  moveMouse,
  clickMouse,
  typeText,
  getMousePosition,
  mouseButtonToggle,
  scrollMouse,
  keyToggle,
  getScreenSize
} from './input/injector'
import {
  getTrustedControllers,
  isTrustedController,
  trustController,
  revokeController
} from './trustedControllers'
import { getOrCreateControllerId } from './controllerIdentity'
import {
  getOrCreateDeviceId as getOrCreateAgentDeviceId,
  getName as getAgentName,
  setName as setAgentName,
  getOrCreatePin,
  setPin as setAgentPin,
  regeneratePin as regenerateAgentPin
} from './agentIdentity'
import { getSavedMode, saveMode, resetMode, type AppMode } from './appModeConfig'
import { getHouseToken, saveHouseToken } from './houseToken'
import { getTheme, saveTheme, type Theme } from './themeConfig'
import { initAutoUpdater } from './updater'
import { saveToDownloads } from './fileTransfer'
import { getCachedPin, setCachedPin, clearCachedPin, setLastDeviceId } from './controllerMemory'
import { startInputHelperHost, type InputHelperHost } from './inputHelperHost'
import { startVideoSenderHost } from './videoSenderHost'
import { startVideoReceiverHost } from './videoReceiverHost'
import {
  attachNativeSurface,
  detachNativeSurface,
  pushNativeAccessUnit,
  setNativeCodec,
  nativeSurfaceAvailable
} from './nativeRenderSurface'
import type { VideoSenderHost, VideoReceiverHost } from '../video-native/shared/ipc'
import type { IceServerConfig, VideoConfig } from '../video-native/shared/contract'
import { getVideoPipeline, saveVideoPipeline, nativePipelineEnabled } from './pipelineConfig'
import type { VideoPipeline } from '../video-native/shared/contract'

export type { AppMode }

// Agent mode runs on the Windows target (captures screen, injects input).
// Controller mode runs on the Mac (views the stream, sends input).
// Set via APP_MODE env var for dev/test runs; a packaged install has no
// such env var, so its mode is instead chosen once on first launch (see
// promptForMode below) and persisted via appModeConfig.
const envMode: AppMode | null =
  process.env.APP_MODE === 'agent'
    ? 'agent'
    : process.env.APP_MODE === 'controller'
      ? 'controller'
      : null

if (envMode) {
  // Dev/test convenience: nest userData by mode so an agent and controller
  // process can run side by side on the same dev machine without
  // colliding on the same Chromium profile storage. A real single-purpose
  // install never needs this -- only one mode ever runs from it, chosen
  // once via the first-launch picker.
  app.setPath('userData', join(app.getPath('userData'), envMode))
}

// Windows input-elevation (Track 1): the forked input-helper only reaches Task
// Manager / UAC-elevated windows when it inherits HIGH integrity, and it can
// only do that if THIS agent process is itself elevated. The PersonalRemoteAgent
// scheduled task launches us elevated at logon, but Windows can start us at
// MEDIUM integrity by other paths too -- a click on the Start-menu/desktop
// shortcut, or the "restart apps after sign-in" feature relaunching the
// previously-running agent via Explorer. A medium launch silently loses
// Task-Manager input (the exact "mouse dies in Task Manager" bug). So if we're
// a packaged install, on Windows, NOT elevated, and the elevated task exists,
// hand off to that task and exit -- its elevated instance takes over.
//
// Gated on the task's existence (not the saved app mode): the task is only ever
// registered on an agent machine that ran the Track 1 installer, so its presence
// already implies "this is the agent." We deliberately DON'T call getSavedMode()
// here -- this runs at module scope, before `app` is ready, where
// app.getPath('userData') still resolves to the default ...\Electron dir instead
// of ...\desktop, so the saved-mode file (and any userData-relative path) reads
// empty. The handoff marker therefore lives under getPath('temp'), which is the
// OS temp dir and is stable before ready. Runs BEFORE requestSingleInstanceLock
// so we never hold the lock the elevated instance needs (no race: we exit
// without ever taking it). A 30s mtime guard breaks any loop if the task somehow
// can't elevate (e.g. UAC policy) -- worst case we fall through and run medium.
if (
  app.isPackaged &&
  process.platform === 'win32' &&
  !isElevatedWindows() &&
  elevatedAgentTaskExists()
) {
  try {
    const handoff = join(app.getPath('temp'), 'personalremote-elevation-handoff')
    const recentlyTried = existsSync(handoff) && Date.now() - statSync(handoff).mtimeMs < 30_000
    if (!recentlyTried) {
      writeFileSync(handoff, String(Date.now()))
      execSync('schtasks /run /tn PersonalRemoteAgent', { stdio: 'ignore' })
      app.exit(0)
    }
  } catch {
    /* couldn't trigger the task -- fall through and run medium (no worse than before) */
  }
}

// Launching the app while it's already running must not open a second copy
// -- two agents fight over registration (same deviceId) and two windows
// just confuse. Instead the duplicate exits immediately and the FIRST
// instance surfaces its window: for a tray-hidden agent, double-clicking
// the app icon again becomes the natural "bring it back" gesture. The lock
// is keyed to userData, so it must be requested AFTER the dev-mode
// nesting above -- that's also what still allows one agent and one
// controller to run side by side in dev.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

// Phase 1 dev harness: opens a "source" (screen-capturing) window and a
// "viewer" window in the same process, and relays WebRTC signaling messages
// between them via IPC. Stands in for the real signaling server until Phase 3.
const loopbackTest = process.env.LOOPBACK_TEST === '1'

// Phase 2 dev harness: an "injector-test" window with buttons that trigger
// real nut.js mouse/keyboard injection, and a "capture-test" window that logs
// local DOM mouse/keyboard events. Independent of each other on purpose --
// this validates each side in isolation before wiring them together (Phase 5).
const inputTest = process.env.INPUT_TEST === '1'

// Two ways this gets set: `START_HIDDEN=1` from start-agent-background.bat
// (the dev-mode launcher script), or a `--hidden` argv flag that this app
// passes to itself via setLoginItemSettings below (the packaged-install
// path). Either way the agent comes up tray-only, like Parsec's host app,
// instead of popping a window every time Windows logs in. Manual launches
// (double-clicking the app / plain start-agent.bat/.vbs) still show the
// window normally.
const startHidden = process.env.START_HIDDEN === '1' || process.argv.includes('--hidden')

// Windows: are we running elevated (high integrity)? The input-elevation feature
// (Track 1) auto-elevates the agent via the PersonalRemoteAgent scheduled task
// (logon + "highest privileges"), so the forked input-helper inherits high
// integrity and can SendInput into Task Manager / run-as-admin windows. `net
// session` needs admin -- it succeeds elevated, errors otherwise. Cheap, runs
// once at startup. Non-Windows has no such model here, so always false.
function isElevatedWindows(): boolean {
  if (process.platform !== 'win32') return false
  try {
    // Read the process token's mandatory integrity level directly. We used to
    // shell out to `net session` (succeeds only when elevated) but that is NOT
    // reliable -- on at least one real machine `net session` returns success
    // from a MEDIUM-integrity process too, so it reported "elevated" always,
    // which silently defeated both the openAtLogin flag logic and the
    // medium->elevated handoff above. whoami /groups lists the mandatory label
    // SID: High = S-1-16-12288, System = S-1-16-16384 (either can inject into
    // elevated windows); Medium = S-1-16-8192.
    const out = execSync('whoami /groups', { encoding: 'utf8' })
    return out.includes('S-1-16-12288') || out.includes('S-1-16-16384')
  } catch {
    return false
  }
}

// Does the elevated-autostart scheduled task exist? Used by the startup handoff
// above to decide whether a medium launch can bounce itself up to elevated.
// `schtasks /query` exits non-zero when the task is absent (machines without
// Track 1 installed) -- there we just run medium as usual.
function elevatedAgentTaskExists(): boolean {
  if (process.platform !== 'win32') return false
  try {
    execSync('schtasks /query /tn PersonalRemoteAgent', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// backgroundThrottling:false on the window wasn't enough on Windows: when
// the agent window is hidden to the tray mid-session, Chromium backgrounds
// the now-occluded window's renderer, and incoming data-channel input
// stops being processed -- video kept flowing (media runs on non-JS
// threads) while the mouse went dead the moment X was clicked. The
// operative switch is disable-backgrounding-occluded-windows; the
// CalculateNativeWinOcclusion feature flag tried first no-ops on the
// Chromium this Electron ships (the feature shipped and its flag was
// retired). All must be set before app ready.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

// Not null/undefined once the agent's tray icon exists -- Quit in its
// context menu is the only thing allowed to actually close the window
// rather than hiding it (see setupAgentTray below).
let isQuitting = false

function createBrowserWindow(
  searchParams?: string,
  hidden = false,
  windowOptions?: Electron.BrowserWindowConstructorOptions
): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    icon,
    ...windowOptions,
    // No OS titlebar -- the app draws its own slim bar (see .app-titlebar
    // in app.css) with the title centered. macOS keeps its floating
    // traffic-light buttons; Windows gets the native min/max/close cluster
    // overlaid via titleBarOverlay, colored to match the bar. The overlay
    // height must match the CSS bar height (38px) or the native buttons
    // misalign with the drawn bar.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { color: '#171210', symbolColor: '#c9beb5', height: 38 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // The agent is designed to live hidden in the tray (auto-start at
      // boot, or the person at the machine clicking X mid-session), and
      // Chromium throttles hidden windows hard -- which stalls the screen
      // capture pipeline, so the controller's video froze the instant the
      // agent window was closed to tray, reading as "mouse stopped
      // working". The stream and input must keep flowing at full rate
      // regardless of window visibility.
      backgroundThrottling: false
    }
  })

  win.on('ready-to-show', () => {
    if (!hidden) win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = process.env['ELECTRON_RENDERER_URL'] + (searchParams ? `?${searchParams}` : '')
    win.loadURL(url)
  } else {
    win.loadFile(
      join(__dirname, '../renderer/index.html'),
      searchParams ? { search: searchParams } : undefined
    )
  }

  return win
}

// Set when appMode === 'agent' so the input-helper host (below) has
// somewhere to forward its offer/ice/down events -- there is only ever one
// agent window per process.
let agentWindow: BrowserWindow | undefined

// Set when appMode === 'controller' so the native video-receiver host has
// somewhere to forward its answer/ice/first-frame/stats/down events. Mirror of
// agentWindow; only one controller window per process.
let controllerWindow: BrowserWindow | undefined

// Whether the controller currently has a LIVE remote session (reported by the
// renderer via 'controller:session-active'). Decides what the window's X does:
// session live -> go back to the main page; main page -> hide to the tray.
let controllerSessionActive = false

// Forward a host-process event to a window's renderer, safely. The host
// callbacks (input/sender/receiver) fire from a ChildProcess, so a stats/ice
// message can arrive AFTER the window has been destroyed (session ended, app
// quitting) -- the `win?.` guard only catches null, not a destroyed webContents,
// and `.send()` on a destroyed object throws "Object has been destroyed" as an
// uncaught exception in the main process. Gate on isDestroyed() for both.
function sendToWindow(win: BrowserWindow | undefined, channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

function createWindow(appMode: AppMode): void {
  // The agent window is a fixed-size credentials card -- everything on it
  // has one natural size, so resizing only ever makes it look broken. The
  // controller stays fully resizable: the Computers grid reflows and the
  // session view needs maximize/fullscreen.
  // The 'glass' theme is a see-through controller. Transparency is fixed at
  // window creation, so on macOS the controller window is ALWAYS created
  // transparent -- dark/light just paint an opaque .ctl-shell over it (looks
  // normal, keeps rounded corners + shadow), glass drops it to ~12% so the
  // desktop shows through. That way the theme toggle works live with no
  // relaunch (important: the owner runs the Mac controller via `electron-vite
  // dev`, where app.relaunch() would just kill the app). Windows can't be
  // transparent without breaking its titleBarOverlay caption buttons, so glass
  // there degrades to a solid dark tint (backgroundColor under the alpha).
  const win = createBrowserWindow(
    undefined,
    appMode === 'agent' && startHidden,
    appMode === 'agent'
      ? { width: 680, height: 700, resizable: false, maximizable: false, fullscreenable: false }
      : process.platform === 'darwin'
        ? { transparent: true, backgroundColor: '#00000000' }
        : { backgroundColor: '#171210' }
  )
  win.setTitle(`Personal Remote - ${appMode}`)

  if (appMode === 'agent') {
    agentWindow = win
    setupAgentTray(win)
  } else if (appMode === 'controller') {
    controllerWindow = win
    setupControllerTray(win)
    // In native-video mode the decoded frames are composited INSIDE this window
    // (an AVSampleBufferDisplayLayer subview added by librvr.dylib -- see
    // nativeRenderSurface.ts / embed.swift), NOT a separate floating NSWindow, so
    // there is no second window to track/stutter/cover/clip. We only need to tell
    // the renderer when the OS fullscreen state changes so it can hide the drag
    // titlebar (pointless + would cover the controls in fullscreen). Gated on
    // the native pipeline being enabled so the default WebRTC window is
    // byte-identical.
    if (nativePipelineEnabled()) {
      win.on('enter-full-screen', () => win.webContents.send('window:fullscreen', true))
      win.on('leave-full-screen', () => win.webContents.send('window:fullscreen', false))
    }
  }
}

// Shown once on a fresh install/first launch when no mode is known yet
// (no APP_MODE env var, nothing saved from a previous run) -- lets a
// packaged app be genuinely "install and go" without needing the person
// to set an environment variable themselves. The choice is persisted via
// saveMode() so this never shows again on the same install.
function promptForMode(): Promise<AppMode> {
  return new Promise((resolve) => {
    const win = createBrowserWindow('role=choose-mode', false, {
      width: 600,
      height: 620,
      resizable: false,
      maximizable: false
    })
    win.setTitle('Personal Remote - Setup')
    ipcMain.once('choose-mode', (_event, mode: AppMode) => {
      win.close()
      resolve(mode)
    })
  })
}

// Parsec-style background operation: the agent needs to keep running (and
// stay reachable for pairing) even when nobody's looking at its window, so
// closing the window hides it instead of quitting. Only the tray menu's
// "Quit" can actually end the process.
function setupAgentTray(win: BrowserWindow): void {
  const trayIcon = nativeImage.createFromPath(icon).resize({ width: 16, height: 16 })
  const tray = new Tray(trayIcon)
  tray.setToolTip('Personal Remote Agent')

  function showWindow(): void {
    win.show()
    win.focus()
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Personal Remote Agent', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showWindow)

  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })
}

// Parsec-style background operation for the CONTROLLER. The X button no longer
// quits: during a live remote session it drops back to the main page (so the
// session ends but the app stays), and on the main page it hides to the tray so
// the controller keeps running in the background and can be re-summoned any time
// (tray icon, or relaunching the app -> the single-instance 'second-instance'
// handler shows it). Only the tray "Quit" actually ends the process. Works on
// Windows and macOS (the tray is a menu-bar item there).
function setupControllerTray(win: BrowserWindow): void {
  const trayIcon = nativeImage.createFromPath(icon).resize({ width: 16, height: 16 })
  const tray = new Tray(trayIcon)
  tray.setToolTip('Personal Remote')

  function showWindow(): void {
    win.show()
    win.focus()
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Personal Remote', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showWindow)

  win.on('close', (event) => {
    if (isQuitting) return // real quit (tray Quit / Cmd+Q via before-quit path)
    event.preventDefault()
    if (controllerSessionActive) {
      // X while controlling -> leave the session, stay on the main page.
      sendToWindow(win, 'controller:go-home')
    } else {
      // X on the main page -> keep running in the background.
      win.hide()
    }
  })
}

function createLoopbackWindows(): void {
  const source = createBrowserWindow('role=source')
  const viewer = createBrowserWindow('role=viewer')
  source.setTitle('Personal Remote - loopback source')
  viewer.setTitle('Personal Remote - loopback viewer')

  const windows = [source, viewer]
  ipcMain.on('signal', (event, message) => {
    for (const win of windows) {
      if (win.webContents.id !== event.sender.id) {
        win.webContents.send('signal', message)
      }
    }
  })
}

function createInputTestWindows(): void {
  const injectorTest = createBrowserWindow('role=injector-test')
  const captureTest = createBrowserWindow('role=capture-test')
  injectorTest.setTitle('Personal Remote - injector test')
  captureTest.setTitle('Personal Remote - capture test')
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.personalremote.app')

  // macOS ignores BrowserWindow's `icon` option for the Dock -- the Dock
  // icon needs to be set separately. Only matters for dev (`pnpm dev`);
  // a packaged .app already gets its Dock icon from build/icon.icns.
  app.dock?.setIcon(icon)

  // Resolve which mode this install actually runs as: an explicit env var
  // (dev/test runs) wins, then a previously-saved choice, and only on a
  // genuinely fresh install does this actually show the picker UI.
  const appMode: AppMode = envMode ?? getSavedMode() ?? (await promptForMode())
  if (!envMode) saveMode(appMode)

  // Autostart (agent only -- it's the side that must be reachable after an
  // unattended reboot). Two possible mechanisms, and they must NOT both fire:
  // the single-instance lock means whichever wins the logon race sticks, so if
  // the medium-integrity `openAtLogin` Run key beats the elevated
  // PersonalRemoteAgent scheduled task (Track 1 auto-elevate), we'd silently
  // drop back to medium integrity and Task Manager input dies again.
  //
  // Once the elevated scheduled task has launched us even once it drops a flag
  // file; from then on the task is the SOLE autostart and we keep the medium Run
  // key OFF -- even on later non-elevated manual launches. Machines without the
  // task (flag never written) keep the medium openAtLogin fallback unchanged.
  if (app.isPackaged && appMode === 'agent') {
    const elevatedAutostartFlag = join(app.getPath('userData'), 'elevated-autostart.flag')
    const elevated = isElevatedWindows()
    if (elevated) {
      try {
        writeFileSync(elevatedAutostartFlag, '1')
      } catch {
        /* best effort -- worst case we fall back to the medium Run key below */
      }
    }
    if (elevated || existsSync(elevatedAutostartFlag)) {
      app.setLoginItemSettings({ openAtLogin: false })
    } else {
      app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })
    }
  }

  // Only the agent side ever needs to inject input, so only it spawns the
  // native input-helper process (see inputHelperHost.ts). Started eagerly
  // (not lazily on first pairing) so the helper's native modules are already
  // loaded and it's reporting ready by the time a controller actually pairs,
  // rather than adding first-connection latency.
  let inputHelperHost: InputHelperHost | undefined
  if (appMode === 'agent') {
    inputHelperHost = startInputHelperHost({
      onOffer: (sdp) => sendToWindow(agentWindow, 'input-helper:offer', sdp),
      onIce: (candidate, sdpMid, sdpMLineIndex) =>
        sendToWindow(agentWindow, 'input-helper:ice', candidate, sdpMid, sdpMLineIndex),
      onDown: () => sendToWindow(agentWindow, 'input-helper:down')
    })
    app.on('before-quit', () => inputHelperHost?.destroy())
  }

  // Native video SENDER helper (agent only), and ONLY when explicitly opted in
  // via VIDEO_PIPELINE=native. This is the SAFETY BAR: a default build (no env)
  // never spawns this process, so the entire WebRTC video path is byte-identical
  // to today. When engaged, the agent still only ADVERTISES the native-video cap
  // if both this host isReady() AND the controller advertised it (AgentView), so
  // a spawned-but-unpaired host changes nothing on its own. See
  // docs/native-video-plan.md + video-native/shared/{contract,ipc}.ts.
  let videoSenderHost: VideoSenderHost | undefined
  if (appMode === 'agent' && nativePipelineEnabled()) {
    videoSenderHost = startVideoSenderHost({
      onOffer: (sdp) => sendToWindow(agentWindow, 'video-sender:offer', sdp),
      onIce: (candidate, sdpMid, sdpMLineIndex) =>
        sendToWindow(agentWindow, 'video-sender:ice', candidate, sdpMid, sdpMLineIndex),
      onStats: (stats) => sendToWindow(agentWindow, 'video-sender:stats', stats),
      onDown: () => sendToWindow(agentWindow, 'video-sender:down')
    })
    app.on('before-quit', () => videoSenderHost?.destroy())
  }

  // Native video RECEIVER helper (controller only), and ONLY when explicitly
  // opted in via VIDEO_PIPELINE=native -- the controller-side SAFETY BAR, exact
  // mirror of the sender above. A default build (no env) never spawns it, so
  // isReady() is always false and ControllerSession never engages the native
  // path: the WebRTC <video> path stays byte-identical to today.
  let videoReceiverHost: VideoReceiverHost | undefined
  // Attach the in-process render surface (librvr.dylib) lazily on the first AU,
  // when the window is realized + shown. Idempotent in the dylib, but we also
  // gate here so we only pass the NSView handle once per session.
  let surfaceAttached = false
  const detachSurface = (): void => {
    if (!surfaceAttached) return
    surfaceAttached = false
    detachNativeSurface()
    // Release the aspect lock so the window is free-form again for the
    // computers-list / file-transfer views.
    if (controllerWindow && !controllerWindow.isDestroyed()) {
      controllerWindow.setAspectRatio(0)
    }
  }
  if (appMode === 'controller' && nativePipelineEnabled()) {
    videoReceiverHost = startVideoReceiverHost({
      onAnswer: (sdp) => sendToWindow(controllerWindow, 'video-receiver:answer', sdp),
      onIce: (candidate, sdpMid, sdpMLineIndex) =>
        sendToWindow(controllerWindow, 'video-receiver:ice', candidate, sdpMid, sdpMLineIndex),
      // Each reassembled Annex-B access unit -> the in-process render surface,
      // which decodes (VideoToolbox) + composites it inside THIS window.
      onAu: (au) => {
        if (!surfaceAttached && controllerWindow && !controllerWindow.isDestroyed()) {
          surfaceAttached = attachNativeSurface(controllerWindow.getNativeWindowHandle())
          if (surfaceAttached) {
            // Lock the session window to the remote's aspect (1920x1080 agent) so
            // the in-window video fills it with no letterbox + the input mapping
            // is pixel-exact. Released on detach. Also snap the CURRENT size to
            // 16:9 once (setAspectRatio only constrains future user-resizes), so a
            // windowed session isn't letterboxed with black bars on connect.
            controllerWindow.setAspectRatio(16 / 9)
            if (!controllerWindow.isFullScreen()) {
              const [w, h] = controllerWindow.getContentSize()
              const targetH = Math.round((w * 9) / 16)
              if (Math.abs(targetH - h) > 2) controllerWindow.setContentSize(w, targetH)
            }
          }
        }
        pushNativeAccessUnit(au)
      },
      // Codec detected from the offer -> set the in-process decoder (H.264 vs HEVC)
      // BEFORE the first AU, so it builds the correct CMFormatDescription.
      onCodec: (codec) => setNativeCodec(codec),
      onFirstFrame: () => sendToWindow(controllerWindow, 'video-receiver:first-frame'),
      onStats: (stats) => sendToWindow(controllerWindow, 'video-receiver:stats', stats),
      // BWE: the receiver's AIMD target -> renderer relays it over signaling as
      // 'video-bitrate' to the agent (which forwards it to the capturer stdin).
      onBitrate: (kbps) => sendToWindow(controllerWindow, 'video-receiver:bitrate', kbps),
      onDown: () => {
        detachSurface()
        sendToWindow(controllerWindow, 'video-receiver:down')
      }
    })
    app.on('before-quit', () => videoReceiverHost?.destroy())
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // The controller renderer reports whether a remote session is live, so the
  // window's X can go-back-to-main vs hide-to-tray (see setupControllerTray).
  ipcMain.on('controller:session-active', (_event, active: boolean) => {
    controllerSessionActive = active === true
  })

  ipcMain.handle('get-mode', (): AppMode => appMode)
  ipcMain.handle('get-app-version', (): string => app.getVersion())
  ipcMain.handle('house-token:get', (): string | null => getHouseToken())
  ipcMain.handle('house-token:set', (_event, token: string): void => saveHouseToken(token))
  ipcMain.handle('theme:get', (): Theme => getTheme())
  // The macOS controller window is always transparent (see createWindow), so
  // every theme -- including glass -- just re-skins live via CSS; no relaunch.
  ipcMain.handle('theme:set', (_event, theme: Theme): void => saveTheme(theme))
  // Video-pipeline preference (webrtc <-> native), persisted per-machine.
  // Reports the saved value (NOT env-resolved) so the UI reflects what's stored;
  // takes effect on the NEXT session/relaunch since the host processes are wired
  // at startup. Native still only actually engages if both peers negotiate the
  // cap + the helper hosts are ready -- else it falls back to WebRTC.
  ipcMain.handle('pipeline:get', (): VideoPipeline => getVideoPipeline())
  ipcMain.handle('pipeline:set', (_event, pipeline: VideoPipeline): void =>
    saveVideoPipeline(pipeline)
  )

  // Bridges the agent renderer to the input-helper process (see
  // inputHelperHost.ts). No-ops in controller mode, where inputHelperHost is
  // never created -- ControllerSession.tsx never calls these.
  ipcMain.handle('input-helper:is-ready', (): boolean => inputHelperHost?.isReady() ?? false)
  ipcMain.handle('input-helper:start-session', (): void => inputHelperHost?.startSession())
  ipcMain.handle('input-helper:stop-session', (): void => inputHelperHost?.stopSession())
  ipcMain.handle('input-helper:remote-answer', (_event, sdp: string): void =>
    inputHelperHost?.remoteAnswer(sdp)
  )
  ipcMain.handle(
    'input-helper:remote-ice',
    (_event, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): void =>
      inputHelperHost?.remoteIce(candidate, sdpMid, sdpMLineIndex)
  )

  // Bridges the agent renderer to the native video-sender process (see
  // videoSenderHost.ts). All no-op / not-ready unless VIDEO_PIPELINE=native
  // spawned the host above, so a default build reports not-ready and AgentView
  // never engages the native path -- the WebRTC default stands.
  ipcMain.handle('video-sender:is-ready', (): boolean => videoSenderHost?.isReady() ?? false)
  ipcMain.handle(
    'video-sender:start-session',
    (_event, config: VideoConfig, iceServers?: IceServerConfig[]): void =>
      videoSenderHost?.startSession(config, iceServers)
  )
  ipcMain.handle('video-sender:stop-session', (): void => videoSenderHost?.stopSession())
  ipcMain.handle('video-sender:remote-answer', (_event, sdp: string): void =>
    videoSenderHost?.remoteAnswer(sdp)
  )
  ipcMain.handle(
    'video-sender:remote-ice',
    (_event, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): void =>
      videoSenderHost?.remoteIce(candidate, sdpMid, sdpMLineIndex)
  )
  // BWE: a 'video-bitrate' signaling msg from the Mac receiver's AIMD arrives at
  // the agent renderer and is forwarded here -> helper -> capturer stdin 'B<kbps>'.
  ipcMain.handle('video-sender:set-bitrate', (_event, kbps: number): void =>
    videoSenderHost?.setBitrate(kbps)
  )

  // Bridges the controller renderer to the native video-receiver process (see
  // videoReceiverHost.ts). Reports ready only when the host spawned AND the
  // in-process render surface (librvr.dylib) can actually load -- otherwise the
  // controller must NOT advertise native-video, or a machine that spawned the
  // receiver but can't paint (dylib missing / not built) would negotiate native
  // and black-screen with no fallback. Requiring the surface here keeps the
  // automatic WebRTC fallback total. Not-ready in a default WebRTC-preference
  // build (host never spawned) -- the controller-side SAFETY BAR.
  ipcMain.handle(
    'video-receiver:is-ready',
    (): boolean => (videoReceiverHost?.isReady() ?? false) && nativeSurfaceAvailable()
  )
  ipcMain.handle('video-receiver:start-session', (): void => videoReceiverHost?.startSession())
  ipcMain.handle('video-receiver:stop-session', (): void => {
    detachSurface()
    videoReceiverHost?.stopSession()
  })
  ipcMain.handle('video-receiver:remote-offer', (_event, sdp: string): void =>
    videoReceiverHost?.remoteOffer(sdp)
  )
  ipcMain.handle(
    'video-receiver:remote-ice',
    (_event, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): void =>
      videoReceiverHost?.remoteIce(candidate, sdpMid, sdpMLineIndex)
  )

  // Explicit escape hatch for the "deleted and reinstalled, mode picker
  // never showed again" case -- uninstalling doesn't clear userData, so
  // getSavedMode() above would otherwise keep finding the old choice
  // forever. Confirms first since it force-restarts the app.
  ipcMain.handle('app-mode:reset', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      type: 'warning' as const,
      title: 'Switch mode',
      message: 'Switch this install between Controller and Agent mode?',
      detail:
        'The app will restart and ask you to choose again. Saved trust/PIN/device settings are kept either way, not deleted.',
      buttons: ['Switch mode', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    if (response !== 0) return
    resetMode()
    app.relaunch()
    app.exit()
  })

  ipcMain.handle('input:move', (_event, x: number, y: number) => moveMouse(x, y))
  ipcMain.handle('input:click', (_event, button: 'left' | 'right') => clickMouse(button))
  ipcMain.handle('input:type', (_event, text: string) => typeText(text))
  ipcMain.handle('input:get-position', () => getMousePosition())
  ipcMain.handle(
    'input:mouse-button',
    (_event, button: 'left' | 'right' | 'middle', down: boolean) => mouseButtonToggle(button, down)
  )
  ipcMain.handle('input:scroll', (_event, deltaY: number, deltaX?: number, px?: boolean) =>
    scrollMouse(deltaY, deltaX ?? 0, px === true)
  )
  ipcMain.handle('input:key', (_event, code: string, down: boolean, scan?: boolean) =>
    keyToggle(code, down, scan === true)
  )
  ipcMain.handle('input:get-screen-size', () => getScreenSize())

  // Low-res preview for the controller's device list -- deliberately using
  // desktopCapturer's own downscaled thumbnail (cheap, no separate encode
  // step) rather than reusing the full getDisplayMedia/WebRTC video path,
  // which only exists once a controller has actually paired for a session.
  ipcMain.handle('agent:capture-thumbnail', async (): Promise<string | null> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 320, height: 200 }
    })
    const thumbnail = sources[0]?.thumbnail
    if (!thumbnail || thumbnail.isEmpty()) return null
    return `data:image/jpeg;base64,${thumbnail.toJPEG(70).toString('base64')}`
  })

  // navigator.clipboard.writeText() can be flaky in Electron depending on
  // document focus; the native clipboard module always works.
  ipcMain.handle('clipboard:write', (_event, text: string) => clipboard.writeText(text))
  // Read side of clipboard sync -- polled by the renderer while a session
  // is connected (see shared/clipboard/clipboardSync.ts).
  ipcMain.handle('clipboard:read', () => clipboard.readText())

  // Writes a file received over the WebRTC file-transfer data channel to
  // this machine's Downloads folder -- the renderer can't write to disk
  // directly (no Node integration there), so the assembled bytes cross
  // into the main process just for this one call.
  ipcMain.handle('file-transfer:save', (_event, name: string, data: Uint8Array) =>
    saveToDownloads(name, data)
  )

  // File picking goes through the main process rather than a renderer
  // <input type=file>: a hidden (display:none) file input's programmatic
  // .click() does not reliably open the native dialog in this Electron build
  // -- clicking "เลือกไฟล์" just did nothing (v1.19.2 report). The native
  // dialog here always works and returns real paths.
  ipcMain.handle(
    'dialog:pick-files',
    async (event): Promise<{ path: string; name: string; size: number }[]> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await (win
        ? dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
        : dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] }))
      if (result.canceled) return []
      return result.filePaths.map((p) => ({
        path: p,
        name: basename(p),
        size: statSync(p).size
      }))
    }
  )

  // Reads a picked file's bytes for sending. Whole-file into memory, matching
  // what the renderer's File.arrayBuffer() path already did -- fine for the
  // personal-scale transfers this tool handles.
  ipcMain.handle('file:read', async (_event, path: string): Promise<Uint8Array> => {
    return new Uint8Array(await readFile(path))
  })

  // Used by the controller to go fullscreen once a remote session connects,
  // and back to windowed when returning to the device list.
  ipcMain.handle('window:set-fullscreen', (event, value: boolean) => {
    BrowserWindow.fromWebContents(event.sender)?.setFullScreen(value)
  })

  // Used by the agent to un-hide itself from the tray when an untrusted
  // controller needs a human decision -- the window may have started
  // hidden (auto-start at boot) or been minimized to tray earlier.
  ipcMain.handle('window:show', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
    win?.focus()
  })

  // Persisted as a plain file (not renderer localStorage) so a Vite
  // dev-server port change between runs can never make an agent forget
  // who it already trusted, or a controller forget its own identity.
  ipcMain.handle('trusted:list', () => getTrustedControllers())
  ipcMain.handle('trusted:is-trusted', (_event, id: string) => isTrustedController(id))
  ipcMain.handle('trusted:trust', (_event, id: string) => trustController(id))
  ipcMain.handle('trusted:revoke', (_event, id: string) => revokeController(id))
  ipcMain.handle('controller:get-id', () => getOrCreateControllerId())

  // Same file-based persistence rationale as trusted/controllerId above --
  // lets the controller jump straight back into its last session on next
  // launch instead of always landing on the device picker.
  ipcMain.handle('controller-memory:get-cached-pin', (_event, deviceId: string) =>
    getCachedPin(deviceId)
  )
  ipcMain.handle('controller-memory:set-cached-pin', (_event, deviceId: string, pin: string) =>
    setCachedPin(deviceId, pin)
  )
  ipcMain.handle('controller-memory:clear-cached-pin', (_event, deviceId: string) =>
    clearCachedPin(deviceId)
  )
  ipcMain.handle('controller-memory:set-last-device-id', (_event, deviceId: string) =>
    setLastDeviceId(deviceId)
  )

  // The agent's own identity: device ID, display name, and pairing PIN, all
  // persisted to a file instead of the old renderer-localStorage/VITE_PIN
  // approach. getOrCreatePin seeds from the legacy VITE_PIN env var (if the
  // launcher script still sets one) only on the very first run after
  // updating, so an already-paired setup doesn't get a surprise new PIN.
  ipcMain.handle('agent-identity:get-device-id', () => getOrCreateAgentDeviceId())
  ipcMain.handle('agent-identity:get-name', () => getAgentName())
  ipcMain.handle('agent-identity:set-name', (_event, name: string) => setAgentName(name))
  ipcMain.handle('agent-identity:get-pin', () => getOrCreatePin(process.env.VITE_PIN))
  ipcMain.handle('agent-identity:set-pin', (_event, pin: string) => setAgentPin(pin))
  ipcMain.handle('agent-identity:regenerate-pin', () => regenerateAgentPin())

  // Grant getUserMedia/getDisplayMedia requests from the renderer (needed for screen capture).
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })

  // Auto-select the primary screen for getDisplayMedia instead of showing the OS picker,
  // since this app captures its own machine's screen rather than letting the user choose.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0] })
      })
    },
    { useSystemPicker: false }
  )

  function launchWindows(): void {
    if (loopbackTest) createLoopbackWindows()
    else if (inputTest) createInputTestWindows()
    else createWindow(appMode)
  }

  launchWindows()
  initAutoUpdater()

  app.on('activate', function () {
    // On macOS, clicking the dock icon re-creates a window if none exist, OR
    // re-shows one that's been hidden to the tray (the controller's
    // background/Parsec mode) -- otherwise a tray-hidden controller couldn't be
    // brought back from the dock.
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (wins.length === 0) {
      launchWindows()
      return
    }
    const win = wins[0]
    win.show()
    win.focus()
  })
})

// Any real quit path (macOS Cmd+Q / app menu Quit / app.quit()) must actually
// close, not get trapped by the tray windows' close->hide handlers. Mark it as a
// quit BEFORE the windows receive their 'close' events so those handlers allow
// it. The tray "Quit" also sets isQuitting; this covers Cmd+Q on macOS (the
// controller's home).
app.on('before-quit', () => {
  isQuitting = true
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
