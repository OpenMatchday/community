import { randomUUID } from 'node:crypto'
import type {
  Contributor,
  ImageAsset,
  SessionRow,
  Store,
  SubmissionRow,
} from './types.js'

const nowIso = () => new Date().toISOString()

export const createMemoryStore = (): Store => {
  const contributors = new Map<string, Contributor>()
  const contributorsBySub = new Map<string, string>()
  const sessions = new Map<string, SessionRow>()
  const images = new Map<string, ImageAsset>()
  const submissions = new Map<string, SubmissionRow>()
  const submissionByIdem = new Map<string, string>()

  return {
    ensureSchema: async () => undefined,

    upsertContributor: async ({ googleSub, emailSha256 }) => {
      const existingId = contributorsBySub.get(googleSub)
      if (existingId) {
        const existing = contributors.get(existingId)
        if (!existing) throw new Error('contributor index corrupt')
        return existing
      }
      const row: Contributor = {
        id: randomUUID(),
        googleSub,
        emailSha256,
        createdAt: nowIso(),
      }
      contributors.set(row.id, row)
      contributorsBySub.set(googleSub, row.id)
      return row
    },

    createSession: async ({ contributorId, expiresAt }) => {
      const row: SessionRow = {
        id: randomUUID(),
        contributorId,
        expiresAt: expiresAt.toISOString(),
        createdAt: nowIso(),
      }
      sessions.set(row.id, row)
      return row
    },

    getSession: async (sessionId) => sessions.get(sessionId) ?? null,

    deleteSession: async (sessionId) => {
      sessions.delete(sessionId)
    },

    getContributor: async (id) => contributors.get(id) ?? null,

    saveImage: async ({ contributorId, mime, filename, bytes, sha256 }) => {
      const row: ImageAsset = {
        id: randomUUID(),
        contributorId,
        mime,
        filename,
        bytes,
        byteLength: bytes.byteLength,
        sha256,
        createdAt: nowIso(),
      }
      images.set(row.id, row)
      return row
    },

    getImage: async (id, contributorId) => {
      const row = images.get(id)
      if (!row || row.contributorId !== contributorId) return null
      return row
    },

    createSubmission: async (input) => {
      const key = `${input.contributorId}:${input.idempotencyKey}`
      const existingId = submissionByIdem.get(key)
      if (existingId) {
        const existing = submissions.get(existingId)
        if (!existing) throw new Error('submission index corrupt')
        return { submission: existing, created: false }
      }
      const row: SubmissionRow = {
        id: randomUUID(),
        contributorId: input.contributorId,
        idempotencyKey: input.idempotencyKey,
        handle: input.handle,
        profileUrl: input.profileUrl,
        draftJson: input.draftJson,
        previewJson: input.previewJson,
        status: 'queued',
        prUrl: null,
        prNumber: null,
        branchName: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      submissions.set(row.id, row)
      submissionByIdem.set(key, row.id)
      return { submission: row, created: true }
    },

    getSubmission: async (id) => submissions.get(id) ?? null,

    listSubmissionsForContributor: async (contributorId) =>
      [...submissions.values()]
        .filter((s) => s.contributorId === contributorId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),

    markSubmissionPrOpened: async ({ id, prUrl, prNumber, branchName }) => {
      const existing = submissions.get(id)
      if (!existing) throw new Error('submission_not_found')
      const row: SubmissionRow = {
        ...existing,
        status: 'pr_opened',
        prUrl,
        prNumber,
        branchName,
        updatedAt: nowIso(),
      }
      submissions.set(id, row)
      return row
    },
  }
}
