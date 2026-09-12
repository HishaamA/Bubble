import { useAppTheme } from '../../theme/AppTheme'

/** Shared appearance controls used by Settings and its isolated visual fixture. */
export function AppearanceSettings() {
  const { theme: selectedTheme, setTheme, themes } = useAppTheme()

  return (
    <section className="ks-section" aria-labelledby="appearance-title">
      <div className="ks-section__heading">
        <h2 id="appearance-title">Appearance</h2>
      </div>
      <fieldset className="theme-picker">
        <legend className="theme-picker__legend">Colour scheme</legend>
        <div
          className="theme-picker__options"
          role="radiogroup"
          aria-labelledby="appearance-title"
        >
          {themes.map((theme) => (
            <button
              key={theme.id}
              className="theme-option"
              type="button"
              role="radio"
              aria-checked={selectedTheme === theme.id}
              aria-label={`${theme.name}: ${theme.description}`}
              onClick={() => setTheme(theme.id)}
            >
              <span className="theme-option__swatches" aria-hidden="true">
                {theme.swatches.map((swatch) => (
                  <span key={swatch} style={{ backgroundColor: swatch }} />
                ))}
              </span>
              <strong>{theme.name}</strong>
              <small>{theme.description}</small>
            </button>
          ))}
        </div>
      </fieldset>
    </section>
  )
}
