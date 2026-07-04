import { useEffect, useState } from 'react'
import type { UpdaterStatus } from '../../../../main/updater'

// A small always-present control so a new release can be picked up on
// demand -- e.g. right after publishing one -- instead of waiting for the
// periodic background check or a restart. Meant to be rendered inside
// each screen's own footer bar (not fixed-position) -- the shared
// `.footer-link` class uses `color: inherit` so it reads correctly in
// both the default app.css theme (Agent) and the dark-brown device list
// theme (Controller) without needing per-theme overrides.
export default function UpdateBadge(): React.JSX.Element {
  const [status, setStatus] = useState<UpdaterStatus | null>(null)

  useEffect(() => {
    window.api.updater.onStatus(setStatus)
  }, [])

  function label(): string {
    if (!status) return 'Check for updates'
    switch (status.state) {
      case 'checking':
        return 'Checking for updates...'
      case 'available':
        return `Downloading v${status.version}...`
      case 'downloading':
        return `Downloading update... ${status.percent}%`
      case 'downloaded':
        return `Restart to install v${status.version}`
      case 'not-available':
        return 'Up to date'
      case 'error':
        return 'Check for updates'
    }
  }

  function handleClick(): void {
    if (status?.state === 'downloaded') {
      window.api.updater.restartNow()
    } else if (status?.state !== 'checking' && status?.state !== 'downloading') {
      window.api.updater.checkNow()
    }
  }

  const busy =
    status?.state === 'checking' || status?.state === 'downloading' || status?.state === 'available'

  return (
    <button
      className="footer-link"
      onClick={handleClick}
      disabled={busy}
      title={status?.state === 'error' ? status.message : undefined}
    >
      {label()}
    </button>
  )
}
