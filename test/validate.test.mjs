import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { validateDraft, validateSubmitMeta } = await import(
  pathToFileURL(path.join(root, 'src', 'wizard', 'validate.ts')).href
)
const { assertIdTokenClaims } = await import(
  pathToFileURL(path.join(root, 'src', 'auth', 'oidc.ts')).href
)
const { processImageUpload } = await import(
  pathToFileURL(path.join(root, 'src', 'images', 'pipeline.ts')).href
)
const { PNG } = await import(
  pathToFileURL(path.join(root, 'scripts', 'png-fixture.mjs')).href
)

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

test('validateDraft accepts a minimal public draft', () => {
  const result = validateDraft(baseDraft())
  assert.equal(result.ok, true)
})

test('validateDraft rejects privacy-banned keys', () => {
  const draft = baseDraft()
  draft.players[0].email = 'hidden@example.com'
  const result = validateDraft(draft)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('email')))
})

test('validateDraft rejects minor photos', () => {
  const draft = baseDraft()
  draft.players[0].is_minor = true
  draft.players[0].photo_asset_id = 'asset-1'
  const result = validateDraft(draft)
  assert.equal(result.ok, false)
})

test('validateSubmitMeta requires consent and handle', () => {
  const bad = validateSubmitMeta({
    handle: 'ab',
    rights_confirmed: false,
    consent_confirmed: false,
    idempotency_key: 'short',
  })
  assert.equal(bad.ok, false)
  const good = validateSubmitMeta({
    handle: 'harbor_fan',
    profile_url: 'https://example.com/u',
    rights_confirmed: true,
    consent_confirmed: true,
    idempotency_key: 'idem-key-123456',
  })
  assert.equal(good.ok, true)
})

test('assertIdTokenClaims checks iss aud exp', () => {
  const now = 1_700_000_000
  assert.throws(() =>
    assertIdTokenClaims(
      {
        sub: '1',
        iss: 'evil.example',
        aud: 'client',
        exp: now + 100,
      },
      'client',
      now,
    ),
  )
  assert.doesNotThrow(() =>
    assertIdTokenClaims(
      {
        sub: '1',
        iss: 'https://accounts.google.com',
        aud: 'client',
        exp: now + 100,
      },
      'client',
      now,
    ),
  )
})

test('processImageUpload re-encodes png and rejects svg', async () => {
  const ok = await processImageUpload({
    bytes: PNG.tiny(),
    declaredFilename: 'a.png',
    declaredMime: 'image/png',
  })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.image.mime, 'image/png')
    assert.match(ok.image.filename, /^[0-9a-f-]{36}\.png$/)
  }

  const svg = await processImageUpload({
    bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    declaredFilename: 'x.svg',
    declaredMime: 'image/svg+xml',
  })
  assert.equal(svg.ok, false)
})
