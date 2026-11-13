import { createHash, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { loadConfig, type AppConfig } from './config.js'
import {
  assertIdTokenClaims,
  buildGoogleAuthUrl,
  createOAuthState,
  emailVerified,
  exchangeCodeForTokens,
  hashEmail,
  verifyGoogleIdToken,
  type GoogleIdClaims,
} from './auth/oidc.js'
import {
  buildSessionCookie,
  clearSessionCookie,
  parseCookieHeader,
  sealSessionId,
  sessionCookieName,
  unsealSessionId,
} from './auth/session.js'
import { processImageUpload } from './images/pipeline.js'
import { getStore, type Store } from './store/index.js'
import { buildPublicPreview, publicSubmissionView } from './wizard/preview.js'
import {
  validateDraft,
  validateSubmitMeta,
  type WizardDraft,
} from './wizard/validate.js'
import { processQueuedSubmission } from './github/pr.js'
import type { FetchLike } from './github/auth.js'

const SESSION_TTL_SEC = 60 * 60 * 12
const OAUTH_STATE_COOKIE = 'om_oauth_state'

type AuthContext = {
  contributorId: string
  sessionId: string
}

const corsHeaders = (origin: string | undefined, allowed: string[]) => {
  if (!origin || !allowed.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    Vary: 'Origin',
  }
}

const readJson = async (c: { req: { json: () => Promise<unknown> } }) => {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

export const createApp = (options?: {
  config?: AppConfig
  store?: Store
  fetchImpl?: FetchLike
}) => {
  const config = options?.config ?? loadConfig()
  const store = options?.store ?? getStore(config)
  const fetchImpl = options?.fetchImpl
  const app = new Hono()

  const requireSessionSecret = () => {
    if (!config.sessionSecret) {
      throw new Error('SESSION_SECRET (or OM_SPIKE_SECRET) is required')
    }
    return config.sessionSecret
  }

  const resolveAuth = async (cookieHeader: string | undefined): Promise<AuthContext | null> => {
    const cookies = parseCookieHeader(cookieHeader)
    const sealed = cookies[sessionCookieName]
    if (!sealed) return null
    const sessionId = unsealSessionId(sealed, requireSessionSecret())
    if (!sessionId) return null
    const session = await store.getSession(sessionId)
    if (!session) return null
    if (Date.parse(session.expiresAt) <= Date.now()) {
      await store.deleteSession(sessionId)
      return null
    }
    return { contributorId: session.contributorId, sessionId }
  }

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin')
    const headers = corsHeaders(origin, config.websiteOrigins)
    await next()
    for (const [key, value] of Object.entries(headers)) {
      c.header(key, value)
    }
  })

  app.options('*', (c) => c.body(null, 204))

  app.get('/', (c) =>
    c.json({
      service: 'open-matchday-community',
      version: '0.1.0',
      endpoints: [
        '/health',
        '/v1/auth/google/start',
        '/v1/auth/google/callback',
        '/v1/auth/session',
        '/v1/auth/logout',
        '/v1/wizard/validate',
        '/v1/wizard/preview',
        '/v1/wizard/submit',
        '/v1/images',
        '/v1/submissions/:id',
        '/v1/submissions/:id/open-pr',
      ],
      google_oidc_configured: config.googleOidcConfigured,
      github_app_configured: config.githubAppConfigured,
      auth_test_mode: config.authTestMode,
      sources: [
        'https://developers.google.com/identity/protocols/oauth2/openid-connect',
        'https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app',
      ],
    }),
  )

  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'open-matchday-community',
      google_oidc_configured: config.googleOidcConfigured,
      github_app_configured: config.githubAppConfigured,
      database: Boolean(config.databaseUrl),
    }),
  )

  app.get('/spike/secret-read', (c) => {
    const raw = process.env.OM_SPIKE_SECRET
    if (!raw) {
      return c.json(
        { ok: false, present: false, message: 'OM_SPIKE_SECRET is not set' },
        503,
      )
    }
    return c.json({
      ok: true,
      present: true,
      length: raw.length,
      sha256_12: createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12),
      store: 'vercel-environment-variable-secret',
    })
  })

  app.get('/spike/db-presence', (c) => {
    const url = process.env.DATABASE_URL
    if (!url) {
      return c.json({
        ok: true,
        present: false,
        chosen: 'neon-postgres-marketplace',
      })
    }
    let host = 'unparsed'
    try {
      host = new URL(url).host
    } catch {
      host = 'invalid-url'
    }
    return c.json({
      ok: true,
      present: true,
      host,
      scheme: url.split(':')[0] ?? 'unknown',
    })
  })

  app.get('/spike/auth-stub', (c) =>
    c.json({
      ok: true,
      status: config.googleOidcConfigured ? 'configured' : 'credentials_missing',
      provider: 'google',
      protocol: 'openid-connect',
      sources: [
        'https://developers.google.com/identity/protocols/oauth2/openid-connect',
      ],
      note: 'Use /v1/auth/google/start for the real OIDC authorization redirect',
    }),
  )

  app.get('/v1/auth/google/start', async (c) => {
    if (!config.googleOidcConfigured) {
      return c.json(
        {
          ok: false,
          error: 'google_oidc_not_configured',
          message:
            'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (Vercel Secrets). Create an OAuth client in Google Cloud Console with redirect URI matching GOOGLE_REDIRECT_URI.',
          sources: [
            'https://developers.google.com/identity/protocols/oauth2/openid-connect',
          ],
        },
        503,
      )
    }
    const state = createOAuthState()
    const returnTo = c.req.query('return_to') ?? ''
    const statePayload = Buffer.from(
      JSON.stringify({ state, return_to: returnTo }),
      'utf8',
    ).toString('base64url')
    setCookie(c, OAUTH_STATE_COOKIE, statePayload, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.isProduction,
      maxAge: 600,
    })
    const url = await buildGoogleAuthUrl(config, state)
    return c.redirect(url, 302)
  })

  app.get('/v1/auth/google/callback', async (c) => {
    if (!config.googleOidcConfigured) {
      return c.json({ ok: false, error: 'google_oidc_not_configured' }, 503)
    }
    const code = c.req.query('code')
    const state = c.req.query('state')
    const stateCookie = getCookie(c, OAUTH_STATE_COOKIE)
    if (!code || !state || !stateCookie) {
      return c.json({ ok: false, error: 'missing_oauth_params' }, 400)
    }
    let parsed: { state: string; return_to?: string }
    try {
      parsed = JSON.parse(
        Buffer.from(stateCookie, 'base64url').toString('utf8'),
      ) as { state: string; return_to?: string }
    } catch {
      return c.json({ ok: false, error: 'invalid_state_cookie' }, 400)
    }
    if (parsed.state !== state) {
      return c.json({ ok: false, error: 'state_mismatch' }, 400)
    }
    setCookie(c, OAUTH_STATE_COOKIE, '', {
      path: '/',
      maxAge: 0,
      httpOnly: true,
    })

    const tokens = await exchangeCodeForTokens(config, code)
    const claims = await verifyGoogleIdToken(config, tokens.id_token)
    if (!emailVerified(claims) || !claims.email) {
      return c.json({ ok: false, error: 'email_not_verified' }, 403)
    }

    await store.ensureSchema()
    const contributor = await store.upsertContributor({
      googleSub: claims.sub,
      emailSha256: hashEmail(claims.email),
    })
    const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000)
    const session = await store.createSession({
      contributorId: contributor.id,
      expiresAt,
    })
    const sealed = sealSessionId(session.id, requireSessionSecret())
    c.header(
      'Set-Cookie',
      buildSessionCookie({
        sealed,
        maxAgeSec: SESSION_TTL_SEC,
        secure: config.isProduction || c.req.url.startsWith('https://'),
      }),
    )

    const returnTo = parsed.return_to
    if (
      returnTo &&
      config.websiteOrigins.some((origin) => returnTo.startsWith(origin))
    ) {
      return c.redirect(returnTo, 302)
    }
    return c.json({
      ok: true,
      signed_in: true,
      contributor_id: contributor.id,
      note: 'Google email is stored hashed server-side and never returned',
    })
  })

  app.post('/v1/auth/test-login', async (c) => {
    if (!config.authTestMode) {
      return c.json({ ok: false, error: 'test_login_disabled' }, 404)
    }
    const body = (await readJson(c)) as {
      sub?: string
      email?: string
    } | null
    const sub = body?.sub ?? `test-sub-${randomBytes(8).toString('hex')}`
    const email = body?.email ?? `${sub}@example.test`
    await store.ensureSchema()
    const contributor = await store.upsertContributor({
      googleSub: sub,
      emailSha256: hashEmail(email),
    })
    const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000)
    const session = await store.createSession({
      contributorId: contributor.id,
      expiresAt,
    })
    const sealed = sealSessionId(session.id, requireSessionSecret())
    c.header(
      'Set-Cookie',
      buildSessionCookie({
        sealed,
        maxAgeSec: SESSION_TTL_SEC,
        secure: false,
      }),
    )
    return c.json({
      ok: true,
      signed_in: true,
      contributor_id: contributor.id,
      test_mode: true,
    })
  })

  app.get('/v1/auth/session', async (c) => {
    const auth = await resolveAuth(c.req.header('cookie'))
    if (!auth) {
      return c.json({ ok: true, signed_in: false })
    }
    return c.json({
      ok: true,
      signed_in: true,
      contributor_id: auth.contributorId,
    })
  })

  app.post('/v1/auth/logout', async (c) => {
    const auth = await resolveAuth(c.req.header('cookie'))
    if (auth) await store.deleteSession(auth.sessionId)
    c.header(
      'Set-Cookie',
      clearSessionCookie(config.isProduction || c.req.url.startsWith('https://')),
    )
    return c.json({ ok: true, signed_in: false })
  })

  app.post('/v1/wizard/validate', async (c) => {
    const body = (await readJson(c)) as { draft?: unknown } | null
    const result = validateDraft(body?.draft)
    return c.json({ ok: result.ok, errors: result.errors }, result.ok ? 200 : 400)
  })

  app.post('/v1/wizard/preview', async (c) => {
    const body = (await readJson(c)) as {
      draft?: unknown
      handle?: string
      profile_url?: string
    } | null
    const result = validateDraft(body?.draft)
    if (!result.ok) {
      return c.json({ ok: false, errors: result.errors }, 400)
    }
    const handle =
      typeof body?.handle === 'string' && body.handle.length > 0
        ? body.handle
        : 'preview_handle'
    const preview = buildPublicPreview(body!.draft as WizardDraft, {
      handle,
      profile_url: body?.profile_url ?? null,
    })
    const serialized = JSON.stringify(preview)
    if (serialized.includes('@') && /email/i.test(serialized)) {
      return c.json({ ok: false, error: 'preview_leaked_email' }, 500)
    }
    return c.json({ ok: true, preview })
  })

  app.post('/v1/images', async (c) => {
    const auth = await resolveAuth(c.req.header('cookie'))
    if (!auth) return c.json({ ok: false, error: 'unauthorized' }, 401)

    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.includes('multipart/form-data')) {
      return c.json(
        { ok: false, error: 'multipart_required', message: 'Send file field as multipart; remote URLs rejected' },
        400,
      )
    }
    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return c.json({ ok: false, error: 'file_required' }, 400)
    }
    const urlField = form.get('url')
    if (typeof urlField === 'string' && urlField.trim()) {
      return c.json({ ok: false, error: 'remote_url_rejected' }, 400)
    }
    const bytes = Buffer.from(await file.arrayBuffer())
    const processed = await processImageUpload({
      bytes,
      declaredFilename: file.name,
      declaredMime: file.type || undefined,
    })
    if (!processed.ok) {
      return c.json({ ok: false, error: processed.error }, 400)
    }
    await store.ensureSchema()
    const saved = await store.saveImage({
      contributorId: auth.contributorId,
      mime: processed.image.mime,
      filename: processed.image.filename,
      bytes: processed.image.bytes,
      sha256: processed.image.sha256,
    })
    return c.json({
      ok: true,
      asset: {
        id: saved.id,
        mime: saved.mime,
        filename: saved.filename,
        byte_length: saved.byteLength,
        sha256: saved.sha256,
      },
    })
  })

  app.post('/v1/wizard/submit', async (c) => {
    const auth = await resolveAuth(c.req.header('cookie'))
    if (!auth) return c.json({ ok: false, error: 'unauthorized' }, 401)

    const body = (await readJson(c)) as Record<string, unknown> | null
    if (!body) return c.json({ ok: false, error: 'invalid_json' }, 400)

    const draftResult = validateDraft(body.draft)
    const metaResult = validateSubmitMeta({
      handle: body.handle,
      profile_url: body.profile_url,
      rights_confirmed: body.rights_confirmed,
      consent_confirmed: body.consent_confirmed,
      idempotency_key: body.idempotency_key,
    })
    if (!draftResult.ok || !metaResult.ok) {
      return c.json(
        {
          ok: false,
          errors: [...draftResult.errors, ...metaResult.errors],
        },
        400,
      )
    }

    const draft = body.draft as WizardDraft
    for (const player of draft.players) {
      if (!player.photo_asset_id) continue
      const image = await store.getImage(player.photo_asset_id, auth.contributorId)
      if (!image) {
        return c.json(
          { ok: false, errors: [`unknown photo_asset_id ${player.photo_asset_id}`] },
          400,
        )
      }
      if (!player.photo) player.photo = {}
      player.photo.mime = image.mime
      player.photo.path = `photos/${image.filename}`
    }

    const preview = buildPublicPreview(draft, {
      handle: String(body.handle),
      profile_url:
        typeof body.profile_url === 'string' ? body.profile_url : null,
    })

    await store.ensureSchema()
    let { submission, created } = await store.createSubmission({
      contributorId: auth.contributorId,
      idempotencyKey: String(body.idempotency_key),
      handle: String(body.handle),
      profileUrl:
        typeof body.profile_url === 'string' && body.profile_url.length > 0
          ? body.profile_url
          : null,
      draftJson: draft,
      previewJson: preview,
    })

    let prError: string | null = null
    if (created && config.githubAppConfigured && submission.status === 'queued') {
      try {
        const processed = await processQueuedSubmission({
          config,
          store,
          submissionId: submission.id,
          fetchImpl,
        })
        submission = processed.submission
      } catch (err) {
        prError = err instanceof Error ? err.message : 'pr_open_failed'
      }
    }

    return c.json(
      {
        ok: true,
        created,
        submission: publicSubmissionView(submission),
        pr_error: prError,
      },
      created ? 201 : 200,
    )
  })

  app.post('/v1/submissions/:id/open-pr', async (c) => {
    const auth = await resolveAuth(c.req.header('cookie'))
    if (!auth) return c.json({ ok: false, error: 'unauthorized' }, 401)
    if (!config.githubAppConfigured) {
      return c.json(
        {
          ok: false,
          error: 'github_app_not_configured',
          message:
            'Set GITHUB_APP_CLIENT_ID, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID as Vercel Secrets after registering the org GitHub App.',
          sources: [
            'https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app',
          ],
        },
        503,
      )
    }
    const id = c.req.param('id')
    const existing = await store.getSubmission(id)
    if (!existing) return c.json({ ok: false, error: 'not_found' }, 404)
    if (existing.contributorId !== auth.contributorId) {
      return c.json({ ok: false, error: 'forbidden' }, 403)
    }
    try {
      const processed = await processQueuedSubmission({
        config,
        store,
        submissionId: id,
        fetchImpl,
      })
      return c.json({
        ok: true,
        submission: publicSubmissionView(processed.submission),
        pr: processed.opened
          ? {
              url: processed.opened.prUrl,
              number: processed.opened.prNumber,
              branch: processed.opened.branch,
              paths: processed.opened.paths,
              token_expires_at: processed.opened.tokenExpiresAt,
            }
          : null,
      })
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: 'pr_open_failed',
          message: err instanceof Error ? err.message : 'unknown',
        },
        502,
      )
    }
  })

  app.get('/v1/submissions/:id', async (c) => {
    const id = c.req.param('id')
    const submission = await store.getSubmission(id)
    if (!submission) return c.json({ ok: false, error: 'not_found' }, 404)
    return c.json({
      ok: true,
      submission: publicSubmissionView(submission),
    })
  })

  app.get('/v1/submissions', async (c) => {
    const auth = await resolveAuth(c.req.header('cookie'))
    if (!auth) return c.json({ ok: false, error: 'unauthorized' }, 401)
    const rows = await store.listSubmissionsForContributor(auth.contributorId)
    return c.json({
      ok: true,
      submissions: rows.map(publicSubmissionView),
    })
  })

  // Exported for unit tests that inject claim objects.
  ;(app as unknown as { __assertIdTokenClaims: typeof assertIdTokenClaims }).__assertIdTokenClaims =
    assertIdTokenClaims
  ;(app as unknown as { __config: AppConfig }).__config = config

  return app
}

export type { GoogleIdClaims }
