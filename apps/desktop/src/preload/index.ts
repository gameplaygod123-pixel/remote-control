import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

type AppMode = 'agent' | 'controller'

// Custom APIs for renderer
const api = {
  getMode: (): Promise<AppMode> => ipcRenderer.invoke('get-mode'),
  // Generic signaling transport: relayed via the main process for the Phase 1
  // loopback test, will point at the real signaling WebSocket from Phase 3 onward.
  sendSignal: (message: unknown): void => {
    ipcRenderer.send('signal', message)
  },
  onSignal: (handler: (message: unknown) => void): void => {
    ipcRenderer.on('signal', (_event, message) => handler(message))
  },
  // nut.js-backed input injection, exercised directly by the Phase 2 test harness.
  input: {
    move: (x: number, y: number): Promise<void> => ipcRenderer.invoke('input:move', x, y),
    click: (button: 'left' | 'right' = 'left'): Promise<void> =>
      ipcRenderer.invoke('input:click', button),
    type: (text: string): Promise<void> => ipcRenderer.invoke('input:type', text),
    getPosition: (): Promise<{ x: number; y: number }> =>
      ipcRenderer.invoke('input:get-position'),
    mouseButton: (button: 'left' | 'right' | 'middle', down: boolean): Promise<void> =>
      ipcRenderer.invoke('input:mouse-button', button, down),
    scroll: (deltaY: number): Promise<void> => ipcRenderer.invoke('input:scroll', deltaY),
    key: (code: string, down: boolean): Promise<void> => ipcRenderer.invoke('input:key', code, down),
    getScreenSize: (): Promise<{ width: number; height: number }> =>
      ipcRenderer.invoke('input:get-screen-size')
  },
  clipboard: {
    write: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text)
  },
  agent: {
    captureThumbnail: (): Promise<string | null> => ipcRenderer.invoke('agent:capture-thumbnail')
  },
  window: {
    setFullScreen: (value: boolean): Promise<void> =>
      ipcRenderer.invoke('window:set-fullscreen', value),
    show: (): Promise<void> => ipcRenderer.invoke('window:show')
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
