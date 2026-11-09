import { createHash } from 'node:crypto'
import { Hono } from 'hono'

const app = new Hono()

const fingerprint = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)

app.get('/', (c) =>
  c.json({
    service: 'open-matchday-community',
    spike: 'd7',
    endpoints: ['/health', '/spike/secret-read', '/spike/auth-stub', '/spike/db-presence'],
  }),
)

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'open-matchday-community',
    spike: 'd7',
  }),
)

app.get('/spike/secret-read', (c) => {
  const raw = process.env.OM_SPIKE_SECRET
  if (!raw) {
    return c.json(
      {
        ok: false,
        present: false,
        message: 'OM_SPIKE_SECRET is not set in this environment',
      },
      503,
    )
  }

  return c.json({
    ok: true,
    present: true,
    length: raw.length,
    sha256_12: fingerprint(raw),
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
      message: 'DATABASE_URL not injected yet; Marketplace Neon provision deferred',
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
    status: 'stub',
    provider: 'google',
    protocol: 'openid-connect',
    sources: [
      'https://developers.google.com/identity/protocols/oauth2/openid-connect',
    ],
    note: 'No Google client credentials in this spike; OM-040 implements real OIDC',
  }),
)

export default app
