// Shown once on a genuinely fresh install/first launch, when the main
// process doesn't yet know which mode this install should run as (no
// APP_MODE env var, nothing saved from a previous run -- see
// promptForMode() in main/index.ts). The choice is persisted on the main
// side, so this never appears again on the same install.
function ChooseModeView(): React.JSX.Element {
  return (
    <div className="app-shell">
      <div className="setup-drag-strip" />
      <div className="app-header">
        <div className="app-icon">🖥️</div>
        <div>
          <div className="app-title">Personal Remote</div>
          <div className="app-subtitle">What is this computer?</div>
        </div>
      </div>

      <div className="field-group">
        <button className="btn" onClick={() => window.api.chooseMode('controller')}>
          This is the computer I'll control FROM
        </button>
        <p className="credential-hint">
          Pick this on the computer you'll be sitting at -- it shows a list of your other
          computers and lets you connect to them.
        </p>
      </div>

      <div className="field-group">
        <button className="btn btn--ghost" onClick={() => window.api.chooseMode('agent')}>
          This is the computer I want to control remotely
        </button>
        <p className="credential-hint">
          Pick this on the computer you want to reach from elsewhere -- it waits in the
          background for a connection.
        </p>
      </div>
    </div>
  )
}

export default ChooseModeView
