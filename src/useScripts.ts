import { useCallback, useEffect, useRef, useState } from 'react'

/** Enough to draw the list. */
export type ScriptSummary = { id: string; title: string; updated_at: number }

/** A script with its text. */
export type Script = ScriptSummary & { body: string; created_at: number }

/** How long to wait after typing stops before saving. */
const SAVE_DELAY = 800

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  if (!response.ok) {
    // A 401 here means the Access session lapsed, which is a thing the reader
    // can act on — unlike a status code.
    throw new Error(
      response.status === 401
        ? 'Signed out. Reload the page to sign in again.'
        : 'Could not reach your scripts. Check your connection.',
    )
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

/**
 * The signed-in person's scripts, backed by D1.
 *
 * Edits are held locally and written back after a pause, so typing is never
 * waiting on the network. The title is derived server-side from the opening
 * line, so the list renames itself as a script is edited.
 */
export function useScripts() {
  const [list, setList] = useState<ScriptSummary[]>([])
  const [current, setCurrent] = useState<Script | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const refresh = useCallback(async () => {
    const scripts = await api<ScriptSummary[]>('/api/scripts')
    setList(scripts)
    return scripts
  }, [])

  const open = useCallback(async (id: string) => {
    setCurrent(await api<Script>(`/api/scripts/${id}`))
  }, [])

  const create = useCallback(async () => {
    const script = await api<Script>('/api/scripts', {
      method: 'POST',
      body: JSON.stringify({ title: 'New script', body: '' }),
    })
    setCurrent(script)
    await refresh()
    return script
  }, [refresh])

  const remove = useCallback(
    async (id: string) => {
      await api<void>(`/api/scripts/${id}`, { method: 'DELETE' })
      const remaining = await refresh()
      // Deleting what you were reading should land somewhere sensible.
      setCurrent((open_) => (open_?.id === id ? null : open_))
      return remaining
    },
    [refresh],
  )

  /** Update the text now, persist shortly. */
  const edit = useCallback(
    (body: string) => {
      setCurrent((script) => (script ? { ...script, body } : script))
      clearTimeout(timer.current)
      setSaveState('saving')
      timer.current = setTimeout(() => {
        setCurrent((script) => {
          if (!script) return script
          void api<Script>(`/api/scripts/${script.id}`, {
            method: 'PUT',
            body: JSON.stringify({ body }),
          })
            .then(async (saved) => {
              setSaveState('saved')
              // The title may have changed with the opening line.
              setList((entries) =>
                entries.map((entry) =>
                  entry.id === saved.id
                    ? { id: saved.id, title: saved.title, updated_at: saved.updated_at }
                    : entry,
                ),
              )
            })
            .catch(() => setSaveState('failed'))
          return script
        })
      }, SAVE_DELAY)
    },
    [],
  )

  // Load the list on mount, and open the most recently edited script.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const scripts = await api<ScriptSummary[]>('/api/scripts')
        if (cancelled) return
        setList(scripts)
        if (scripts[0]) setCurrent(await api<Script>(`/api/scripts/${scripts[0].id}`))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  return { list, current, loading, error, saveState, open, create, remove, edit }
}
