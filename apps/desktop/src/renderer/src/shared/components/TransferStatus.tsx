import type { TransferState } from '../fileTransfer/useFileTransferChannel'

export default function TransferStatus({
  transfer
}: {
  transfer: TransferState | null
}): React.JSX.Element | null {
  if (!transfer) return null

  const verb = transfer.direction === 'send' ? 'Sending' : 'Receiving'

  return (
    <div className="transfer-status">
      <div className="transfer-status__label">
        {transfer.done
          ? `Saved "${transfer.name}" to Downloads`
          : `${verb} "${transfer.name}"... ${transfer.progress}%`}
      </div>
      {!transfer.done && (
        <div className="transfer-status__bar">
          <div className="transfer-status__fill" style={{ width: `${transfer.progress}%` }} />
        </div>
      )}
    </div>
  )
}
