import { useEffect, useRef } from 'react'

/**
 * Keep the screen awake while reading.
 *
 * A phone dims and locks on an idle timer, and reading aloud from it looks
 * exactly like being idle — no touches, no scrolling. The Screen Wake Lock API
 * is the browser's way of saying otherwise.
 *
 * The lock is dropped by the browser whenever the page is hidden, and is not
 * restored on its own, so it has to be re-taken when the page comes back —
 * otherwise the screen starts dimming again after the first notification or app
 * switch.
 */
export function useWakeLock(active: boolean) {
  const sentinel = useRef<WakeLockSentinel | null>(null)

  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return

    let cancelled = false

    const acquire = async () => {
      // Requesting while hidden always rejects; the visibility handler retries.
      if (cancelled || document.visibilityState !== 'visible') return
      try {
        sentinel.current = await navigator.wakeLock.request('screen')
      } catch {
        // Refused — low battery, or unsupported. Reading still works.
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void sentinel.current?.release()
      sentinel.current = null
    }
  }, [active])
}
