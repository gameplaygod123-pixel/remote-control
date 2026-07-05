import { useEffect, useRef, useState } from 'react'
import { connectSignaling, SignalingClient } from '../shared/signaling/signalingClient'
import { resolveSignalingUrl } from '../shared/signaling/resolveSignalingUrl'
import { SignalingMessage } from '../shared/protocol'
import { pushFilesToDevice, type PushUpdate } from '../shared/fileTransfer/pushFilesToDevice'
import {
  findDroppedDirectory,
  type SendableFile
} from '../shared/fileTransfer/fileTransferChannel'

interface Device {
  deviceId: string
  online: boolean
  name?: string
  os?: string
  lastSeenAt?: number
}

// "2 ชม.ก่อน"-style column. Coarse on purpose -- the roster only knows
// register/disconnect moments, not liveness beyond that.
function formatLastSeen(device: Device): string {
  if (device.online) return 'ตอนนี้'
  if (!device.lastSeenAt) return '—'
  const mins = Math.round((Date.now() - device.lastSeenAt) / 60_000)
  if (mins < 1) return 'เมื่อครู่'
  if (mins < 60) return `${mins} นาทีก่อน`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} ชม.ก่อน`
  return `${Math.round(hours / 24)} วันก่อน`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function describePush(update: PushUpdate): string {
  switch (update.phase) {
    case 'connecting':
      return 'กำลังเชื่อมต่อ...'
    case 'pairing':
      return 'กำลังจับคู่...'
    case 'awaiting-approval':
      return 'รอเครื่องปลายทางกดยอมรับ...'
    case 'preparing':
      return 'กำลังเตรียมช่องส่ง...'
    case 'sending': {
      const which =
        update.fileCount && update.fileCount > 1
          ? ` (${update.fileIndex}/${update.fileCount})`
          : ''
      return `${update.fileName}${which} · ${update.percent ?? 0}%`
    }
    case 'done':
      return 'ส่งครบแล้ว ✓'
    case 'error':
      return `ผิดพลาด: ${update.error}`
  }
}

// The multi-machine file-send page (sidebar's second item): tick several
// online machines, pick/drop files, send to all of them at once. Each
// target gets its own headless push (see pushFilesToDevice.ts) so a slow or
// failing machine never stalls the others.
export default function FileTransferView(): React.JSX.Element {
  const [devices, setDevices] = useState<Device[]>([])
  const [status, setStatus] = useState('connecting to signaling server')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [files, setFiles] = useState<SendableFile[]>([])
  const [pushes, setPushes] = useState<Record<string, PushUpdate>>({})
  const [sending, setSending] = useState(false)
  const clientRef = useRef<SignalingClient | null>(null)
  const tokenRef = useRef('')

  useEffect(() => {
    let cancelled = false
    window.api.houseToken
      .get()
      .then((saved) => {
        tokenRef.current = saved ?? ''
        return connectSignaling(resolveSignalingUrl, {
          onDisconnect: () => setStatus('disconnected, reconnecting...'),
          onReconnect: () => {
            setStatus('connected')
            clientRef.current?.send({ type: 'list-devices', token: tokenRef.current })
          }
        })
      })
      .then((client) => {
        if (cancelled) {
          client.close()
          return
        }
        clientRef.current = client
        setStatus('connected')
        client.onMessage((raw) => {
          const parsed = SignalingMessage.safeParse(raw)
          if (!parsed.success) return
          const message = parsed.data
          if (message.type === 'device-list') {
            setDevices(
              message.devices.map((d) => ({
                deviceId: d.deviceId,
                online: d.online,
                name: d.name,
                os: d.os,
                lastSeenAt: d.lastSeenAt
              }))
            )
          } else if (message.type === 'device-status-changed') {
            setDevices((prev) => {
              const next = prev.some((d) => d.deviceId === message.deviceId)
                ? prev.map((d) =>
                    d.deviceId === message.deviceId
                      ? {
                          ...d,
                          online: message.online,
                          name: message.name,
                          os: message.os ?? d.os,
                          lastSeenAt: message.lastSeenAt ?? d.lastSeenAt
                        }
                      : d
                  )
                : [
                    ...prev,
                    {
                      deviceId: message.deviceId,
                      online: message.online,
                      name: message.name,
                      os: message.os,
                      lastSeenAt: message.lastSeenAt
                    }
                  ]
              return next
            })
            // A machine that just went offline can't stay selected.
            if (!message.online) {
              setSelected((prev) => {
                if (!prev.has(message.deviceId)) return prev
                const next = new Set(prev)
                next.delete(message.deviceId)
                return next
              })
            }
          } else if (message.type === 'device-removed') {
            setDevices((prev) => prev.filter((d) => d.deviceId !== message.deviceId))
          }
        })
        client.send({ type: 'list-devices', token: tokenRef.current })
      })
      .catch((error) => setStatus(`error: ${String(error)}`))

    return () => {
      cancelled = true
      clientRef.current?.close()
    }
  }, [])

  function toggleSelected(deviceId: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(deviceId)) next.delete(deviceId)
      else next.add(deviceId)
      return next
    })
  }

  // Header checkbox: select every online machine, or clear the lot.
  function toggleSelectAll(): void {
    const online = devices.filter((d) => d.online).map((d) => d.deviceId)
    setSelected((prev) => (prev.size >= online.length ? new Set() : new Set(online)))
  }

  function addFiles(list: SendableFile[]): void {
    setFiles((prev) => [...prev, ...list])
  }

  // Native OS picker via the main process -- a hidden <input type=file>'s
  // programmatic click doesn't reliably open the dialog in this Electron
  // build. Picked files read their bytes from disk through the main process
  // on demand (see fileTransfer.readFile), matching the SendableFile shape.
  async function pickFiles(): Promise<void> {
    const picked = await window.api.dialog.pickFiles()
    addFiles(
      picked.map((p) => ({
        name: p.name,
        size: p.size,
        arrayBuffer: async () => {
          const bytes = await window.api.fileTransfer.readFile(p.path)
          // Copy into a fresh ArrayBuffer -- the IPC-returned view may sit on
          // a larger/pooled (or Shared) buffer; the send path wants exactly
          // these bytes as a plain ArrayBuffer.
          const copy = new Uint8Array(bytes.byteLength)
          copy.set(bytes)
          return copy.buffer
        }
      }))
    )
  }

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault()
    const dir = findDroppedDirectory(e.dataTransfer)
    if (dir) {
      setStatus(`โฟลเดอร์ยังไม่รองรับ (${dir}) — บีบเป็น .zip ก่อน`)
      return
    }
    // Dropped browser File objects already satisfy SendableFile.
    if (e.dataTransfer.files.length > 0) addFiles(Array.from(e.dataTransfer.files))
  }

  async function sendToSelected(): Promise<void> {
    if (sending || files.length === 0 || selected.size === 0) return
    setSending(true)
    const targets = [...selected]
    // Clear any leftover done/error rows from a previous send so this run
    // starts clean (and a re-send of the same selection doesn't briefly show
    // the old result).
    setPushes((prev) => {
      const next = { ...prev }
      for (const id of targets) delete next[id]
      return next
    })
    await Promise.all(
      targets.map(async (deviceId) => {
        const pin = await window.api.controllerMemory.getCachedPin(deviceId)
        if (!pin) {
          setPushes((prev) => ({
            ...prev,
            [deviceId]: {
              phase: 'error',
              error: 'ยังไม่มี PIN ที่จำไว้ — เชื่อมต่อจากหน้าหลักหนึ่งครั้งก่อน'
            }
          }))
          return
        }
        try {
          await pushFilesToDevice(deviceId, pin, files, (update) =>
            setPushes((prev) => ({ ...prev, [deviceId]: update }))
          )
        } catch (error) {
          setPushes((prev) => ({
            ...prev,
            [deviceId]: {
              phase: 'error',
              error: error instanceof Error ? error.message : String(error)
            }
          }))
        }
      })
    )
    setSending(false)
  }

  const onlineCount = devices.filter((d) => d.online).length

  return (
    <div className="ft-page" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
      <div className="ft-header">
        <div>
          <h1 className="dl-heading">
            โอนไฟล์<span className="dl-cursor">_</span>
          </h1>
          <p className="dl-subheading">ส่งเป็นโฟลเดอร์ไม่ได้ — ต้องบีบอัดเป็นไฟล์ .zip ก่อน</p>
        </div>
        <span className="dl-pill is-ok">{status}</span>
      </div>

      <div className="ft-files">
        <button className="dl-add-toggle" onClick={() => void pickFiles()}>
          + เลือกไฟล์
        </button>
        <span className="ft-files__hint">หรือลากไฟล์มาวางที่หน้านี้</span>
      </div>

      {files.length > 0 && (
        <div className="ft-filelist">
          <div className="ft-filelist__head">
            <span>
              เลือกไว้ {files.length} ไฟล์ · รวม{' '}
              {formatBytes(files.reduce((sum, f) => sum + f.size, 0))}
            </span>
            <button className="ft-filelist__clear" onClick={() => setFiles([])}>
              ล้างทั้งหมด
            </button>
          </div>
          {files.map((file, i) => (
            <div key={`${file.name}-${i}`} className="ft-file-row">
              <span className="ft-file-row__name" title={file.name}>
                {file.name}
              </span>
              <span className="ft-file-row__size">{formatBytes(file.size)}</span>
              <button
                className="ft-file-row__remove"
                title="เอาออก"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="ft-table">
        <div className="ft-row ft-row--head">
          <input
            type="checkbox"
            title="เลือกเครื่องที่ online ทั้งหมด"
            disabled={sending || onlineCount === 0}
            checked={onlineCount > 0 && selected.size >= onlineCount}
            onChange={toggleSelectAll}
          />
          <span>ชื่อเครื่อง</span>
          <span>สถานะ</span>
          <span>OS</span>
          <span>ล่าสุด</span>
          <span>การโอน</span>
        </div>
        {devices.map((device) => {
          const push = pushes[device.deviceId]
          return (
            <div key={device.deviceId} className="ft-row">
              <input
                type="checkbox"
                disabled={!device.online || sending}
                checked={selected.has(device.deviceId)}
                onChange={() => toggleSelected(device.deviceId)}
              />
              <span className="ft-name" title={device.deviceId}>
                {device.name || device.deviceId}
              </span>
              <span className={`ft-status ${device.online ? 'is-ok' : 'is-idle'}`}>
                ● {device.online ? 'online' : 'offline'}
              </span>
              <span>{device.os ?? '—'}</span>
              <span>{formatLastSeen(device)}</span>
              <span className={`ft-push ${push?.phase === 'error' ? 'is-error' : ''}`}>
                {push ? describePush(push) : '—'}
              </span>
            </div>
          )
        })}
        {devices.length === 0 && (
          <p className="dl-empty">No devices have registered with this server yet.</p>
        )}
      </div>

      <div className="ft-footer">
        <span>
          เลือกไว้ {selected.size} เครื่อง · online {onlineCount}/{devices.length}
        </span>
        <button
          className="dl-btn ft-send"
          // Never a dead button: with no files chosen yet it opens the file
          // picker itself instead of sitting disabled with no explanation.
          disabled={sending || (files.length > 0 && selected.size === 0)}
          onClick={() => {
            if (files.length === 0) void pickFiles()
            else void sendToSelected()
          }}
        >
          {sending
            ? 'กำลังส่ง...'
            : files.length === 0
              ? '+ เลือกไฟล์เพื่อส่ง'
              : selected.size === 0
                ? 'ติ๊กเลือกเครื่องก่อน'
                : `ส่งไฟล์ไป ${selected.size} เครื่อง`}
        </button>
      </div>
    </div>
  )
}
