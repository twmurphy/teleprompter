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

/** What the engines report for this browser. Shown in Edit mode. */
export type Diagnosis = {
  supported: boolean
  lang: string
  /** Whether recognition can run with no network. */
  onDevice: Availability | 'no-api'
}

/**
 * Probe on-device availability without starting a session.
 *
 * Worth checking per device rather than assuming: whether an offline engine
 * exists is user-agent dependent, and Android delegates to the system speech
 * service rather than the desktop's downloadable component.
 */
export async function diagnose(): Promise<Diagnosis> {
  const Ctor = getCtor()
  const lang = navigator.language || FALLBACK_LANG
  if (!Ctor) return { supported: false, lang, onDevice: 'no-api' }
  if (!Ctor.available) return { supported: true, lang, onDevice: 'no-api' }

  const onDevice = await Ctor.available({
    langs: [lang],
    processLocally: true,
    quality: 'dictation',
  }).catch(() => 'unavailable' as const)

  return { supported: true, lang, onDevice }
}

/** Ask the browser to download the offline language pack. */
export async function installOnDevice(lang: string): Promise<boolean> {
  const Ctor = getCtor()
  if (!Ctor?.install) return false
  return Ctor.install({ langs: [lang], processLocally: true }).catch(() => false)
}

/**
 * Errors worth giving up on. Everything else — a dropped network, a hiccup in
 * the audio pipeline — is transient, and stopping on those is how a session
 * dies mid-sentence with nothing to show for it.
 */
const FATAL = new Set(['not-allowed', 'service-not-allowed'])

/** How long without any sign of life before assuming the chain has broken. */
const STALL_MS = 12_000
const WATCHDOG_MS = 4_000

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
  const [error, setError] = useState<string | null>(null)

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const wantedRef = useRef(false)
  const configRef = useRef<Config>({ lang: FALLBACK_LANG, processLocally: false })
  // Bumped on every restart so utterance ids from a previous session can never
  // collide with the new one's.
  const sessionRef = useRef(0)
  // Last sign the engine is alive. A restart chain that breaks leaves this
  // frozen, which is the only way to notice from outside.
  const aliveRef = useRef(0)
  const onUtteranceRef = useRef(onUtterance)
  onUtteranceRef.current = onUtterance

  /** Stop a recogniser talking to us, so a restart cannot leave two running. */
  const detach = (recognition: SpeechRecognition) => {
    recognition.onstart = null
    recognition.onresult = null
    recognition.onerror = null
    recognition.onend = null
  }

  const stop = useCallback(() => {
    wantedRef.current = false
    const current = recognitionRef.current
    if (current) {
      detach(current)
      current.abort()
    }
    recognitionRef.current = null
    setState('off')
  }, [])

  /**
   * Build a recogniser, attach it and start listening.
   *
   * `start()` can throw — "already started" is routine on Android — and an
   * unguarded throw here breaks the restart chain permanently: nothing is
   * listening, nothing reports it, and the only symptom is that tracking
   * quietly stops. So a failure schedules another attempt rather than escaping.
   */
  const launch = useCallback(() => {
    const Ctor = getCtor()
    if (!Ctor || !wantedRef.current) return

    const previous = recognitionRef.current
    if (previous) {
      detach(previous)
      try {
        previous.abort()
      } catch {
        // Already dead; nothing to abandon.
      }
    }

    const recognition = new Ctor()
    // Captured per instance. Reading the ref inside onresult would stamp a late
    // result from a previous recogniser with the current session, colliding ids.
    const session = (sessionRef.current += 1)
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = configRef.current.lang
    if (configRef.current.processLocally) recognition.processLocally = true

    const alive = () => {
      aliveRef.current = Date.now()
    }

    recognition.onstart = () => {
      alive()
      setState('listening')
    }
    recognition.onaudiostart = alive
    recognition.onspeechstart = alive

    recognition.onresult = (event) => {
      alive()
      const index = event.results.length - 1
      const result = event.results[index]
      if (!result) return
      const text = result[0].transcript.trim()
      onUtteranceRef.current({
        id: `${session}:${index}`,
        words: transcriptWords(text),
        isFinal: result.isFinal,
        text,
      })
    }

    recognition.onerror = (event) => {
      alive()
      if (FATAL.has(event.error)) {
        setError(MESSAGES[event.error] ?? event.error)
        setState('error')
        wantedRef.current = false
        return
      }
      // The on-device pack went missing between our check and start().
      if (event.error === 'language-not-supported' && configRef.current.processLocally) {
        configRef.current = { ...configRef.current, processLocally: false }
      }
      // Everything else is transient; onend will bring us back.
    }

    recognition.onend = () => {
      detach(recognition)
      if (!wantedRef.current) return
      // Android cuts the session short constantly. The short delay avoids
      // "already started" from restarting inside onend.
      setTimeout(launch, 100)
    }

    recognitionRef.current = recognition
    alive()

    try {
      recognition.start()
    } catch {
      // Try again shortly rather than leaving the chain broken.
      setTimeout(launch, 500)
    }
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
    if (!wantedRef.current) return
    launch()
  }, [launch])

  /**
   * Confirm recognition is actually running, and revive it if not.
   *
   * Offered to the caller so a deliberate action — tapping a word to correct
   * the position — can double as a check that the thing is still listening.
   */
  const ensureListening = useCallback(() => {
    if (!wantedRef.current) return
    if (Date.now() - aliveRef.current > STALL_MS || !recognitionRef.current) launch()
  }, [launch])

  // Watchdog: if nothing has been heard from the engine for a while, assume the
  // restart chain broke and rebuild it. Silence alone does not trigger this —
  // an idle recogniser still ends and restarts, which counts as life.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!wantedRef.current) return
      if (Date.now() - aliveRef.current > STALL_MS) launch()
    }, WATCHDOG_MS)
    return () => clearInterval(timer)
  }, [launch])

  useEffect(() => () => {
    wantedRef.current = false
    const current = recognitionRef.current
    if (current) {
      detach(current)
      current.abort()
    }
  }, [])

  return { state, error, start, stop, ensureListening }
}
