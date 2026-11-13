import { createPrivateKey } from 'node:crypto'
import { SignJWT } from 'jose'

export type GitHubAppCredentials = {
  clientId: string
  appId: string
  privateKeyPem: string
  installationId: string
}

export type InstallationToken = {
  token: string
  expiresAt: string
  permissions: Record<string, string>
  repositories: string[]
}

const normalizePem = (raw: string): string => {
  const trimmed = raw.trim()
  if (trimmed.includes('\\n') && !trimmed.includes('\n')) {
    return trimmed.replace(/\\n/g, '\n')
  }
  return trimmed
}

/** GitHub App JWT (max 10 minutes). Source: docs.github.com JWT for GitHub Apps. */
export const createAppJwt = async (
  credentials: GitHubAppCredentials,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string> => {
  // GitHub PEM may be PKCS#1 or PKCS#8; Node accepts both (GitHub Apps docs).
  const key = createPrivateKey(normalizePem(credentials.privateKeyPem))
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(nowSec - 60)
    .setExpirationTime(nowSec + 9 * 60)
    .setIssuer(credentials.clientId)
    .sign(key)
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
}>

/**
 * Mint a short-lived installation access token (expires ~1h).
 * Scoped to the teams repository with contents+pull_requests write only.
 * Source: docs.github.com generating an installation access token.
 */
export const createInstallationAccessToken = async (input: {
  credentials: GitHubAppCredentials
  owner: string
  repo: string
  fetchImpl?: FetchLike
  apiBase?: string
}): Promise<InstallationToken> => {
  const fetchImpl = input.fetchImpl ?? (fetch as FetchLike)
  const apiBase = (input.apiBase ?? 'https://api.github.com').replace(/\/$/, '')
  const jwt = await createAppJwt(input.credentials)
  const url = `${apiBase}/app/installations/${input.credentials.installationId}/access_tokens`
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      repositories: [input.repo],
      permissions: {
        contents: 'write',
        pull_requests: 'write',
      },
    }),
  })
  const bodyText = await response.text()
  if (!response.ok) {
    throw new Error(`installation_token_failed:${response.status}:${bodyText.slice(0, 200)}`)
  }
  const body = JSON.parse(bodyText) as {
    token: string
    expires_at: string
    permissions?: Record<string, string>
    repositories?: Array<{ name: string }>
  }
  if (!body.token || !body.expires_at) {
    throw new Error('installation_token_malformed')
  }
  const expiresMs = Date.parse(body.expires_at)
  if (!Number.isFinite(expiresMs) || expiresMs - Date.now() > 2 * 60 * 60 * 1000) {
    throw new Error('installation_token_expiry_unexpected')
  }
  return {
    token: body.token,
    expiresAt: body.expires_at,
    permissions: body.permissions ?? {},
    repositories: (body.repositories ?? []).map((r) => r.name),
  }
}

/** Official GitHub App bot noreply email (never Google / contributor email). */
export const githubAppBotIdentity = (appId: string, slug: string) => {
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  return {
    name: `${safeSlug}[bot]`,
    email: `${appId}+${safeSlug}[bot]@users.noreply.github.com`,
  }
}
