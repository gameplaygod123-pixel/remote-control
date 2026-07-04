// Escape hatch for "deleted and reinstalled, but it didn't ask me to pick
// a mode again" -- uninstalling doesn't clear the saved choice (it lives
// in userData, which most uninstallers leave alone), so without this the
// only fix is manually finding and deleting that file. Confirmation and
// the actual restart happen in the main process (window.api.resetMode).
export default function SwitchModeLink(): React.JSX.Element {
  return (
    <button className="mode-switch-link" onClick={() => window.api.resetMode()}>
      Switch mode
    </button>
  )
}
