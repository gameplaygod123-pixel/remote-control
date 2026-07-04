import type { TransferState } from '../fileTransfer/useFileTransferChannel'

export default function TransferStatus({
  transfer
}: {
  transfer: TransferState | null
}): React.JSX.Element | null {
  if (!transfer) return null

  const verb = transfer.direction === 'send' ? 'Sending' : 'Receiving'

  return (
    <div className={`transfer-status${transfer.error ? ' is-error' : ''}`}>
      <div className="transfer-status__label">
        {transfer.error
          ? `"${transfer.name}": ${transfer.error}`
          : transfer.done
            ? `Saved "${transfer.name}" to Downloads`
            : `${verb} "${transfer.name}"... ${transfer.progress}%`}
      </div>
      {!transfer.done && !transfer.error && (
        <div className="transfer-status__bar">
          <div className="transfer-status__fill" style={{ width: `${transfer.progress}%` }} />
        </div>
      )}
    </div>
  )
}
