import type { Context } from 'hono'
import { getConnInfo } from 'hono/bun'

import { env } from '../config/env'

/** The TCP peer address Bun sees (the proxy's address when behind one). */
function getSocketIp(c: Context) {
  try {
    return getConnInfo(c).remote.address
  } catch {
    // Not served by Bun.serve (e.g. app.request in tests).
    return undefined
  }
}

/**
 * The client's IP, used for rate-limit keys and session audit fields.
 *
 * Proxy headers are client-controlled unless a trusted proxy overwrites them,
 * so they are only read when TRUST_PROXY_HEADERS is enabled. Otherwise the
 * socket address is used: every client gets its own key instead of all
 * clients sharing one.
 */
export function getClientIp(c: Context) {
  if (env.TRUST_PROXY_HEADERS) {
    const cloudflareIp = c.req.header('cf-connecting-ip')?.trim()
    if (cloudflareIp) return cloudflareIp

    const forwardedIp = c.req
      .header('x-forwarded-for')
      ?.split(',')[0]
      ?.trim()
    if (forwardedIp) return forwardedIp
  }

  return getSocketIp(c) || 'unknown'
}
