import type { TransferState } from '../fileTransfer/useFileTransferChannel'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export default function TransferStatus({
  transfer,
  onCancel
}: {
  transfer: TransferState | null
  onCancel: () => void
}): React.JSX.Element | null {
  if (!transfer) return null

  const verb = transfer.direction === 'send' ? 'Sending' : 'Receiving'
  const inProgress = !transfer.done && !transfer.error
  const sizeLabel = transfer.totalBytes
    ? ` (${formatBytes(Math.round((transfer.progress / 100) * transfer.totalBytes))} of ${formatBytes(transfer.totalBytes)})`
    : ''

  return (
    <div className={`transfer-status${transfer.error ? ' is-error' : ''}`}>
      <div className="transfer-status__label">
        {transfer.error
          ? `"${transfer.name}": ${transfer.error}`
          : transfer.done
            ? `Saved "${transfer.name}" to Downloads`
            : `${verb} "${transfer.name}"...${sizeLabel} ${transfer.progress}%`}
      </div>
      {inProgress && (
        <>
          <div className="transfer-status__bar">
            <div className="transfer-status__fill" style={{ width: `${transfer.progress}%` }} />
          </div>
          <button className="transfer-status__cancel" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}
    </div>
  )
}
