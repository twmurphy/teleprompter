/**
 * Serves the built app and, later, its API.
 *
 * Static assets are handled by the ASSETS binding; only `/api/*` reaches this
 * code, per `run_worker_first` in wrangler.jsonc.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
