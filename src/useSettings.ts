import { useCallback, useEffect, useState } from 'react'

/**
 * Reading settings, kept between sessions.
 *
 * Both exist because of how the prompter is actually used: a phone propped
 * behind a camera has less usable screen than the display suggests, and where
 * the eye rests is a physical constraint of the setup, not a style choice.
 */
export type Settings = {
  /**
   * Multiplier on the responsive script size, so the text still adapts to the
   * screen and this only nudges it.
   */
  scale: number
  /**
   * Where the current word sits, as a fraction of the script area. Lower keeps
   * the reading line clear of a camera covering the bottom of the screen.
   */
  readingLine: number
}

export const DEFAULTS: Settings = { scale: 1, readingLine: 0.25 }

export const LIMITS = {
  scale: { min: 0.5, max: 2, step: 0.05 },
  readingLine: { min: 0.05, max: 0.6, step: 0.01 },
}

const KEY = 'teleprompter:settings'

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

/** Read stored settings, ignoring anything malformed or out of range. */
function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS
    const { scale, readingLine } = parsed as Partial<Settings>
    return {
      scale:
        typeof scale === 'number'
          ? clamp(scale, LIMITS.scale.min, LIMITS.scale.max)
          : DEFAULTS.scale,
      readingLine:
        typeof readingLine === 'number'
          ? clamp(readingLine, LIMITS.readingLine.min, LIMITS.readingLine.max)
          : DEFAULTS.readingLine,
    }
  } catch {
    return DEFAULTS
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load)

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(settings))
  }, [settings])

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }))
  }, [])

  const reset = useCallback(() => setSettings(DEFAULTS), [])

  return { settings, update, reset }
}
