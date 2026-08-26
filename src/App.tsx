import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react'
import { advanceCursor, parseScript, type ScriptWord } from './match'
import { useDictation, type Utterance } from './useDictation'

const STORAGE_KEY = 'teleprompter:script'

const SAMPLE = `Tap Edit to replace this with your own script.

Switch to Play and start reading aloud. Words light up as they are recognised
and the script scrolls to keep your place.

If it ever loses you, just tap the word you are actually on.`

type Mode = 'edit' | 'play'

export default function App() {
  const [mode, setMode] = useState<Mode>('edit')
  const [text, setText] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? SAMPLE,
  )

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, text)
  }, [text])

  const script = useMemo(() => parseScript(text), [text])

  // The cursor never enters React state. Advancing a word touches only the two
  // affected elements through the Stage handle; putting it in state would
  // re-render every word in the script several times a second.
  const cursorRef = useRef(0)
  const stageRef = useRef<StageHandle>(null)

  const moveCursor = useCallback((next: number) => {
    cursorRef.current = next
    stageRef.current?.setCursor(next)
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

  // Entering Play starts listening and goes fullscreen; leaving it undoes both.
  // There is no manual control — reading aloud is the only thing Play mode is
  // for. Fullscreen has to be requested from a user gesture, which the button
  // click provides; if the browser refuses we carry on windowed rather than
  // block the read.
  const goTo = (next: Mode) => {
    if (next === 'play') {
      document.documentElement.requestFullscreen?.().catch(() => {})
      void dictation.start()
    } else {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      dictation.stop()
    }
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
        <Stage ref={stageRef} script={script} text={text} onSeek={moveCursor} />
      )}
    </div>
  )
}

/**
 * How quickly the scroll closes the gap to the reading line, per frame.
 * The loop always eases toward the current target, so a target that moves
 * mid-flight is the normal case rather than an interruption — no animation is
 * ever restarted, which is what kept the old fixed-duration ease permanently
 * behind a fast reader.
 */
const FOLLOW = 0.16

/**
 * Where the active word sits, as a fraction of the stage height. Higher up
 * leaves more of the script visible ahead of you. This also sets the lead-in
 * and lead-out padding below, so the first and last words can still reach the
 * line — keep the two derived from this one value.
 */
const READING_LINE = 0.25

export type StageHandle = { setCursor: (index: number) => void }

type StageProps = {
  script: ScriptWord[]
  text: string
  onSeek: (index: number) => void
  ref?: Ref<StageHandle>
}

/**
 * The scrolling script.
 *
 * Words are rendered once per script change and never re-rendered to move the
 * cursor. Advancing repaints only the elements between the old and new
 * position — normally one or two — because a React pass over a thousand-word
 * script is the difference between keeping up with a speaker and trailing them
 * on a phone.
 */
const Stage = memo(function Stage({ script, text, onSeek, ref }: StageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const wordsRef = useRef<(HTMLSpanElement | null)[]>([])
  const cursorRef = useRef(0)
  const targetRef = useRef(0)

  const setCursor = useCallback((next: number) => {
    const words = wordsRef.current
    const previous = cursorRef.current
    cursorRef.current = next

    // Only the range between the two positions can have changed appearance.
    const from = Math.max(0, Math.min(previous, next))
    const to = Math.min(Math.max(previous, next), words.length - 1)
    for (let i = from; i <= to; i++) {
      const element = words[i]
      if (element) element.className = i < next ? 'said' : i === next ? 'now' : ''
    }

    const active = words[next]
    const container = containerRef.current
    if (active && container) {
      targetRef.current =
        active.offsetTop - container.clientHeight * READING_LINE + active.clientHeight / 2
    }
  }, [])

  useImperativeHandle(ref, () => ({ setCursor }), [setCursor])

  // A single loop for the lifetime of Play mode, easing toward whatever the
  // current target is.
  useEffect(() => {
    let frame = 0
    const follow = () => {
      const container = containerRef.current
      if (container) {
        const delta = targetRef.current - container.scrollTop
        if (Math.abs(delta) > 0.5) container.scrollTop += delta * FOLLOW
      }
      frame = requestAnimationFrame(follow)
    }
    frame = requestAnimationFrame(follow)
    return () => cancelAnimationFrame(frame)
  }, [])

  // Editing the script resets the position. Classes have to be rewritten here
  // too: React only touches className when its own previous value differs, and
  // it has no idea we have been mutating these elements behind its back, so a
  // re-render would otherwise leave stale highlighting in place. Runs after the
  // ref callbacks, so every element is attached by this point.
  useEffect(() => {
    cursorRef.current = 0
    targetRef.current = 0
    wordsRef.current.length = script.length
    for (let i = 0; i < wordsRef.current.length; i++) {
      const element = wordsRef.current[i]
      if (element) element.className = i === 0 ? 'now' : ''
    }
  }, [script])

  let cut = 0
  const nodes = script.map((word, i) => {
    // Replay the original whitespace and any punctuation-only tokens between words.
    const gap = text.slice(cut, word.start)
    cut = word.start + word.raw.length
    return (
      <span key={i}>
        {gap}
        <span
          ref={(element) => {
            wordsRef.current[i] = element
          }}
          className={i === 0 ? 'now' : ''}
          onClick={() => onSeek(i)}
        >
          {word.raw}
        </span>
      </span>
    )
  })

  return (
    <div className="stage" ref={containerRef}>
      {/* Lead-in and lead-out space lives on the inner element. Put it on the
          scroll container instead and its padding sets a floor on the box
          height, which forces the whole page to scroll. */}
      <div
        className="stage-inner"
        style={{
          paddingTop: `${READING_LINE * 100}vh`,
          paddingBottom: `${(1 - READING_LINE) * 100}vh`,
        }}
      >
        {nodes}
      </div>
    </div>
  )
})
