import type { ThemeName } from './ThemeToggle'

// Toggles the translucent 'glass' theme (see-through controller over the
// desktop). Controlled by ControllerView. Turning glass ON remembers the
// previous dark/light choice so turning it OFF restores it. On macOS the main
// process relaunches the window when glass flips (transparency is fixed at
// window creation) -- so expect a brief restart on toggle.
const PREV_KEY = 'pr-prev-theme'

export default function GlassToggle({
  theme,
  onChange
}: {
  theme: ThemeName
  onChange: (t: ThemeName) => void
}): React.JSX.Element {
  const isGlass = theme === 'glass'

  function toggle(): void {
    if (isGlass) {
      const prev = localStorage.getItem(PREV_KEY)
      onChange(prev === 'light' ? 'light' : 'dark')
    } else {
      localStorage.setItem(PREV_KEY, theme)
      onChange('glass')
    }
  }

  return (
    <button
      className={`glass-toggle${isGlass ? ' is-on' : ''}`}
      aria-pressed={isGlass}
      title="ธีมกระจกโปร่งใส (มองทะลุเดสก์ท็อป)"
      onClick={toggle}
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3.2c0 0 6 6.3 6 10.8a6 6 0 0 1-12 0C6 9.5 12 3.2 12 3.2Z"
          fill={isGlass ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
