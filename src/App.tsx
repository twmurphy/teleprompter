import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LogOut,
  PanelLeft,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import { advanceCursor, parseScript } from './match'
import { useDictation, type Utterance } from './useDictation'
import { LIMITS, useSettings, type Settings } from './useSettings'
import { useScripts, type SaveState, type ScriptSummary } from './useScripts'
import { useWakeLock } from './useWakeLock'

type Mode = 'edit' | 'play'


export default function App() {
  const [mode, setMode] = useState<Mode>('edit')
  const [cursor, setCursor] = useState(0)
  const scripts = useScripts()
  const me = useMe()

  // Wide screens have room for the list beside the editor; narrow ones do not.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.matchMedia('(min-width: 768px)').matches,
  )

  const text = scripts.current?.body ?? ''
  const script = useMemo(() => parseScript(text), [text])

  // The engine can deliver several batches before React re-renders, so the
  // cursor is tracked in a ref and updated synchronously. Reading `cursor`
  // here would match every batch against a stale position.
  const cursorRef = useRef(cursor)
  const moveCursor = useCallback((next: number) => {
    cursorRef.current = next
    setCursor(next)
  }, [])

  /** Manual repositioning wins outright, in either direction. */
  const seek = useCallback((next: number) => moveCursor(next), [moveCursor])

  /**
   * Match the tail of what was just said against the script around the cursor.
   *
   * The matcher aligns a whole phrase rather than a word, so a re-sent
   * transcript lands where it landed before and needs no bookkeeping to make it
   * idempotent, and it decides for itself when going back is a re-read rather
   * than the engine revising itself.
   */
  const handleUtterance = useCallback(
    ({ words }: Utterance) => {
      moveCursor(advanceCursor(script, cursorRef.current, words))
    },
    [script, moveCursor],
  )

  const dictation = useDictation({ onUtterance: handleUtterance })

  // Reading aloud looks like idling to a phone: no touches, no scrolling.
  useWakeLock(mode === 'play')
  const { settings, update, reset } = useSettings()
  const [settingsOpen, setSettingsOpen] = useState(false)

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
      setSettingsOpen(false)
    }
    setMode(next)
  }

  return (
    <div className="app">
      <header className="bar">
        <div className="left">
          {mode === 'edit' && (
            <button
              className={sidebarOpen ? 'icon on' : 'icon'}
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label="Show script list"
              aria-expanded={sidebarOpen}
              title="Script list"
            >
              <PanelLeft size={18} aria-hidden />
            </button>
          )}
        </div>

        <div className="segmented" role="group">
          <button
            className={mode === 'edit' ? 'on' : ''}
            aria-pressed={mode === 'edit'}
            onClick={() => goTo('edit')}
          >
            Edit
          </button>
          <button
            className={mode === 'play' ? 'on' : ''}
            aria-pressed={mode === 'play'}
            onClick={() => goTo('play')}
          >
            Play
          </button>
        </div>

        {/* Only useful while reading, and Edit mode should stay uncluttered. */}
        {mode === 'play' && (
        <div className="tools">
          <button
            className="icon"
            onClick={() => seek(0)}
            aria-label="Back to the start of the script"
            title="Back to the start"
          >
            <RotateCcw size={18} aria-hidden />
          </button>
          <button
            className={settingsOpen ? 'icon on' : 'icon'}
            onClick={() => setSettingsOpen((open) => !open)}
            aria-label="Reading settings"
            aria-expanded={settingsOpen}
            title="Reading settings"
          >
            <SlidersHorizontal size={18} aria-hidden />
          </button>
        </div>
        )}
      </header>

      <div className="content">
        {settingsOpen && (
          <SettingsPanel
            settings={settings}
            onChange={update}
            onReset={reset}
            onClose={() => setSettingsOpen(false)}
          />
        )}

        {mode === 'edit' && sidebarOpen && (
          <Sidebar
            list={scripts.list}
            currentId={scripts.current?.id ?? null}
            loading={scripts.loading}
            error={scripts.error}
            saveState={scripts.saveState}
            email={me}
            onOpen={scripts.open}
            onCreate={scripts.create}
            onDelete={scripts.remove}
          />
        )}

        {mode === 'edit' ? (
          scripts.current ? (
            <textarea
              className="editor"
              style={{ fontSize: `calc(1.1rem * ${settings.scale})` }}
              value={text}
              onChange={(e) => scripts.edit(e.target.value)}
              placeholder="Paste or type your script…"
              spellCheck={false}
            />
          ) : (
            <p className="empty">
              {scripts.loading ? 'Loading…' : 'No script open. Create one to start.'}
            </p>
          )
        ) : (
          <Stage
            script={script}
            text={text}
            cursor={cursor}
            onSeek={seek}
            settings={settings}
            showGuide={settingsOpen}
          />
        )}
      </div>
    </div>
  )
}

type StageProps = {
  script: ReturnType<typeof parseScript>
  text: string
  cursor: number
  onSeek: (index: number) => void
  settings: Settings
  /** Marks where the reading line falls, while it is being adjusted. */
  showGuide: boolean
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

const Stage = memo(function Stage({
  script,
  text,
  cursor,
  onSeek,
  settings,
  showGuide,
}: StageProps) {
  const { scale, readingLine } = settings
  const activeRef = useRef<HTMLSpanElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef(0)

  useEffect(() => {
    const container = containerRef.current
    const active = activeRef.current
    if (!container || !active) return

    const from = container.scrollTop
    const to =
      active.offsetTop - container.clientHeight * readingLine + active.clientHeight / 2
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
    // Re-runs when the reading line moves so the change is visible immediately.
  }, [cursor, readingLine])

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
    <div className="stage-wrap">
      {/* Sits outside the scroller so it stays put while the script moves. */}
      {showGuide && (
        <div className="guide" style={{ top: `${readingLine * 100}%` }} />
      )}
      <div
        className="stage"
        ref={containerRef}
        // Scales the responsive size rather than replacing it, so the script
        // still adapts to the screen it is on.
        style={{ fontSize: `calc(clamp(1.25rem, 4.8vw, 3rem) * ${scale})` }}
      >
      {/* Lead-in and lead-out space lives on the inner element. Put it on the
          scroll container instead and its padding sets a floor on the box
          height, which forces the whole page to scroll. */}
      <div
        className="stage-inner"
        style={{
          paddingTop: `${readingLine * 100}vh`,
          paddingBottom: `${(1 - readingLine) * 100}vh`,
        }}
      >
          {nodes}
        </div>
      </div>
    </div>
  )
})

/**
 * Text size and reading position. Both are physical constraints of a phone
 * propped behind a camera rather than styling, so they are adjustable from
 * either mode and take effect while you watch.
 */
function SettingsPanel({
  settings,
  onChange,
  onReset,
  onClose,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
  onClose: () => void
}) {
  return (
    <div className="settings">
      <label>
        <span>
          Text size <b>{Math.round(settings.scale * 100)}%</b>
        </span>
        <input
          type="range"
          min={LIMITS.scale.min}
          max={LIMITS.scale.max}
          step={LIMITS.scale.step}
          value={settings.scale}
          onChange={(e) => onChange({ scale: Number(e.target.value) })}
        />
      </label>

      <label>
        <span>
          Eye position <b>{Math.round(settings.readingLine * 100)}% from top</b>
        </span>
        <input
          type="range"
          min={LIMITS.readingLine.min}
          max={LIMITS.readingLine.max}
          step={LIMITS.readingLine.step}
          value={settings.readingLine}
          onChange={(e) => onChange({ readingLine: Number(e.target.value) })}
        />
      </label>

      <div className="settings-actions">
        <button onClick={onReset}>Reset</button>
        <button onClick={onClose}>Done</button>
      </div>
    </div>
  )
}

/** The signed-in email, from the Access token the Worker verified. */
function useMe() {
  const [email, setEmail] = useState<string | null>(null)
  useEffect(() => {
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((who: { email: string } | null) => setEmail(who?.email ?? null))
      .catch(() => setEmail(null))
  }, [])
  return email
}

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  failed: 'Not saved — check your connection',
}

/**
 * The script list. Titles come from each script's opening line, so editing a
 * script renames it here and there is nothing separate to keep in sync.
 */
function Sidebar({
  list,
  currentId,
  loading,
  error,
  saveState,
  email,
  onOpen,
  onCreate,
  onDelete,
}: {
  list: ScriptSummary[]
  currentId: string | null
  loading: boolean
  error: string | null
  saveState: SaveState
  email: string | null
  onOpen: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}) {
  return (
    <aside className="sidebar">
      <button className="new" onClick={onCreate}>
        <Plus size={16} aria-hidden /> New script
      </button>

      <div className="scripts">
        {loading && <p className="note">Loading…</p>}
        {error && <p className="note error">{error}</p>}
        {!loading && !error && list.length === 0 && (
          <p className="note">No scripts yet.</p>
        )}

        {list.map((entry) => (
          <div
            key={entry.id}
            className={entry.id === currentId ? 'script on' : 'script'}
          >
            <button className="title" onClick={() => onOpen(entry.id)}>
              {entry.title}
            </button>
            <button
              className="icon remove"
              aria-label={`Delete ${entry.title}`}
              onClick={() => {
                if (confirm(`Delete "${entry.title}"? This cannot be undone.`)) {
                  onDelete(entry.id)
                }
              }}
            >
              <Trash2 size={15} aria-hidden />
            </button>
          </div>
        ))}
      </div>

      <footer className="account">
        <span className="save">{SAVE_LABEL[saveState]}</span>
        {email && <span className="who">{email}</span>}
        {/* Access owns the session, so signing out is its endpoint, not ours. */}
        <a className="signout" href="/cdn-cgi/access/logout">
          <LogOut size={14} aria-hidden /> Sign out
        </a>
      </footer>
    </aside>
  )
}
