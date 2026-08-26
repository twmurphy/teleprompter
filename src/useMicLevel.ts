import { useCallback, useEffect, useRef, useState } from 'react'

/** Per-frame smoothing. Rises fast so speech registers instantly, falls slowly. */
const ATTACK = 0.5
const RELEASE = 0.08

/** Above this, we call it signal rather than room noise. */
const SIGNAL = 0.08

/**
 * Live microphone level, entirely separate from speech recognition.
 *
 * This answers the one question the recogniser can't: is audio actually
 * reaching the browser? If the meter moves while nothing is transcribed, the
 * microphone is fine and the recognition engine is at fault.
 *
 * The level is written straight to the DOM through `barRef` rather than held in
 * React state. At 60fps a state update would re-render the whole script on
 * every frame, which shows up as visible jitter in the text.
 */
export function useMicLevel() {
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const barRef = useRef<HTMLDivElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const frameRef = useRef(0)

  const stop = useCallback(() => {
    cancelAnimationFrame(frameRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void contextRef.current?.close()
    contextRef.current = null
    setActive(false)
  }, [])

  const start = useCallback(async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const context = new AudioContext()
      contextRef.current = context
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(stream).connect(analyser)

      // RMS over the waveform, not the loudest frequency bin: a peak meter
      // reads as spiky noise and can't distinguish quiet speech from silence.
      const samples = new Uint8Array(analyser.fftSize)
      let smoothed = 0

      const tick = () => {
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const s of samples) {
          const centred = (s - 128) / 128
          sum += centred * centred
        }
        // Normal speech sits near 0.05 RMS, which would barely move a bar.
        const raw = Math.min(1, Math.sqrt(sum / samples.length) * 6)
        smoothed += (raw - smoothed) * (raw > smoothed ? ATTACK : RELEASE)

        const bar = barRef.current
        if (bar) {
          bar.style.width = `${Math.round(smoothed * 100)}%`
          bar.dataset.signal = smoothed > SIGNAL ? 'yes' : 'no'
        }
        frameRef.current = requestAnimationFrame(tick)
      }
      tick()
      setActive(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      stop()
    }
  }, [stop])

  useEffect(() => () => stop(), [stop])

  return { active, error, barRef, start, stop }
}
