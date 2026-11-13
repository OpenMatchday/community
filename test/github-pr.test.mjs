import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { isAllowedRegistryPath, assertSafeBranchName, contributionBranchName } =
  await import(pathToFileURL(path.join(root, 'src', 'github', 'paths.ts')).href)
const {
  createAppJwt,
  createInstallationAccessToken,
  githubAppBotIdentity,
} = await import(pathToFileURL(path.join(root, 'src', 'github', 'auth.ts')).href)
const { buildContributionFiles, buildPullRequestBody } = await import(
  pathToFileURL(path.join(root, 'src', 'github', 'files.ts')).href
)
const { openContributionPullRequest } = await import(
  pathToFileURL(path.join(root, 'src', 'github', 'pr.ts')).href
)
const { createMemoryStore } = await import(
  pathToFileURL(path.join(root, 'src', 'store', 'memory.ts')).href
)
const { createApp } = await import(
  pathToFileURL(path.join(root, 'src', 'create-app.ts')).href
)

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const baseDraft = () => ({
  sport_id: 'basketball',
  category_id: 'senior',
  competition_id: 'harbor_open',
  club: { id: 'club_a', name: 'Club A', country_id: 'it' },
  team: { id: 'team_a', name: 'Team A' },
  season: { id: 'season_a', name: '2026' },
  players: [{ id: 'player_a', name: 'Ada' }],
  memberships: [{ player_id: 'player_a', number: 4 }],
})

test('registry path allowlist accepts packages only', () => {
  assert.equal(
    isAllowedRegistryPath('packages/contrib_abc/manifest.json'),
    true,
  )
  assert.equal(isAllowedRegistryPath('packages/contrib_abc/../../main'), false)
  assert.equal(isAllowedRegistryPath('.github/workflows/ci.yml'), false)
  assert.equal(isAllowedRegistryPath('README.md'), false)
  assert.equal(
    isAllowedRegistryPath(
      'packages/contrib_abc/photos/11111111-1111-1111-1111-111111111111.png',
    ),
    true,
  )
})

test('branch names refuse main', () => {
  const branch = contributionBranchName('11111111-1111-1111-1111-111111111111')
  assert.match(branch, /^community\/contrib-/)
  assert.doesNotThrow(() => assertSafeBranchName(branch))
  assert.throws(() => assertSafeBranchName('main'))
})

test('GitHub App JWT and installation token are short-lived and scoped', async () => {
  const jwt = await createAppJwt({
    clientId: 'Iv1.client',
    appId: '12345',
    privateKeyPem,
    installationId: '99',
  })
  assert.equal(jwt.split('.').length, 3)

  const calls = []
  const token = await createInstallationAccessToken({
    credentials: {
      clientId: 'Iv1.client',
      appId: '12345',
      privateKeyPem,
      installationId: '99',
    },
    owner: 'OpenMatchday',
    repo: 'teams',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            token: 'ghs_test_token',
            expires_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
            permissions: { contents: 'write', pull_requests: 'write' },
            repositories: [{ name: 'teams' }],
          }),
        json: async () => ({}),
      }
    },
  })
  assert.equal(token.token, 'ghs_test_token')
  assert.ok(Date.parse(token.expiresAt) - Date.now() < 2 * 60 * 60 * 1000)
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.repositories, ['teams'])
  assert.deepEqual(body.permissions, {
    contents: 'write',
    pull_requests: 'write',
  })
  assert.ok(calls[0].init.headers.Authorization.startsWith('Bearer '))
})

test('bot identity never uses Google email; PR body credits handle', () => {
  const bot = githubAppBotIdentity('12345', 'open-matchday-community')
  assert.equal(bot.name, 'open-matchday-community[bot]')
  assert.equal(
    bot.email,
    '12345+open-matchday-community[bot]@users.noreply.github.com',
  )
  assert.doesNotMatch(bot.email, /gmail|googlemail/i)

  const body = buildPullRequestBody({
    handle: 'harbor_fan',
    profileUrl: 'https://example.com/u',
    submissionId: 'sub-1',
    packageId: 'contrib_abc',
  })
  assert.match(body, /harbor_fan/)
  assert.doesNotMatch(body, /@gmail\.com|google_email/i)
})

test('buildContributionFiles stays on allowlisted paths', () => {
  const submissionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const built = buildContributionFiles({
    submissionId,
    handle: 'harbor_fan',
    profileUrl: null,
    draft: baseDraft(),
    images: [],
  })
  for (const file of built.files) {
    assert.equal(isAllowedRegistryPath(file.path), true)
  }
  assert.ok(built.files.some((f) => f.path.endsWith('manifest.json')))
})

test('openContributionPullRequest creates branch+PR only, never merge/main', async () => {
  const submissionId = randomUUID()
  const store = createMemoryStore()
  const contributor = await store.upsertContributor({
    googleSub: 'sub',
    emailSha256: 'abc',
  })
  const { submission } = await store.createSubmission({
    contributorId: contributor.id,
    idempotencyKey: 'idem-pr-test-123456',
    handle: 'harbor_fan',
    profileUrl: null,
    draftJson: baseDraft(),
    previewJson: { credit: { handle: 'harbor_fan' } },
  })

  const calls = []
  const fetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body })
    if (url.endsWith('/access_tokens')) {
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            token: 'ghs_test',
            expires_at: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
            permissions: { contents: 'write', pull_requests: 'write' },
            repositories: [{ name: 'teams' }],
          }),
        json: async () => ({}),
      }
    }
    if (url.includes('/git/ref/heads/main') && method === 'GET') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ object: { sha: 'baseaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }),
        json: async () => ({}),
      }
    }
    if (url.endsWith('/git/refs') && method === 'POST') {
      const body = JSON.parse(init.body)
      assert.ok(body.ref.startsWith('refs/heads/community/contrib-'))
      assert.notEqual(body.ref, 'refs/heads/main')
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ ref: body.ref }),
        json: async () => ({}),
      }
    }
    if (url.includes('/contents/') && method === 'PUT') {
      const body = JSON.parse(init.body)
      assert.notEqual(body.branch, 'main')
      assert.match(body.committer.email, /users\.noreply\.github\.com/)
      assert.doesNotMatch(body.committer.email, /gmail/)
      assert.doesNotMatch(JSON.stringify(body), /example\.test|google/)
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ content: { path: 'ok' } }),
        json: async () => ({}),
      }
    }
    if (url.endsWith('/pulls') && method === 'POST') {
      const body = JSON.parse(init.body)
      assert.match(body.head, /^community\/contrib-/)
      assert.equal(body.base, 'main')
      assert.match(body.body, /harbor_fan/)
      assert.equal(body.draft, false)
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            number: 42,
            html_url: 'https://github.com/OpenMatchday/teams/pull/42',
          }),
        json: async () => ({}),
      }
    }
    throw new Error(`unexpected fetch ${method} ${url}`)
  }

  const opened = await openContributionPullRequest({
    config: {
      githubAppConfigured: true,
      githubAppClientId: 'Iv1.client',
      githubAppId: '12345',
      githubAppPrivateKey: privateKeyPem,
      githubAppInstallationId: '99',
      githubAppSlug: 'open-matchday-community',
      githubOwner: 'OpenMatchday',
      githubRepo: 'teams',
      githubBaseBranch: 'main',
      githubApiBase: 'https://api.github.com',
    },
    submission: { ...submission, id: submissionId },
    images: [],
    fetchImpl,
  })

  assert.equal(opened.prNumber, 42)
  assert.equal(opened.prUrl, 'https://github.com/OpenMatchday/teams/pull/42')
  assert.ok(calls.every((c) => !c.url.includes('/merge')))
  assert.ok(calls.some((c) => c.url.endsWith('/pulls') && c.method === 'POST'))
  assert.ok(!calls.some((c) => c.method === 'PUT' && c.body?.includes('"branch":"main"')))
})

test('open-pr endpoint returns 503 without GitHub App secrets', async () => {
  const store = createMemoryStore()
  const app = createApp({
    store,
    config: {
      isProduction: false,
      authTestMode: true,
      sessionSecret: 'test-session-secret-om041',
      googleClientId: undefined,
      googleClientSecret: undefined,
      googleRedirectUri: 'http://127.0.0.1/cb',
      publicBaseUrl: 'http://127.0.0.1',
      websiteOrigins: ['http://127.0.0.1:4173'],
      databaseUrl: undefined,
      googleOidcConfigured: false,
      githubAppConfigured: false,
      githubAppClientId: undefined,
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      githubAppInstallationId: undefined,
      githubAppSlug: 'open-matchday-community',
      githubOwner: 'OpenMatchday',
      githubRepo: 'teams',
      githubBaseBranch: 'main',
      githubApiBase: 'https://api.github.com',
    },
  })
  const login = await app.request('/v1/auth/test-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: 'u1', email: 'u1@example.test' }),
  })
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  const contributor = await store.upsertContributor({
    googleSub: 'u1',
    emailSha256: 'x',
  })
  // login already created contributor; fetch session contributor via submit path
  const draft = baseDraft()
  const submit = await app.request('/v1/wizard/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      draft,
      handle: 'harbor_fan',
      rights_confirmed: true,
      consent_confirmed: true,
      idempotency_key: 'idem-openpr-503-12345',
    }),
  })
  const submitJson = await submit.json()
  assert.equal(submitJson.ok, true)
  const open = await app.request(
    `/v1/submissions/${submitJson.submission.id}/open-pr`,
    { method: 'POST', headers: { cookie } },
  )
  assert.equal(open.status, 503)
  const openJson = await open.json()
  assert.equal(openJson.error, 'github_app_not_configured')
  void contributor
})
