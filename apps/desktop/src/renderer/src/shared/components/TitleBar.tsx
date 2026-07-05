// The app's own titlebar, replacing the hidden OS one (see the
// titleBarStyle options in main/index.ts): a slim drag region with the
// title centered. The OS window controls float over its corners -- macOS
// traffic lights on the left, the Windows titleBarOverlay cluster on the
// right -- so the centered text stays clear of both without per-platform
// layout.
function TitleBar({ title = 'Personal Remote' }: { title?: string }): React.JSX.Element {
  return (
    <div className="app-titlebar">
      <span className="app-titlebar__text">{title}</span>
    </div>
  )
}

export default TitleBar
