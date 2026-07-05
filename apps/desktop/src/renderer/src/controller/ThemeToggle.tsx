import { useEffect, useState } from 'react'

// Sliding light/dark switch for the controller sidebar. Flips
// `data-theme` on <html> (which re-skins the whole controller shell via the
// token overrides in deviceList.css) and persists the choice per machine.
// The knob carries the current mode's icon and slides between the sun (left,
// light) and moon (right, dark) tracks.
export default function ThemeToggle(): React.JSX.Element {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (document.documentElement.dataset.theme as 'dark' | 'light') || 'dark'
  )

  useEffect(() => {
    window.api.theme.get().then((saved) => {
      setTheme(saved)
      document.documentElement.dataset.theme = saved
    })
  }, [])

  function toggle(): void {
    const next = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    document.documentElement.dataset.theme = next
    void window.api.theme.set(next)
  }

  const isLight = theme === 'light'
  return (
    <button
      className="theme-toggle"
      role="switch"
      aria-checked={isLight}
      aria-label={isLight ? 'ธีมสว่าง (กดเพื่อสลับเป็นมืด)' : 'ธีมมืด (กดเพื่อสลับเป็นสว่าง)'}
      title="สลับโหมดสว่าง / มืด"
      onClick={toggle}
    >
      <span className="theme-toggle__icon theme-toggle__sun" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="4" fill="currentColor" />
          <path
            d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="theme-toggle__icon theme-toggle__moon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path
            d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="theme-toggle__knob" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          {isLight ? (
            <>
              <circle cx="12" cy="12" r="4.4" fill="currentColor" />
              <path
                d="M12 2.5v2.2M12 19.3v2.2M4.7 12H2.5M21.5 12h-2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </>
          ) : (
            <path
              d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </span>
    </button>
  )
}
