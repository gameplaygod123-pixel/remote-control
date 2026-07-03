type Variant = 'ok' | 'warn' | 'error' | 'idle'

function classify(status: string): Variant {
  const s = status.toLowerCase()
  if (s.includes('retry') || s.includes('reconnect')) return 'warn'
  if (s === 'not connected') return 'idle'
  if (s.includes('disconnected')) return 'warn'
  if (s.includes('failed') || s.includes('error')) return 'error'
  if (s.includes('connected')) return 'ok'
  return 'warn'
}

export default function StatusPill({ status }: { status: string }): React.JSX.Element {
  const variant = classify(status)
  return (
    <span className={`status-pill is-${variant}`}>
      <span className={`status-dot${variant === 'warn' ? ' is-pulsing' : ''}`} />
      {status}
    </span>
  )
}
