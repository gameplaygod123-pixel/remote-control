import { useState } from 'react'
import DeviceListView from './DeviceListView'
import FileTransferView from './FileTransferView'
import ControllerSession from './ControllerSession'
import TitleBar from '../shared/components/TitleBar'
import { AUTO_CONNECT_DEVICE_ID, FIXED_PIN } from '../shared/config'

interface ActiveDevice {
  deviceId: string
  pin: string
  name?: string
}

// If VITE_DEVICE_ID/VITE_PIN are set (the single-device launcher scripts),
// skip the device list entirely and connect straight away, preserving the
// old zero-click behavior for a one-agent setup. This is an explicit,
// opt-in dev/launcher-script mechanism -- unlike the auto-connect-to-last-
// device behavior this file used to also have, which silently jumped
// straight into a fullscreened session on every launch with no way to
// land on the device list first. Removed after that turned out to be the
// opposite of what was wanted in practice.
const ENV_AUTO_CONNECT: ActiveDevice | null =
  AUTO_CONNECT_DEVICE_ID && FIXED_PIN ? { deviceId: AUTO_CONNECT_DEVICE_ID, pin: FIXED_PIN } : null

type Page = 'computers' | 'files'

function ComputersIcon(): React.JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 21h6M12 17v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function FilesIcon(): React.JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path
        d="M8 17V7m0 0L4.5 10.5M8 7l3.5 3.5M16 7v10m0 0l3.5-3.5M16 17l-3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ControllerView(): React.JSX.Element {
  const [activeDevice, setActiveDevice] = useState<ActiveDevice | null>(ENV_AUTO_CONNECT)
  const [page, setPage] = useState<Page>('computers')

  function handleConnect(deviceId: string, pin: string, name?: string): void {
    window.api.controllerMemory.setLastDeviceId(deviceId)
    setActiveDevice({ deviceId, pin, name })
  }

  // A live session takes the whole window -- no sidebar, no titlebar row;
  // its own floating controls handle everything (see ControllerSession).
  if (activeDevice) {
    return (
      <ControllerSession
        deviceId={activeDevice.deviceId}
        pin={activeDevice.pin}
        name={activeDevice.name}
        onBack={() => setActiveDevice(null)}
      />
    )
  }

  return (
    <div className="ctl-shell">
      <TitleBar title={page === 'computers' ? 'Personal Remote — Computers' : 'Personal Remote — File Transfer'} />
      <div className="ctl-main">
        <nav className="ctl-side">
          <button
            className={`ctl-side__btn${page === 'computers' ? ' is-active' : ''}`}
            title="หน้าหลัก — เครื่องทั้งหมด"
            onClick={() => setPage('computers')}
          >
            <ComputersIcon />
          </button>
          <button
            className={`ctl-side__btn${page === 'files' ? ' is-active' : ''}`}
            title="โอนไฟล์หลายเครื่อง"
            onClick={() => setPage('files')}
          >
            <FilesIcon />
          </button>
        </nav>
        <div className="ctl-content">
          {page === 'computers' ? <DeviceListView onConnect={handleConnect} /> : <FileTransferView />}
        </div>
      </div>
    </div>
  )
}

export default ControllerView
