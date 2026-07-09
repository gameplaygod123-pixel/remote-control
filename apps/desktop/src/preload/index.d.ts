import { ElectronAPI } from '@electron-toolkit/preload'
import type { UpdaterStatus } from '../main/updater'

type AppMode = 'agent' | 'controller'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getMode: () => Promise<AppMode>
      getAppVersion: () => Promise<string>
      sendSignal: (message: unknown) => void
      onSignal: (handler: (message: unknown) => void) => void
      input: {
        move: (x: number, y: number) => Promise<void>
        click: (button?: 'left' | 'right') => Promise<void>
        type: (text: string) => Promise<void>
        getPosition: () => Promise<{ x: number; y: number }>
        mouseButton: (button: 'left' | 'right' | 'middle', down: boolean) => Promise<void>
        scroll: (deltaY: number, deltaX?: number, px?: boolean) => Promise<void>
        key: (code: string, down: boolean, scan?: boolean) => Promise<void>
        getScreenSize: () => Promise<{ width: number; height: number }>
      }
      clipboard: {
        write: (text: string) => Promise<void>
        read: () => Promise<string>
      }
      houseToken: {
        get: () => Promise<string | null>
        set: (token: string) => Promise<void>
      }
      theme: {
        get: () => Promise<'dark' | 'light' | 'glass'>
        set: (theme: 'dark' | 'light' | 'glass') => Promise<void>
      }
      pipeline: {
        get: () => Promise<'webrtc' | 'native'>
        set: (pipeline: 'webrtc' | 'native') => Promise<void>
      }
      agent: {
        captureThumbnail: () => Promise<string | null>
      }
      window: {
        setFullScreen: (value: boolean) => Promise<void>
        show: () => Promise<void>
        onFullScreen: (handler: (value: boolean) => void) => void
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
      controller: {
        setSessionActive: (active: boolean) => void
        onGoHome: (handler: () => void) => void
      }
      controllerMemory: {
        getCachedPin: (deviceId: string) => Promise<string | undefined>
        setCachedPin: (deviceId: string, pin: string) => Promise<void>
        clearCachedPin: (deviceId: string) => Promise<void>
        setLastDeviceId: (deviceId: string) => Promise<void>
      }
      chooseMode: (mode: AppMode) => void
      resetMode: () => Promise<void>
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
      fileTransfer: {
        save: (name: string, data: Uint8Array) => Promise<string>
        readFile: (path: string) => Promise<Uint8Array>
      }
      dialog: {
        pickFiles: () => Promise<{ path: string; name: string; size: number }[]>
      }
      inputHelper: {
        isReady: () => Promise<boolean>
        startSession: () => Promise<void>
        stopSession: () => Promise<void>
        remoteAnswer: (sdp: string) => Promise<void>
        remoteIce: (
          candidate: string,
          sdpMid: string | null,
          sdpMLineIndex: number | null
        ) => Promise<void>
        onOffer: (handler: (sdp: string) => void) => void
        onIce: (
          handler: (candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void
        ) => void
        onDown: (handler: () => void) => void
      }
      videoSender: {
        isReady: () => Promise<boolean>
        startSession: (
          config: import('../video-native/shared/contract').VideoConfig,
          iceServers?: import('../video-native/shared/contract').IceServerConfig[]
        ) => Promise<void>
        stopSession: () => Promise<void>
        remoteAnswer: (sdp: string) => Promise<void>
        remoteIce: (
          candidate: string,
          sdpMid: string | null,
          sdpMLineIndex: number | null
        ) => Promise<void>
        onOffer: (handler: (sdp: string) => void) => void
        onIce: (
          handler: (candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void
        ) => void
        setBitrate: (kbps: number) => Promise<void>
        onStats: (
          handler: (stats: import('../video-native/shared/contract').NativeVideoStats) => void
        ) => void
        onDown: (handler: () => void) => void
      }
      videoReceiver: {
        isReady: () => Promise<boolean>
        startSession: () => Promise<void>
        stopSession: () => Promise<void>
        remoteOffer: (sdp: string) => Promise<void>
        remoteIce: (
          candidate: string,
          sdpMid: string | null,
          sdpMLineIndex: number | null
        ) => Promise<void>
        onAnswer: (handler: (sdp: string) => void) => void
        onIce: (
          handler: (candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void
        ) => void
        onFirstFrame: (handler: () => void) => void
        onStats: (
          handler: (stats: import('../video-native/shared/contract').NativeVideoStats) => void
        ) => void
        onBitrate: (handler: (kbps: number) => void) => void
        onDown: (handler: () => void) => void
      }
    }
  }
}
