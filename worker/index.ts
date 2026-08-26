import { identify } from './access'
import { handleScripts } from './scripts'

/**
 * Serves the built app and its API.
 *
 * Static assets are handled by the ASSETS binding; only `/api/*` reaches this
 * code, per `run_worker_first` in wrangler.jsonc.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)

    // Every API route is private, so identity is established once, up front.
    const identity = await identify(request, env)
    if (!identity) {
      return Response.json({ error: 'Not signed in' }, { status: 401 })
    }

    if (url.pathname === '/api/me' && request.method === 'GET') {
      return Response.json(identity)
    }

    if (url.pathname.startsWith('/api/scripts')) {
      return handleScripts(request, env, identity, url.pathname)
    }

    return Response.json({ error: 'Not found' }, { status: 404 })
  },
} satisfies ExportedHandler<Env>
