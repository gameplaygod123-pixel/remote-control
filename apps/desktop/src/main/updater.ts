import { app, dialog, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

// Re-checks periodically since this app (especially the agent, running
// unattended in the tray after auto-start at boot) can stay open for days
// without a manual restart -- a startup-only check would miss releases
// published in between. A manual "check now" button (see the IPC handler
// below) covers the "I just published a release, want it right away"
// case without waiting for either of these.
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export type UpdaterStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

function broadcast(status: UpdaterStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updater:status', status)
  }
}

// electron-updater reads its feed from the `publish` block in
// electron-builder.yml (a GitHub Releases feed) -- no token needed to read
// it as long as the repo/releases are public, only to publish a new
// release from the build machine.
export function initAutoUpdater(): void {
  // Only a packaged, installed build has a real update feed to check
  // against and a real installer to replace itself with -- running via
  // `pnpm dev` would just fail every check with a confusing error. Still
  // register the manual-check IPC so the renderer's button has something
  // to call and can show a clear reason instead of throwing.
  if (!app.isPackaged) {
    ipcMain.handle('updater:check-now', () =>
      broadcast({
        state: 'error',
        message: 'updates only work in a packaged build, not `pnpm dev`'
      })
    )
    ipcMain.handle('updater:restart-now', () => {})
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    broadcast({ state: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', () => broadcast({ state: 'not-available' }))
  autoUpdater.on('download-progress', (progress) =>
    broadcast({ state: 'downloading', percent: Math.round(progress.percent) })
  )
  autoUpdater.on('error', (error) => broadcast({ state: 'error', message: error.message }))

  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ state: 'downloaded', version: info.version })
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update ready',
        message: `Personal Remote ${info.version} has been downloaded.`,
        detail:
          'Restart now to install it, or it installs automatically the next time the app closes.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
  })

  ipcMain.handle('updater:check-now', () =>
    autoUpdater
      .checkForUpdates()
      .catch((error) => broadcast({ state: 'error', message: String(error) }))
  )
  ipcMain.handle('updater:restart-now', () => autoUpdater.quitAndInstall())

  autoUpdater.checkForUpdates().catch((error) => console.error('auto-update check failed:', error))
  setInterval(() => {
    autoUpdater
      .checkForUpdates()
      .catch((error) => console.error('auto-update check failed:', error))
  }, RECHECK_INTERVAL_MS)
}
