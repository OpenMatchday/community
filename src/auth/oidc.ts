import { createHash, randomBytes } from 'node:crypto'
import * as jose from 'jose'
import {
  GOOGLE_DISCOVERY_URL,
  GOOGLE_ISSUERS,
  type AppConfig,
} from '../config.js'

export type GoogleIdClaims = {
  sub: string
  email?: string
  email_verified?: boolean | string
  iss: string
  aud: string | string[]
  exp: number
}

type DiscoveryDoc = {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  issuer: string
}

let discoveryCache: { doc: DiscoveryDoc; fetchedAt: number } | null = null

export const fetchGoogleDiscovery = async (): Promise<DiscoveryDoc> => {
  const now = Date.now()
  if (discoveryCache && now - discoveryCache.fetchedAt < 60 * 60 * 1000) {
    return discoveryCache.doc
  }
  const res = await fetch(GOOGLE_DISCOVERY_URL)
  if (!res.ok) {
    throw new Error(`google discovery HTTP ${res.status}`)
  }
  const doc = (await res.json()) as DiscoveryDoc
  discoveryCache = { doc, fetchedAt: now }
  return doc
}

export const createOAuthState = (): string =>
  randomBytes(24).toString('base64url')

export const buildGoogleAuthUrl = async (
  config: AppConfig,
  state: string,
): Promise<string> => {
  if (!config.googleClientId) {
    throw new Error('GOOGLE_CLIENT_ID is not configured')
  }
  const discovery = await fetchGoogleDiscovery()
  const url = new URL(discovery.authorization_endpoint)
  url.searchParams.set('client_id', config.googleClientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('redirect_uri', config.googleRedirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'online')
  url.searchParams.set('include_granted_scopes', 'true')
  return url.toString()
}

export const exchangeCodeForTokens = async (
  config: AppConfig,
  code: string,
): Promise<{ id_token: string }> => {
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error('Google OIDC client is not configured')
  }
  const discovery = await fetchGoogleDiscovery()
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: config.googleRedirectUri,
    grant_type: 'authorization_code',
  })
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`token exchange failed HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = (await res.json()) as { id_token?: string }
  if (!json.id_token) {
    throw new Error('token response missing id_token')
  }
  return { id_token: json.id_token }
}

export const verifyGoogleIdToken = async (
  config: AppConfig,
  idToken: string,
): Promise<GoogleIdClaims> => {
  if (!config.googleClientId) {
    throw new Error('GOOGLE_CLIENT_ID is not configured')
  }
  const discovery = await fetchGoogleDiscovery()
  const JWKS = jose.createRemoteJWKSet(new URL(discovery.jwks_uri))
  const { payload } = await jose.jwtVerify(idToken, JWKS, {
    audience: config.googleClientId,
  })
  const iss = String(payload.iss ?? '')
  if (!GOOGLE_ISSUERS.has(iss)) {
    throw new Error(`invalid iss ${iss}`)
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('missing sub')
  }
  return payload as GoogleIdClaims
}

/** Claim checks used by unit tests without network JWKS. */
export const assertIdTokenClaims = (
  claims: GoogleIdClaims,
  audience: string,
  nowSec = Math.floor(Date.now() / 1000),
): void => {
  if (!GOOGLE_ISSUERS.has(claims.iss)) {
    throw new Error(`invalid iss ${claims.iss}`)
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(audience)) {
    throw new Error('invalid aud')
  }
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) {
    throw new Error('token expired')
  }
  if (!claims.sub) {
    throw new Error('missing sub')
  }
}

export const hashEmail = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex')

export const emailVerified = (claims: GoogleIdClaims): boolean =>
  claims.email_verified === true || claims.email_verified === 'true'
