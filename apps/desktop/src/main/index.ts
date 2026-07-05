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
import { statSync } from 'fs'
import { readFile } from 'fs/promises'
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
import { initAutoUpdater } from './updater'
import { saveToDownloads } from './fileTransfer'
import { getCachedPin, setCachedPin, clearCachedPin, setLastDeviceId } from './controllerMemory'
import { startInputHelperHost, type InputHelperHost } from './inputHelperHost'

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

function createWindow(appMode: AppMode): void {
  // The agent window is a fixed-size credentials card -- everything on it
  // has one natural size, so resizing only ever makes it look broken. The
  // controller stays fully resizable: the Computers grid reflows and the
  // session view needs maximize/fullscreen.
  const win = createBrowserWindow(
    undefined,
    appMode === 'agent' && startHidden,
    appMode === 'agent'
      ? { width: 680, height: 700, resizable: false, maximizable: false, fullscreenable: false }
      : undefined
  )
  win.setTitle(`Personal Remote - ${appMode}`)

  if (appMode === 'agent') {
    agentWindow = win
    setupAgentTray(win)
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

  // The installed app previously had *no* auto-start mechanism at all --
  // the old enable-autostart.vbs script only ever applied to the dev-mode
  // source checkout (a Startup-folder shortcut to start-agent-background.vbs),
  // which doesn't exist once that folder is deleted after installing the
  // real packaged app. Only the agent needs this: it's the side that has
  // to be reachable for incoming connections after an unattended reboot.
  // Safe to call on every launch -- it's how Electron expects this to be
  // kept in sync (e.g. if the install path ever changes after an update).
  if (app.isPackaged && appMode === 'agent') {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })
  }

  // Only the agent side ever needs to inject input, so only it spawns the
  // native input-helper process (see inputHelperHost.ts). Started eagerly
  // (not lazily on first pairing) so the helper's native modules are already
  // loaded and it's reporting ready by the time a controller actually pairs,
  // rather than adding first-connection latency.
  let inputHelperHost: InputHelperHost | undefined
  if (appMode === 'agent') {
    inputHelperHost = startInputHelperHost({
      onOffer: (sdp) => agentWindow?.webContents.send('input-helper:offer', sdp),
      onIce: (candidate, sdpMid, sdpMLineIndex) =>
        agentWindow?.webContents.send('input-helper:ice', candidate, sdpMid, sdpMLineIndex),
      onDown: () => agentWindow?.webContents.send('input-helper:down')
    })
    app.on('before-quit', () => inputHelperHost?.destroy())
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('get-mode', (): AppMode => appMode)
  ipcMain.handle('get-app-version', (): string => app.getVersion())
  ipcMain.handle('house-token:get', (): string | null => getHouseToken())
  ipcMain.handle('house-token:set', (_event, token: string): void => saveHouseToken(token))

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
    (
      _event,
      candidate: string,
      sdpMid: string | null,
      sdpMLineIndex: number | null
    ): void => inputHelperHost?.remoteIce(candidate, sdpMid, sdpMLineIndex)
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
  ipcMain.handle('input:scroll', (_event, deltaY: number) => scrollMouse(deltaY))
  ipcMain.handle('input:key', (_event, code: string, down: boolean) => keyToggle(code, down))
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
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) launchWindows()
  })
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
