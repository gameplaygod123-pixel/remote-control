import { app, shell, BrowserWindow, ipcMain, session, desktopCapturer, clipboard } from 'electron'
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

function createBrowserWindow(searchParams?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
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
  const win = createBrowserWindow()
  win.setTitle(`Remote Control - ${appMode}`)
}

function createLoopbackWindows(): void {
  const source = createBrowserWindow('role=source')
  const viewer = createBrowserWindow('role=viewer')
  source.setTitle('Remote Control - loopback source')
  viewer.setTitle('Remote Control - loopback viewer')

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
  injectorTest.setTitle('Remote Control - injector test')
  captureTest.setTitle('Remote Control - capture test')
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

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
