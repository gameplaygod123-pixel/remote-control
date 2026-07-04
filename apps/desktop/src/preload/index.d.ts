import { ElectronAPI } from '@electron-toolkit/preload'

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
    }
  }
}
