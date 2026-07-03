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
      ipcRenderer.invoke('input:get-position')
  },
  clipboard: {
    write: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text)
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
