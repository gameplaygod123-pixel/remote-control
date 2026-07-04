import { app, Notification } from 'electron'
import { join, extname, basename } from 'path'
import { existsSync, writeFileSync } from 'fs'

// basename() strips any directory components the sender's filename might
// contain -- the two ends of this app are meant to be the user's own
// trusted machines, but there's no reason to trust an incoming name enough
// to let it write outside Downloads.
function uniqueDownloadsPath(name: string): string {
  const safeName = basename(name) || 'download'
  const ext = extname(safeName)
  const stem = basename(safeName, ext)
  const downloadsDir = app.getPath('downloads')

  let candidate = join(downloadsDir, safeName)
  let counter = 1
  while (existsSync(candidate)) {
    candidate = join(downloadsDir, `${stem} (${counter})${ext}`)
    counter++
  }
  return candidate
}

export function saveToDownloads(name: string, data: Uint8Array): string {
  const filePath = uniqueDownloadsPath(name)
  writeFileSync(filePath, data)

  // The agent side in particular usually has no one watching its window --
  // a received file should still be noticeable without needing to check.
  if (Notification.isSupported()) {
    new Notification({
      title: 'Personal Remote',
      body: `Received "${basename(filePath)}" -- saved to Downloads`
    }).show()
  }

  return filePath
}
