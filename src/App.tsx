import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { advanceCursor, parseScript } from './match'
import { useDictation, type Utterance } from './useDictation'

const STORAGE_KEY = 'teleprompter:script'

const SAMPLE = `Good morning, and welcome.

This is a sample script designed to test a teleprompter at a comfortable speaking pace. As you read, pay attention to the size of the text, the scrolling speed, and how easily your eyes can follow each line.

Today, we are testing several kinds of sentences.

Some are short.

Others are slightly longer, giving you time to see how the teleprompter handles natural pauses, changes in rhythm, and longer stretches of continuous speech.

Now, let's test a few numbers. The time is 10:30. The temperature is 72 degrees. Our sample project includes 3 stages, 12 tasks, and a target completion rate of 95 percent.

Next, we'll test punctuation.

Does a question mark create a natural pause? What about a comma, a semicolon, or a colon? And when a sentence ends, is there enough space to comfortably move to the next line?

Here is a slightly faster section.

The goal of a good teleprompter is not to make the speaker appear to be reading. Instead, it should help the speaker maintain eye contact, deliver information clearly, and move through the script at a natural and consistent pace.

Now slow down.

Take a brief pause.

Look directly at the camera.

Then continue.

This final section can be used to test the end of the script. Check that the last few lines remain visible long enough to read comfortably and that the scrolling stops at the correct position.

Thank you for testing the teleprompter.

This concludes the sample script.`

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
        <Stage script={script} text={text} cursor={cursor} onSeek={moveCursor} />
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
 * position toward the active word over 2s with an easeOutQuad curve. The long,
 * decelerating curve is what makes word-by-word movement read as a glide rather
 * than a series of steps.
 */
const SCROLL_DURATION = 2000

/**
 * Where the active word sits, as a fraction of the stage height. Higher up
 * leaves more of the script visible ahead of you. This also sets the lead-in
 * and lead-out padding below, so the first and last words can still reach the
 * line — keep the two derived from this one value.
 */
const READING_LINE = 0.25

const Stage = memo(function Stage({ script, text, cursor, onSeek }: StageProps) {
  const activeRef = useRef<HTMLSpanElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef(0)

  useEffect(() => {
    const container = containerRef.current
    const active = activeRef.current
    if (!container || !active) return

    const from = container.scrollTop
    const to =
      active.offsetTop - container.clientHeight * READING_LINE + active.clientHeight / 2
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
