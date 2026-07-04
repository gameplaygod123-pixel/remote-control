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
  nativeImage
} from 'electron'
import { join } from 'path'
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

// Agent mode runs on the Windows target (captures screen, injects input).
// Controller mode runs on the Mac (views the stream, sends input).
// Selected via APP_MODE env var; defaults to controller for local dev.
export type AppMode = 'agent' | 'controller'
const appMode: AppMode = process.env.APP_MODE === 'agent' ? 'agent' : 'controller'

// Separate userData dirs so running an agent and a controller process at the
// same time on one machine (as in local Phase 3/4 testing) don't collide on
// the same Chromium profile storage. Real deployments run on separate
// machines anyway, so this only matters for same-machine dev/testing.
app.setPath('userData', join(app.getPath('userData'), appMode))

// Phase 1 dev harness: opens a "source" (screen-capturing) window and a
// "viewer" window in the same process, and relays WebRTC signaling messages
// between them via IPC. Stands in for the real signaling server until Phase 3.
const loopbackTest = process.env.LOOPBACK_TEST === '1'

// Phase 2 dev harness: an "injector-test" window with buttons that trigger
// real nut.js mouse/keyboard injection, and a "capture-test" window that logs
// local DOM mouse/keyboard events. Independent of each other on purpose --
// this validates each side in isolation before wiring them together (Phase 5).
const inputTest = process.env.INPUT_TEST === '1'

// Set by start-agent-background.bat (the auto-start-at-boot launcher) so
// the agent comes up tray-only, like Parsec's host app, instead of
// popping a window every time Windows logs in. Manual launches (plain
// start-agent.bat/.vbs) still show the window normally.
const startHidden = process.env.START_HIDDEN === '1'

// Not null/undefined once the agent's tray icon exists -- Quit in its
// context menu is the only thing allowed to actually close the window
// rather than hiding it (see setupAgentTray below).
let isQuitting = false

function createBrowserWindow(searchParams?: string, hidden = false): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
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

function createWindow(): void {
  const win = createBrowserWindow(undefined, appMode === 'agent' && startHidden)
  win.setTitle(`Personal Remote - ${appMode}`)

  if (appMode === 'agent') setupAgentTray(win)
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
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.personalremote.app')

  // macOS ignores BrowserWindow's `icon` option for the Dock -- the Dock
  // icon needs to be set separately. Only matters for dev (`pnpm dev`);
  // a packaged .app already gets its Dock icon from build/icon.icns.
  app.dock?.setIcon(icon)

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('get-mode', (): AppMode => appMode)

  ipcMain.handle('input:move', (_event, x: number, y: number) => moveMouse(x, y))
  ipcMain.handle('input:click', (_event, button: 'left' | 'right') => clickMouse(button))
  ipcMain.handle('input:type', (_event, text: string) => typeText(text))
  ipcMain.handle('input:get-position', () => getMousePosition())
  ipcMain.handle('input:mouse-button', (_event, button: 'left' | 'right' | 'middle', down: boolean) =>
    mouseButtonToggle(button, down)
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
    else createWindow()
  }

  launchWindows()

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
