const requiredInProd = (name: string): string | undefined => {
  const value = process.env[name]?.trim()
  if (value) return value
  return undefined
}

export const SUBMISSION_STATUSES = [
  'queued',
  'pr_opened',
  'changes_requested',
  'merged',
  'rejected',
] as const

export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number]

export const IMAGE_MIME_ALLOWLIST = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const

export type ImageMime = (typeof IMAGE_MIME_ALLOWLIST)[number]

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

export const PRIVACY_BANNED_KEYS = [
  'date_of_birth',
  'dob',
  'birth_date',
  'birthday',
  'birthdate',
  'email',
  'phone',
  'phone_number',
  'mobile',
  'address',
  'street_address',
  'postal_code',
  'contact',
  'contacts',
  'guardian_email',
  'guardian_phone',
  'parent_email',
  'parent_phone',
  'national_id',
  'ssn',
  'consent_evidence',
  'consent_evidence_path',
  'consent_file',
] as const

export const LOCAL_ID_PATTERN = /^[a-z][a-z0-9_]*$/
export const HANDLE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{2,31}$/

export const GOOGLE_DISCOVERY_URL =
  'https://accounts.google.com/.well-known/openid-configuration'

export const GOOGLE_ISSUERS = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
])

export const loadConfig = () => {
  const isProduction = process.env.VERCEL_ENV === 'production'
  const authTestMode =
    process.env.OM_AUTH_TEST_MODE === '1' && !isProduction
  const sessionSecret =
    requiredInProd('SESSION_SECRET') ??
    requiredInProd('OM_SPIKE_SECRET') ??
    (authTestMode ? 'om-auth-test-session-secret' : undefined)
  const googleClientId = requiredInProd('GOOGLE_CLIENT_ID')
  const googleClientSecret = requiredInProd('GOOGLE_CLIENT_SECRET')
  const publicBaseUrl =
    requiredInProd('COMMUNITY_PUBLIC_URL') ??
    'https://open-matchday-community.vercel.app'
  const googleRedirectUri =
    requiredInProd('GOOGLE_REDIRECT_URI') ??
    `${publicBaseUrl.replace(/\/$/, '')}/v1/auth/google/callback`
  const websiteOrigins = (
    process.env.WEBSITE_ORIGINS ??
    'https://openmatchday.github.io,http://127.0.0.1:4173,http://localhost:4173'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    isProduction,
    authTestMode,
    sessionSecret,
    googleClientId,
    googleClientSecret,
    googleRedirectUri,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ''),
    websiteOrigins,
    databaseUrl: requiredInProd('DATABASE_URL'),
    googleOidcConfigured: Boolean(googleClientId && googleClientSecret),
  }
}

export type AppConfig = ReturnType<typeof loadConfig>
