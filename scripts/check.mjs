import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { PNG } from './png-fixture.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(root, '..')

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

const readJson = async (res) => JSON.parse(await res.text())

const run = (command, args, env = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      shell: false,
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
  })

const loadApp = async (env) => {
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete process.env[k]
    else process.env[k] = v
  }
  // Fresh module graph so config/store pick up env.
  const entry = path.join(repoRoot, 'src', 'create-app.ts')
  const mod = await import(`${pathToFileURL(entry).href}?t=${Date.now()}`)
  const { createMemoryStore } = await import(
    `${pathToFileURL(path.join(repoRoot, 'src', 'store', 'memory.ts')).href}?t=${Date.now()}`
  )
  const store = createMemoryStore()
  const config = {
    isProduction: false,
    authTestMode: true,
    sessionSecret: 'om-check-session-secret',
    googleClientId: undefined,
    googleClientSecret: undefined,
    googleRedirectUri: 'http://127.0.0.1/v1/auth/google/callback',
    publicBaseUrl: 'http://127.0.0.1',
    websiteOrigins: ['https://openmatchday.github.io', 'http://127.0.0.1:4173'],
    databaseUrl: undefined,
    googleOidcConfigured: false,
  }
  return mod.createApp({ config, store })
}

const serveApp = async (app) => {
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '127.0.0.1'
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const url = `http://${host}${req.url ?? '/'}`
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (value == null) continue
        if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
        else headers.set(key, value)
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body,
      })
      const response = await app.fetch(request)
      res.statusCode = response.status
      response.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (err) {
      res.statusCode = 500
      res.end(String(err))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

const cookieFrom = (res) => {
  const raw = res.headers.getSetCookie?.() ?? []
  if (raw.length) return raw.map((c) => c.split(';')[0]).join('; ')
  const single = res.headers.get('set-cookie')
  return single ? single.split(';')[0] : ''
}

const main = async () => {
  await run(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--noEmit',
  ])

  process.env.OM_SPIKE_SECRET = 'om-d7-local-self-check-secret'
  process.env.OM_AUTH_TEST_MODE = '1'
  delete process.env.DATABASE_URL
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET

  const app = await loadApp({
    OM_SPIKE_SECRET: 'om-d7-local-self-check-secret',
    OM_AUTH_TEST_MODE: '1',
    DATABASE_URL: null,
    GOOGLE_CLIENT_ID: null,
    GOOGLE_CLIENT_SECRET: null,
    VERCEL_ENV: null,
  })
  const { base, close } = await serveApp(app)

  try {
    const health = await readJson(await fetch(`${base}/health`))
    assert(health.ok === true, 'health ok')
    assert(health.google_oidc_configured === false, 'oidc flag')

    const secretBody = await readJson(await fetch(`${base}/spike/secret-read`))
    assert(secretBody.present === true, 'secret present')
    assert(
      secretBody.sha256_12 ===
        createHash('sha256')
          .update('om-d7-local-self-check-secret', 'utf8')
          .digest('hex')
          .slice(0, 12),
      'secret fingerprint',
    )

    const start = await fetch(`${base}/v1/auth/google/start`, {
      redirect: 'manual',
    })
    assert(start.status === 503, 'start without credentials')

    const loginRes = await fetch(`${base}/v1/auth/test-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: 'check-user', email: 'check@example.test' }),
    })
    const login = await readJson(loginRes)
    assert(login.ok === true && login.signed_in === true, 'test login')
    const cookie = cookieFrom(loginRes)
    assert(cookie.includes('om_session='), 'session cookie')
    assert(!JSON.stringify(login).includes('check@example.test'), 'email leak login')

    const session = await readJson(
      await fetch(`${base}/v1/auth/session`, { headers: { cookie } }),
    )
    assert(session.signed_in === true, 'session signed in')

    const badDraft = await readJson(
      await fetch(`${base}/v1/wizard/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          draft: {
            sport_id: 'basketball',
            email: 'nope@example.com',
            category_id: 'senior',
            competition_id: 'harbor_open',
            club: { id: 'c1', name: 'Club', country_id: 'it' },
            team: { id: 't1', name: 'Team' },
            season: { id: 's1', name: '2026' },
            players: [{ id: 'p1', name: 'Pat' }],
            memberships: [{ player_id: 'p1', number: 7 }],
          },
        }),
      }),
    )
    assert(badDraft.ok === false, 'banned email field')
    assert(
      badDraft.errors.some((e) => e.includes('email')),
      'email error',
    )

    const png = PNG.tiny()
    const form = new FormData()
    form.append('file', new File([png], 'player.png', { type: 'image/png' }))
    const imgRes = await fetch(`${base}/v1/images`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    })
    const img = await readJson(imgRes)
    assert(img.ok === true, 'image upload')
    assert(img.asset.filename.endsWith('.png'), 'safe filename')
    assert(!img.asset.filename.includes('..'), 'path traversal')

    const svgForm = new FormData()
    svgForm.append(
      'file',
      new File([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')], 'x.svg', {
        type: 'image/svg+xml',
      }),
    )
    const svg = await readJson(
      await fetch(`${base}/v1/images`, {
        method: 'POST',
        headers: { cookie },
        body: svgForm,
      }),
    )
    assert(svg.ok === false, 'svg rejected')

    const draft = {
      sport_id: 'basketball',
      category_id: 'senior',
      competition_id: 'harbor_open',
      club: {
        id: 'north_harbor_club',
        name: 'North Harbor Athletics Club (fictional)',
        country_id: 'it',
      },
      team: { id: 'north_harbor_foxes', name: 'North Harbor Foxes' },
      season: { id: 'harbor_2026', name: '2026' },
      players: [
        {
          id: 'p_new',
          name: 'River Quill',
          photo_asset_id: img.asset.id,
          photo: { attribution: 'Fixture', license: 'CC0-1.0' },
        },
      ],
      memberships: [{ player_id: 'p_new', number: 12, position_id: 'sg' }],
    }

    const preview = await readJson(
      await fetch(`${base}/v1/wizard/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ draft, handle: 'river_q' }),
      }),
    )
    assert(preview.ok === true, 'preview ok')
    assert(preview.preview.credit.handle === 'river_q', 'preview handle')
    assert(!JSON.stringify(preview).includes('example.test'), 'preview email leak')

    const submitBody = {
      draft,
      handle: 'river_q',
      profile_url: 'https://example.com/river',
      rights_confirmed: true,
      consent_confirmed: true,
      idempotency_key: 'check-key-00123456',
    }
    const submit1 = await readJson(
      await fetch(`${base}/v1/wizard/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(submitBody),
      }),
    )
    assert(submit1.ok === true && submit1.created === true, 'submit create')
    assert(submit1.submission.status === 'queued', 'status queued')

    const submit2 = await readJson(
      await fetch(`${base}/v1/wizard/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(submitBody),
      }),
    )
    assert(submit2.ok === true && submit2.created === false, 'submit idempotent')
    assert(submit2.submission.id === submit1.submission.id, 'same id')

    const status = await readJson(
      await fetch(`${base}/v1/submissions/${submit1.submission.id}`),
    )
    assert(status.submission.status === 'queued', 'status page queued')
    assert(
      ['queued', 'pr_opened', 'changes_requested', 'merged', 'rejected'].includes(
        status.submission.status,
      ),
      'status enum',
    )

    // Keep spike check fixture path for CI continuity.
    assert(readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8').includes('MIT'), 'license')
  } finally {
    await close()
  }

  console.log('COMMUNITY_CHECK_OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
