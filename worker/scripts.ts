import type { Identity } from './access'

/** A script as stored. `user_email` never leaves the Worker. */
type Row = {
  id: string
  title: string
  body: string
  created_at: number
  updated_at: number
}

/** What the sidebar needs: enough to list, not the whole body. */
export type ScriptSummary = Pick<Row, 'id' | 'title' | 'updated_at'>

export type Script = Row

/** Long enough for any reasonable script, short enough to bound a row. */
const MAX_BODY = 200_000
const MAX_TITLE = 200

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** First non-empty line, so a script has a usable name without being asked. */
function titleFrom(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0)
  return (line?.trim() ?? 'Untitled').slice(0, MAX_TITLE)
}

type Draft = { title?: unknown; body?: unknown }

/** Accept only what we store, and only in the shape we store it. */
function readDraft(input: unknown): { title?: string; body?: string } | null {
  if (typeof input !== 'object' || input === null) return null
  const { title, body } = input as Draft
  if (title !== undefined && typeof title !== 'string') return null
  if (body !== undefined && typeof body !== 'string') return null
  if (typeof body === 'string' && body.length > MAX_BODY) return null
  return {
    title: typeof title === 'string' ? title.slice(0, MAX_TITLE) : undefined,
    body,
  }
}

/**
 * CRUD for one person's scripts.
 *
 * Ownership is enforced in the SQL rather than checked afterwards: every
 * statement carries the caller's email, so a request for someone else's id
 * simply matches no rows.
 */
export async function handleScripts(
  request: Request,
  env: Env,
  who: Identity,
  path: string,
): Promise<Response> {
  const id = path.replace(/^\/api\/scripts\/?/, '')
  const now = Date.now()

  if (!id) {
    if (request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, title, updated_at FROM scripts WHERE user_email = ? ORDER BY updated_at DESC',
      )
        .bind(who.email)
        .all<ScriptSummary>()
      return json(results)
    }

    if (request.method === 'POST') {
      const draft = readDraft(await request.json().catch(() => null))
      if (!draft) return json({ error: 'Invalid script' }, 400)

      const body = draft.body ?? ''
      const script: Script = {
        id: crypto.randomUUID(),
        title: draft.title?.trim() || titleFrom(body),
        body,
        created_at: now,
        updated_at: now,
      }
      await env.DB.prepare(
        'INSERT INTO scripts (id, user_email, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(script.id, who.email, script.title, script.body, now, now)
        .run()
      return json(script, 201)
    }

    return json({ error: 'Method not allowed' }, 405)
  }

  if (request.method === 'GET') {
    const script = await env.DB.prepare(
      'SELECT id, title, body, created_at, updated_at FROM scripts WHERE id = ? AND user_email = ?',
    )
      .bind(id, who.email)
      .first<Script>()
    return script ? json(script) : json({ error: 'Not found' }, 404)
  }

  if (request.method === 'PUT') {
    const draft = readDraft(await request.json().catch(() => null))
    if (!draft) return json({ error: 'Invalid script' }, 400)

    // COALESCE leaves a field alone when the client did not send it.
    const result = await env.DB.prepare(
      `UPDATE scripts SET title = COALESCE(?, title), body = COALESCE(?, body), updated_at = ?
       WHERE id = ? AND user_email = ?`,
    )
      .bind(draft.title ?? null, draft.body ?? null, now, id, who.email)
      .run()

    if (!result.meta.changes) return json({ error: 'Not found' }, 404)

    const script = await env.DB.prepare(
      'SELECT id, title, body, created_at, updated_at FROM scripts WHERE id = ? AND user_email = ?',
    )
      .bind(id, who.email)
      .first<Script>()
    return script ? json(script) : json({ error: 'Not found' }, 404)
  }

  if (request.method === 'DELETE') {
    const result = await env.DB.prepare(
      'DELETE FROM scripts WHERE id = ? AND user_email = ?',
    )
      .bind(id, who.email)
      .run()
    return result.meta.changes ? new Response(null, { status: 204 }) : json({ error: 'Not found' }, 404)
  }

  return json({ error: 'Method not allowed' }, 405)
}
