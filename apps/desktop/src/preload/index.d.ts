import { ElectronAPI } from '@electron-toolkit/preload'
import type { UpdaterStatus } from '../main/updater'

type AppMode = 'agent' | 'controller'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getMode: () => Promise<AppMode>
      sendSignal: (message: unknown) => void
      onSignal: (handler: (message: unknown) => void) => void
      input: {
        move: (x: number, y: number) => Promise<void>
        click: (button?: 'left' | 'right') => Promise<void>
        type: (text: string) => Promise<void>
        getPosition: () => Promise<{ x: number; y: number }>
        mouseButton: (button: 'left' | 'right' | 'middle', down: boolean) => Promise<void>
        scroll: (deltaY: number) => Promise<void>
        key: (code: string, down: boolean) => Promise<void>
        getScreenSize: () => Promise<{ width: number; height: number }>
      }
      clipboard: {
        write: (text: string) => Promise<void>
      }
      agent: {
        captureThumbnail: () => Promise<string | null>
      }
      window: {
        setFullScreen: (value: boolean) => Promise<void>
        show: () => Promise<void>
      }
      trusted: {
        list: () => Promise<{ id: string; trustedAt: number }[]>
        isTrusted: (id: string) => Promise<boolean>
        trust: (id: string) => Promise<void>
        revoke: (id: string) => Promise<void>
      }
      controllerId: {
        get: () => Promise<string>
      }
      controllerMemory: {
        getCachedPin: (deviceId: string) => Promise<string | undefined>
        setCachedPin: (deviceId: string, pin: string) => Promise<void>
        clearCachedPin: (deviceId: string) => Promise<void>
        getLastDevice: () => Promise<{ deviceId: string; pin: string } | null>
        setLastDeviceId: (deviceId: string) => Promise<void>
      }
      chooseMode: (mode: AppMode) => void
      agentIdentity: {
        getDeviceId: () => Promise<string>
        getName: () => Promise<string>
        setName: (name: string) => Promise<void>
        getPin: () => Promise<string>
        setPin: (pin: string) => Promise<void>
        regeneratePin: () => Promise<string>
      }
      updater: {
        checkNow: () => Promise<void>
        restartNow: () => Promise<void>
        onStatus: (handler: (status: UpdaterStatus) => void) => void
      }
    }
  }
}
