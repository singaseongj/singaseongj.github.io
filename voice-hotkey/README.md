# Voice Hotkey

## Pressed key visualization
- Pressed keys change fill and stroke using `--key-pressed-fill` and `--key-pressed-stroke`.
- A brief pulse indicates the press location when "Show press ping" is enabled.

## Heatmap mode
- Counts how often each key is pressed and shades keys between `--key-heatmap-min` and `--key-heatmap-max`.
- Enable with the Heatmap toggle and reset with the "Reset heatmap" button.

## Eye tracking (experimental)
- `eye.js` provides a provider-agnostic scaffold.
- External trackers can set `window.__eyeProviderLoaded__`, `__eyeStart(cb)` and `__eyeStop()`.
- Settings include an enable toggle, dwell time (ms) and sensitivity slider. When enabled, gaze dwell highlights keys.

## Accessibility and theming
- Result messages update via `aria-live="polite"`.
- Color variables in `styles.css` allow easy theming with an accessibility-safe palette.
