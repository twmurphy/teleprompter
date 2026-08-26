import { useCallback, useEffect, useRef, useState } from 'react'
import { transcriptWords } from './match'

/** Result of `SpeechRecognition.available()` (Chrome 139+). */
type Availability = 'available' | 'downloading' | 'downloadable' | 'unavailable'

type AvailabilityQuery = {
  langs: string[]
  processLocally?: boolean
  quality?: 'command' | 'dictation' | 'conversation'
}

/**
 * The constructor, plus the Chrome 139+ on-device statics. Both statics are
 * optional: older Chrome only has the cloud engine.
 */
type SpeechRecognitionCtor = (new () => SpeechRecognition) & {
  available?: (options: AvailabilityQuery) => Promise<Availability>
  install?: (options: AvailabilityQuery) => Promise<boolean>
}

const getCtor = (): SpeechRecognitionCtor | null => {
  const w = window as unknown as Record<string, SpeechRecognitionCtor | undefined>
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** True when this browser exposes the Web Speech API at all. */
export const dictationSupported = (): boolean => getCtor() !== null

export type DictationState = 'off' | 'starting' | 'listening' | 'error'

const MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone blocked. Allow it in the site permissions.',
  'service-not-allowed': 'Speech service unavailable in this browser.',
  'language-not-supported': 'Speech recognition has no engine for your language.',
  network: 'Speech recognition needs a network connection.',
  'audio-capture': 'No microphone found.',
}

/**
 * One continuous stretch of speech, re-sent by the engine as it firms up.
 * `id` is stable for the life of an utterance, so a listener can tell a
 * revision of the current utterance from the start of a new one.
 */
export type Utterance = {
  id: string
  /** Every word of this utterance so far, normalised. Grows and gets revised. */
  words: string[]
  isFinal: boolean
  /** Raw text, for display. */
  text: string
}

type Options = {
  onUtterance: (utterance: Utterance) => void
}

/** Which recognition engine the current session ended up on. */
export type Engine = 'on-device' | 'cloud'

/** Settings resolved once per session and reused across auto-restarts. */
type Config = { lang: string; processLocally: boolean }

const FALLBACK_LANG = 'en-US'

/**
 * Decide what to actually ask for.
 *
 * `processLocally = true` is not a preference — Chrome rejects `start()` with
 * `language-not-supported` if the on-device pack isn't installed, so we must
 * confirm availability first. If a pack is merely downloadable we trigger the
 * download in the background and use the cloud engine for this session.
 */
async function resolveConfig(Ctor: SpeechRecognitionCtor): Promise<Config> {
  const preferred = navigator.language || FALLBACK_LANG

  // Older Chrome: no availability API, so only the cloud engine exists.
  if (!Ctor.available) return { lang: preferred, processLocally: false }

  // Pick a language the engine actually knows, preferring the browser's own.
  let lang = preferred
  if ((await Ctor.available({ langs: [preferred] })) === 'unavailable') {
    lang = FALLBACK_LANG
  }

  const local = await Ctor.available({
    langs: [lang],
    processLocally: true,
    quality: 'dictation',
  })

  if (local === 'downloadable' || local === 'downloading') {
    // Fire and forget: on-device kicks in on a later session.
    void Ctor.install?.({ langs: [lang], processLocally: true }).catch(() => {})
  }

  return { lang, processLocally: local === 'available' }
}

/**
 * Continuous dictation on top of the Web Speech API.
 *
 * Three things the raw API won't do for us:
 *  - Chrome on Android ends the session after a few seconds of silence
 *    regardless of `continuous`, so we restart it until the caller stops.
 *  - Interim results are re-sent and revised as they firm up. We hand over the
 *    whole utterance each time rather than trying to diff out the new words:
 *    a revision can rewrite words we already reported, and any bookkeeping
 *    based on counts double-counts when that happens.
 *  - On-device recognition has to be negotiated rather than simply requested.
 */
export function useDictation({ onUtterance }: Options) {
  const [state, setState] = useState<DictationState>('off')
  const [engine, setEngine] = useState<Engine | null>(null)
  // Raw text straight from the engine, so you can see whether it hears anything
  // at all separately from whether the matcher is tracking it.
  const [heard, setHeard] = useState('')
  const [error, setError] = useState<string | null>(null)

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const wantedRef = useRef(false)
  const configRef = useRef<Config>({ lang: FALLBACK_LANG, processLocally: false })
  // Bumped on every restart so utterance ids from a previous session can never
  // collide with the new one's.
  const sessionRef = useRef(0)
  // Keep the latest callback without re-creating the recogniser on every render.
  const onUtteranceRef = useRef(onUtterance)
  onUtteranceRef.current = onUtterance

  const stop = useCallback(() => {
    wantedRef.current = false
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setState('off')
    setEngine(null)
  }, [])

  const start = useCallback(async () => {
    const Ctor = getCtor()
    if (!Ctor) {
      setError('This browser has no speech recognition. Use Chrome.')
      setState('error')
      return
    }

    wantedRef.current = true
    setError(null)
    setState('starting')

    try {
      configRef.current = await resolveConfig(Ctor)
    } catch {
      // Availability checks are best-effort; the cloud engine is always there.
      configRef.current = { lang: FALLBACK_LANG, processLocally: false }
    }
    // The user may have pressed Stop while we were negotiating.
    if (!wantedRef.current) return

    const build = (): SpeechRecognition => {
      const recognition = new Ctor()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = configRef.current.lang
      if (configRef.current.processLocally) recognition.processLocally = true

      recognition.onstart = () => {
        sessionRef.current += 1
        setEngine(configRef.current.processLocally ? 'on-device' : 'cloud')
        setState('listening')
      }

      recognition.onresult = (event) => {
        // Only the newest result matters; earlier ones are already settled.
        const index = event.results.length - 1
        const result = event.results[index]
        if (!result) return
        const text = result[0].transcript.trim()
        setHeard(text)
        onUtteranceRef.current({
          id: `${sessionRef.current}:${index}`,
          words: transcriptWords(text),
          isFinal: result.isFinal,
          text,
        })
      }

      recognition.onerror = (event) => {
        // Silence and aborts are routine; onend will restart us.
        if (event.error === 'no-speech' || event.error === 'aborted') return

        // The on-device pack went missing between our check and start().
        // Drop to the cloud engine and let onend restart us on it.
        if (event.error === 'language-not-supported' && configRef.current.processLocally) {
          configRef.current = { ...configRef.current, processLocally: false }
          return
        }

        setError(MESSAGES[event.error] ?? event.error)
        setState('error')
        wantedRef.current = false
      }

      recognition.onend = () => {
        if (!wantedRef.current) return
        // Android cuts the session short — pick straight back up. The short
        // delay avoids "already started" errors from restarting inside onend.
        setTimeout(() => {
          if (!wantedRef.current) return
          const next = build()
          recognitionRef.current = next
          next.start()
        }, 100)
      }

      return recognition
    }

    const recognition = build()
    recognitionRef.current = recognition
    recognition.start()
  }, [])

  // Never leave the mic open behind us.
  useEffect(() => () => {
    wantedRef.current = false
    recognitionRef.current?.abort()
  }, [])

  return { state, engine, error, heard, start, stop }
}
