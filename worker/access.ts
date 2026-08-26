import { createRemoteJWKSet, jwtVerify } from 'jose'

/** A signed-in person, as Cloudflare Access sees them. */
export type Identity = { email: string }

/**
 * Cached across requests within an isolate. `createRemoteJWKSet` handles
 * fetching, caching by key id, and refreshing on an unknown key, so building
 * one per request would throw that away.
 */
let keys: ReturnType<typeof createRemoteJWKSet> | null = null

/** Read a cookie without pulling in a parser. */
function cookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

/**
 * Identify the caller from the Cloudflare Access token, or return null.
 *
 * Access sitting in front of the hostname is not enough on its own: the Worker
 * is also reachable on its workers.dev URL, which Access does not cover. The
 * token is therefore verified here rather than assumed, which is what makes the
 * check hold no matter how the request arrived.
 */
export async function identify(request: Request, env: Env): Promise<Identity | null> {
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ?? cookie(request, 'CF_Authorization')
  if (!token) return null

  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`
  keys ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))

  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      // Pins the token to this application, not merely to the Zero Trust org.
      audience: env.ACCESS_AUD,
    })
    return typeof payload.email === 'string' ? { email: payload.email } : null
  } catch {
    // Expired, wrong audience, bad signature — all mean "not signed in".
    return null
  }
}
