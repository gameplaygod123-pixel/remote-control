import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

// Re-checks periodically since this app (especially the agent, running
// unattended in the tray after auto-start at boot) can stay open for days
// without a manual restart -- a startup-only check would miss releases
// published in between.
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

// electron-updater reads its feed from the `publish` block in
// electron-builder.yml (a public GitHub Releases feed -- no token needed
// to read it, only to publish a new release from the build machine).
export function initAutoUpdater(): void {
  // Only a packaged, installed build has a real update feed to check
  // against and a real installer to replace itself with -- running via
  // `pnpm dev` would just fail every check with a confusing error.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', () => {
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update ready',
        message: 'A new version of Personal Remote has been downloaded.',
        detail: 'Restart now to install it, or it installs automatically the next time the app closes.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
  })

  autoUpdater.on('error', (error) => {
    console.error('auto-update check failed:', error)
  })

  autoUpdater.checkForUpdates().catch((error) => console.error('auto-update check failed:', error))
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((error) => console.error('auto-update check failed:', error))
  }, RECHECK_INTERVAL_MS)
}
