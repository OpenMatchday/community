import { randomUUID } from 'node:crypto'
import { neon } from '@neondatabase/serverless'
import type {
  Contributor,
  ImageAsset,
  SessionRow,
  Store,
  SubmissionRow,
} from './types.js'
import type { SubmissionStatus } from '../config.js'

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS om_contributors (
  id UUID PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS om_sessions (
  id UUID PRIMARY KEY,
  contributor_id UUID NOT NULL REFERENCES om_contributors(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS om_image_assets (
  id UUID PRIMARY KEY,
  contributor_id UUID NOT NULL REFERENCES om_contributors(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  filename TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  byte_length INT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS om_submissions (
  id UUID PRIMARY KEY,
  contributor_id UUID NOT NULL REFERENCES om_contributors(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  handle TEXT NOT NULL,
  profile_url TEXT,
  draft_json JSONB NOT NULL,
  preview_json JSONB NOT NULL,
  status TEXT NOT NULL,
  pr_url TEXT,
  pr_number INT,
  branch_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contributor_id, idempotency_key)
)`,
  `ALTER TABLE om_submissions ADD COLUMN IF NOT EXISTS pr_url TEXT`,
  `ALTER TABLE om_submissions ADD COLUMN IF NOT EXISTS pr_number INT`,
  `ALTER TABLE om_submissions ADD COLUMN IF NOT EXISTS branch_name TEXT`,
]

type Row = Record<string, unknown>

const asRows = (value: unknown): Row[] => {
  if (Array.isArray(value)) return value as Row[]
  return []
}

const mapContributor = (row: Row): Contributor => ({
  id: String(row.id),
  googleSub: String(row.google_sub),
  emailSha256: String(row.email_sha256),
  createdAt: new Date(String(row.created_at)).toISOString(),
})

const mapSession = (row: Row): SessionRow => ({
  id: String(row.id),
  contributorId: String(row.contributor_id),
  expiresAt: new Date(String(row.expires_at)).toISOString(),
  createdAt: new Date(String(row.created_at)).toISOString(),
})

const mapImage = (row: Row): ImageAsset => {
  const raw = row.bytes
  let bytes: Uint8Array
  if (raw instanceof Uint8Array) {
    bytes = raw
  } else if (Buffer.isBuffer(raw)) {
    bytes = new Uint8Array(raw)
  } else if (typeof raw === 'string') {
    bytes = Buffer.from(raw, 'base64')
  } else {
    bytes = new Uint8Array()
  }
  return {
    id: String(row.id),
    contributorId: String(row.contributor_id),
    mime: String(row.mime),
    filename: String(row.filename),
    bytes,
    byteLength: Number(row.byte_length),
    sha256: String(row.sha256),
    createdAt: new Date(String(row.created_at)).toISOString(),
  }
}

const mapSubmission = (row: Row): SubmissionRow => ({
  id: String(row.id),
  contributorId: String(row.contributor_id),
  idempotencyKey: String(row.idempotency_key),
  handle: String(row.handle),
  profileUrl: row.profile_url == null ? null : String(row.profile_url),
  draftJson: row.draft_json,
  previewJson: row.preview_json,
  status: String(row.status) as SubmissionStatus,
  prUrl: row.pr_url == null ? null : String(row.pr_url),
  prNumber: row.pr_number == null ? null : Number(row.pr_number),
  branchName: row.branch_name == null ? null : String(row.branch_name),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
})

export const createPostgresStore = (databaseUrl: string): Store => {
  const sql = neon(databaseUrl)
  let schemaReady = false

  const ensureSchema = async () => {
    if (schemaReady) return
    for (const statement of SCHEMA_STATEMENTS) {
      await sql.query(statement, [])
    }
    schemaReady = true
  }

  return {
    ensureSchema,

    upsertContributor: async ({ googleSub, emailSha256 }) => {
      await ensureSchema()
      const existing = asRows(await sql`
        SELECT id, google_sub, email_sha256, created_at
        FROM om_contributors WHERE google_sub = ${googleSub} LIMIT 1
      `)
      if (existing[0]) return mapContributor(existing[0])
      const id = randomUUID()
      const inserted = asRows(await sql`
        INSERT INTO om_contributors (id, google_sub, email_sha256)
        VALUES (${id}, ${googleSub}, ${emailSha256})
        RETURNING id, google_sub, email_sha256, created_at
      `)
      return mapContributor(inserted[0])
    },

    createSession: async ({ contributorId, expiresAt }) => {
      await ensureSchema()
      const id = randomUUID()
      const inserted = asRows(await sql`
        INSERT INTO om_sessions (id, contributor_id, expires_at)
        VALUES (${id}, ${contributorId}, ${expiresAt.toISOString()})
        RETURNING id, contributor_id, expires_at, created_at
      `)
      return mapSession(inserted[0])
    },

    getSession: async (sessionId) => {
      await ensureSchema()
      const rows = asRows(await sql`
        SELECT id, contributor_id, expires_at, created_at
        FROM om_sessions WHERE id = ${sessionId} LIMIT 1
      `)
      if (!rows[0]) return null
      return mapSession(rows[0])
    },

    deleteSession: async (sessionId) => {
      await ensureSchema()
      await sql`DELETE FROM om_sessions WHERE id = ${sessionId}`
    },

    getContributor: async (id) => {
      await ensureSchema()
      const rows = asRows(await sql`
        SELECT id, google_sub, email_sha256, created_at
        FROM om_contributors WHERE id = ${id} LIMIT 1
      `)
      if (!rows[0]) return null
      return mapContributor(rows[0])
    },

    saveImage: async ({ contributorId, mime, filename, bytes, sha256 }) => {
      await ensureSchema()
      const id = randomUUID()
      const buf = Buffer.from(bytes)
      const inserted = asRows(await sql`
        INSERT INTO om_image_assets
          (id, contributor_id, mime, filename, bytes, byte_length, sha256)
        VALUES
          (${id}, ${contributorId}, ${mime}, ${filename}, ${buf}, ${buf.byteLength}, ${sha256})
        RETURNING id, contributor_id, mime, filename, bytes, byte_length, sha256, created_at
      `)
      return mapImage(inserted[0])
    },

    getImage: async (id, contributorId) => {
      await ensureSchema()
      const rows = asRows(await sql`
        SELECT id, contributor_id, mime, filename, bytes, byte_length, sha256, created_at
        FROM om_image_assets
        WHERE id = ${id} AND contributor_id = ${contributorId}
        LIMIT 1
      `)
      if (!rows[0]) return null
      return mapImage(rows[0])
    },

    createSubmission: async (input) => {
      await ensureSchema()
      const existing = asRows(await sql`
        SELECT id, contributor_id, idempotency_key, handle, profile_url,
               draft_json, preview_json, status, pr_url, pr_number, branch_name,
               created_at, updated_at
        FROM om_submissions
        WHERE contributor_id = ${input.contributorId}
          AND idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `)
      if (existing[0]) {
        return {
          submission: mapSubmission(existing[0]),
          created: false,
        }
      }
      const id = randomUUID()
      const inserted = asRows(await sql`
        INSERT INTO om_submissions (
          id, contributor_id, idempotency_key, handle, profile_url,
          draft_json, preview_json, status
        ) VALUES (
          ${id},
          ${input.contributorId},
          ${input.idempotencyKey},
          ${input.handle},
          ${input.profileUrl},
          ${JSON.stringify(input.draftJson)},
          ${JSON.stringify(input.previewJson)},
          ${'queued'}
        )
        RETURNING id, contributor_id, idempotency_key, handle, profile_url,
                  draft_json, preview_json, status, pr_url, pr_number, branch_name,
                  created_at, updated_at
      `)
      return {
        submission: mapSubmission(inserted[0]),
        created: true,
      }
    },

    getSubmission: async (id) => {
      await ensureSchema()
      const rows = asRows(await sql`
        SELECT id, contributor_id, idempotency_key, handle, profile_url,
               draft_json, preview_json, status, pr_url, pr_number, branch_name,
               created_at, updated_at
        FROM om_submissions WHERE id = ${id} LIMIT 1
      `)
      if (!rows[0]) return null
      return mapSubmission(rows[0])
    },

    listSubmissionsForContributor: async (contributorId) => {
      await ensureSchema()
      const rows = asRows(await sql`
        SELECT id, contributor_id, idempotency_key, handle, profile_url,
               draft_json, preview_json, status, pr_url, pr_number, branch_name,
               created_at, updated_at
        FROM om_submissions
        WHERE contributor_id = ${contributorId}
        ORDER BY created_at DESC
      `)
      return rows.map((row) => mapSubmission(row))
    },

    markSubmissionPrOpened: async ({ id, prUrl, prNumber, branchName }) => {
      await ensureSchema()
      const rows = asRows(await sql`
        UPDATE om_submissions
        SET status = ${'pr_opened'},
            pr_url = ${prUrl},
            pr_number = ${prNumber},
            branch_name = ${branchName},
            updated_at = now()
        WHERE id = ${id}
        RETURNING id, contributor_id, idempotency_key, handle, profile_url,
                  draft_json, preview_json, status, pr_url, pr_number, branch_name,
                  created_at, updated_at
      `)
      if (!rows[0]) throw new Error('submission_not_found')
      return mapSubmission(rows[0])
    },
  }
}
