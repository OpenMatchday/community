import type { SubmissionStatus } from '../config.js'

export type Contributor = {
  id: string
  googleSub: string
  emailSha256: string
  createdAt: string
}

export type SessionRow = {
  id: string
  contributorId: string
  expiresAt: string
  createdAt: string
}

export type ImageAsset = {
  id: string
  contributorId: string
  mime: string
  filename: string
  bytes: Uint8Array
  byteLength: number
  sha256: string
  createdAt: string
}

export type SubmissionRow = {
  id: string
  contributorId: string
  idempotencyKey: string
  handle: string
  profileUrl: string | null
  draftJson: unknown
  previewJson: unknown
  status: SubmissionStatus
  prUrl: string | null
  prNumber: number | null
  branchName: string | null
  createdAt: string
  updatedAt: string
}

export type Store = {
  ensureSchema: () => Promise<void>
  upsertContributor: (input: {
    googleSub: string
    emailSha256: string
  }) => Promise<Contributor>
  createSession: (input: {
    contributorId: string
    expiresAt: Date
  }) => Promise<SessionRow>
  getSession: (sessionId: string) => Promise<SessionRow | null>
  deleteSession: (sessionId: string) => Promise<void>
  getContributor: (id: string) => Promise<Contributor | null>
  saveImage: (input: {
    contributorId: string
    mime: string
    filename: string
    bytes: Uint8Array
    sha256: string
  }) => Promise<ImageAsset>
  getImage: (id: string, contributorId: string) => Promise<ImageAsset | null>
  createSubmission: (input: {
    contributorId: string
    idempotencyKey: string
    handle: string
    profileUrl: string | null
    draftJson: unknown
    previewJson: unknown
  }) => Promise<{ submission: SubmissionRow; created: boolean }>
  getSubmission: (id: string) => Promise<SubmissionRow | null>
  listSubmissionsForContributor: (
    contributorId: string,
  ) => Promise<SubmissionRow[]>
  markSubmissionPrOpened: (input: {
    id: string
    prUrl: string
    prNumber: number
    branchName: string
  }) => Promise<SubmissionRow>
}
