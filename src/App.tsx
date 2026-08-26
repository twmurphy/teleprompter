import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { advanceCursor, parseScript } from './match'
import {
  dictationSupported,
  useDictation,
  type Utterance,
} from './useDictation'
import { useMicLevel } from './useMicLevel'

const STORAGE_KEY = 'teleprompter:script'

const SAMPLE = `Tap Edit to replace this with your own script.

Switch to Play, hit the microphone, and start reading aloud. The words light
up as they are recognised and the page keeps the line you are on in the middle
of the screen.

If it ever loses your place, just tap the word you are actually on.`

type Mode = 'edit' | 'play'


export default function App() {
  const [mode, setMode] = useState<Mode>('edit')
  const [text, setText] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? SAMPLE,
  )
  const [cursor, setCursor] = useState(0)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, text)
  }, [text])

  const script = useMemo(() => parseScript(text), [text])

  // The engine can deliver several batches before React re-renders, so the
  // cursor is tracked in a ref and updated synchronously. Reading `cursor`
  // here would match every batch against a stale position.
  const cursorRef = useRef(cursor)
  const moveCursor = useCallback((next: number) => {
    cursorRef.current = next
    setCursor(next)
  }, [])

  // Each transcript is matched from wherever the cursor currently sits. Words
  // the engine re-sends fall outside the narrow seek range and are ignored,
  // which is what keeps this stable without extra bookkeeping.
  const handleUtterance = useCallback(
    ({ words }: Utterance) => {
      moveCursor(advanceCursor(script, cursorRef.current, words))
    },
    [script, moveCursor],
  )

  const dictation = useDictation({ onUtterance: handleUtterance })
  const mic = useMicLevel()

  // The level meter runs alongside recognition so a silent meter and a silent
  // transcript can be told apart.
  const startListening = () => {
    void mic.start()
    void dictation.start()
  }
  const stopListening = () => {
    mic.stop()
    dictation.stop()
  }

  // Entering Play starts listening; leaving it releases the mic. There is no
  // manual control — reading aloud is the only thing Play mode is for.
  const goTo = (next: Mode) => {
    if (next === 'play') startListening()
    else stopListening()
    setMode(next)
  }

  return (
    <div className="app">
      <header className="bar">
        <div className="modes">
          <button
            className={mode === 'edit' ? 'on' : ''}
            onClick={() => goTo('edit')}
          >
            Edit
          </button>
          <button
            className={mode === 'play' ? 'on' : ''}
            onClick={() => goTo('play')}
          >
            Play
          </button>
        </div>
      </header>

      {mode === 'edit' ? (
        <textarea
          className="editor"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste or type your script…"
          spellCheck={false}
        />
      ) : (
        <Stage script={script} text={text} cursor={cursor} onSeek={moveCursor} />
      )}

      {mode === 'play' && (
        <footer className="status">
          <div>
            {!dictationSupported()
              ? 'No speech recognition in this browser — use Chrome.'
              : dictation.error
                ? dictation.error
                : dictation.state === 'listening'
                  ? `Listening — ${dictation.engine} engine.`
                  : dictation.state === 'starting'
                    ? 'Starting…'
                    : 'Starting…'}
          </div>
          {/* Raw engine output. If this stays empty the microphone or engine is
              the problem; if it fills but nothing highlights, the matcher is. */}
          <MicMeter barRef={mic.barRef} active={mic.active} error={mic.error} />
          {dictation.heard && <div className="heard">heard: {dictation.heard}</div>}
        </footer>
      )}
    </div>
  )
}

type StageProps = {
  script: ReturnType<typeof parseScript>
  text: string
  cursor: number
  onSeek: (index: number) => void
}

/**
 * The scrolling script.
 *
 * Ported from Tom's teleprompter: on each cursor change, ease the scroll
 * position toward the active word over 2s with an easeOutQuad curve, parking
 * the word a third of the way down so there is more script visible ahead than
 * behind. The long, decelerating curve is what makes word-by-word movement read
 * as a glide rather than a series of steps.
 */
const SCROLL_DURATION = 2000

const Stage = memo(function Stage({ script, text, cursor, onSeek }: StageProps) {
  const activeRef = useRef<HTMLSpanElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef(0)

  useEffect(() => {
    const container = containerRef.current
    const active = activeRef.current
    if (!container || !active) return

    const from = container.scrollTop
    const to = active.offsetTop - container.clientHeight / 3 + active.clientHeight / 2
    const distance = to - from
    let startedAt: number | null = null

    const easeOutQuad = (t: number) => t * (2 - t)

    const step = (now: number) => {
      startedAt ??= now
      const progress = Math.min((now - startedAt) / SCROLL_DURATION, 1)
      container.scrollTop = from + distance * easeOutQuad(progress)
      if (progress < 1) frameRef.current = requestAnimationFrame(step)
    }

    // Replace any in-flight scroll rather than letting two loops fight.
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frameRef.current)
  }, [cursor])

  let cut = 0
  const nodes = script.map((word, i) => {
    // Replay the original whitespace and any punctuation-only tokens between words.
    const gap = text.slice(cut, word.start)
    cut = word.start + word.raw.length
    return (
      <span key={i}>
        {gap}
        <span
          ref={i === cursor ? activeRef : undefined}
          className={i < cursor ? 'said' : i === cursor ? 'now' : ''}
          onClick={() => onSeek(i)}
        >
          {word.raw}
        </span>
      </span>
    )
  })

  return (
    <div className="stage" ref={containerRef}>
      {nodes}
    </div>
  )
})

/**
 * Input level straight from the Web Audio API. Independent of recognition:
 * if this moves while nothing is transcribed, the microphone is not the problem.
 * The bar is driven by `useMicLevel` writing to the DOM, so it never re-renders.
 */
function MicMeter({
  barRef,
  active,
  error,
}: {
  barRef: React.RefObject<HTMLDivElement | null>
  active: boolean
  error: string | null
}) {
  if (error) return <div className="diag">mic error: {error}</div>
  if (!active) return null

  return (
    <div className="meter-row">
      <span className="meter-label">mic</span>
      <div className="meter">
        <div className="meter-fill" ref={barRef} data-signal="no" />
      </div>
    </div>
  )
}
