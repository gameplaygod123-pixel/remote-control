import { useState } from 'react'

// Shown once per install (agent AND controller), whenever no house token is
// saved yet -- fresh installs, and existing installs updating across the
// version that introduced the token. The token is the same for every machine
// in the household; the server operator (the Mac) generates it once and
// shares it out-of-band. Saved to userData, so this never appears again on
// the same machine (auto-updates and reinstalls included).
function TokenSetupView({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const trimmed = token.trim()

  async function save(): Promise<void> {
    if (!trimmed || saving) return
    setSaving(true)
    await window.api.houseToken.set(trimmed)
    onSaved()
  }

  return (
    <div className="app-shell">
      <div className="app-header">
        <div className="app-icon">🔑</div>
        <div>
          <div className="app-title">Personal Remote</div>
          <div className="app-subtitle">Enter your house token</div>
        </div>
      </div>

      <div className="field-group">
        <input
          className="text-input"
          type="password"
          value={token}
          placeholder="Paste the token here"
          autoFocus
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
        <button className="btn" disabled={!trimmed || saving} onClick={() => void save()}>
          Save and continue
        </button>
        <p className="credential-hint">
          One shared secret for every computer in your household -- ask whoever runs your
          Personal Remote server for it. You only enter it once on this computer; it is
          kept through updates. If connections fail with an invalid-token error later,
          the saved value was wrong -- restart the app to fix it here.
        </p>
      </div>
    </div>
  )
}

export default TokenSetupView
