import { createHmac, timingSafeEqual } from 'node:crypto'

const COOKIE_NAME = 'om_session'

export const sessionCookieName = COOKIE_NAME

const sign = (value: string, secret: string): string =>
  createHmac('sha256', secret).update(value).digest('base64url')

export const sealSessionId = (sessionId: string, secret: string): string => {
  const sig = sign(sessionId, secret)
  return `${sessionId}.${sig}`
}

export const unsealSessionId = (
  sealed: string,
  secret: string,
): string | null => {
  const idx = sealed.lastIndexOf('.')
  if (idx <= 0) return null
  const sessionId = sealed.slice(0, idx)
  const sig = sealed.slice(idx + 1)
  const expected = sign(sessionId, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return sessionId
}

export const parseCookieHeader = (
  header: string | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    out[key] = decodeURIComponent(value)
  }
  return out
}

export const buildSessionCookie = (input: {
  sealed: string
  maxAgeSec: number
  secure: boolean
  /** Cross-site website -> API needs None; local same-site checks use Lax. */
  sameSite?: 'Lax' | 'None'
}): string => {
  const sameSite = input.sameSite ?? (input.secure ? 'None' : 'Lax')
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(input.sealed)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    `Max-Age=${input.maxAgeSec}`,
  ]
  if (input.secure || sameSite === 'None') parts.push('Secure')
  return parts.join('; ')
}

export const clearSessionCookie = (secure: boolean): string => {
  const sameSite = secure ? 'None' : 'Lax'
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    'Max-Age=0',
  ]
  if (secure || sameSite === 'None') parts.push('Secure')
  return parts.join('; ')
}
