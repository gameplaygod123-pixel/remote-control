export type ThemeName = 'dark' | 'light' | 'glass'

// A single triangular 3-way theme switch for the controller sidebar, replacing
// the old separate sun/moon slider + droplet glass button. Three corners --
// Glass (top), Light (bottom-left), Dark (bottom-right) -- with an accent knob
// that slides to the active corner. Controlled by ControllerView (which owns the
// theme + persists it); every theme (glass included) re-skins live via the
// `data-theme` attribute on <html>, no relaunch.

const SunIcon = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="4" fill="currentColor" />
    <path
      d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
)

const MoonIcon = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  </svg>
)

const DropletIcon = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 3.2c0 0 6 6.3 6 10.8a6 6 0 0 1-12 0C6 9.5 12 3.2 12 3.2Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
)

export default function ThemeTriToggle({
  theme,
  onChange
}: {
  theme: ThemeName
  onChange: (t: ThemeName) => void
}): React.JSX.Element {
  return (
    <div className={`tri-theme is-${theme}`} role="radiogroup" aria-label="เลือกธีม">
      {/* Faint triangle track connecting the three corner centres. */}
      <svg className="tri-theme__track" viewBox="0 0 56 50" aria-hidden="true">
        <path
          d="M28 13 L15 36 L41 36 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      <span className="tri-theme__knob" aria-hidden="true" />
      <button
        type="button"
        className="tri-theme__opt tri-theme__glass"
        role="radio"
        aria-checked={theme === 'glass'}
        title="ธีมกระจกโปร่งใส (มองทะลุเดสก์ท็อป)"
        onClick={() => onChange('glass')}
      >
        {DropletIcon}
      </button>
      <button
        type="button"
        className="tri-theme__opt tri-theme__light"
        role="radio"
        aria-checked={theme === 'light'}
        title="ธีมสว่าง"
        onClick={() => onChange('light')}
      >
        {SunIcon}
      </button>
      <button
        type="button"
        className="tri-theme__opt tri-theme__dark"
        role="radio"
        aria-checked={theme === 'dark'}
        title="ธีมมืด"
        onClick={() => onChange('dark')}
      >
        {MoonIcon}
      </button>
    </div>
  )
}
