import type { Context } from 'hono'

import { env } from '../config/env'

export function getClientIp(c: Context) {
  if (!env.TRUST_PROXY_HEADERS) return 'untrusted-proxy'

  const cloudflareIp = c.req.header('cf-connecting-ip')?.trim()
  if (cloudflareIp) return cloudflareIp

  const forwardedIp = c.req
    .header('x-forwarded-for')
    ?.split(',')[0]
    ?.trim()

  return forwardedIp || 'unknown'
}
