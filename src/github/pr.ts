import type { AppConfig } from '../config.js'
import type { ImageAsset, SubmissionRow, Store } from '../store/types.js'
import type { WizardDraft } from '../wizard/validate.js'
import {
  createInstallationAccessToken,
  githubAppBotIdentity,
  type FetchLike,
  type GitHubAppCredentials,
} from './auth.js'
import {
  createBranchRef,
  createPullRequest,
  getDefaultBranchSha,
  putFileContents,
} from './client.js'
import { buildContributionFiles, buildPullRequestBody } from './files.js'
import { assertSafeBranchName, contributionBranchName } from './paths.js'

export type OpenPrResult = {
  branch: string
  packageId: string
  prNumber: number
  prUrl: string
  tokenExpiresAt: string
  paths: string[]
}

const requireCredentials = (config: AppConfig): GitHubAppCredentials => {
  if (!config.githubAppConfigured) {
    throw new Error('github_app_not_configured')
  }
  return {
    clientId: config.githubAppClientId!,
    appId: config.githubAppId!,
    privateKeyPem: config.githubAppPrivateKey!,
    installationId: config.githubAppInstallationId!,
  }
}

export const openContributionPullRequest = async (input: {
  config: AppConfig
  submission: SubmissionRow
  images: ImageAsset[]
  fetchImpl?: FetchLike
}): Promise<OpenPrResult> => {
  const credentials = requireCredentials(input.config)
  const draft = input.submission.draftJson as WizardDraft
  const branch = contributionBranchName(input.submission.id)
  assertSafeBranchName(branch)

  const built = buildContributionFiles({
    submissionId: input.submission.id,
    handle: input.submission.handle,
    profileUrl: input.submission.profileUrl,
    draft,
    images: input.images,
  })

  const installation = await createInstallationAccessToken({
    credentials,
    owner: input.config.githubOwner,
    repo: input.config.githubRepo,
    fetchImpl: input.fetchImpl,
    apiBase: input.config.githubApiBase,
  })

  const api = {
    owner: input.config.githubOwner,
    repo: input.config.githubRepo,
    token: installation.token,
    apiBase: input.config.githubApiBase,
    fetchImpl: input.fetchImpl,
  }

  const baseSha = await getDefaultBranchSha(api, input.config.githubBaseBranch)
  await createBranchRef(api, branch, baseSha)

  const committer = githubAppBotIdentity(
    credentials.appId,
    input.config.githubAppSlug,
  )
  // Never attribute commits to the Google identity or a fabricated personal email.
  if (/gmail\.com|google/i.test(committer.email)) {
    throw new Error('bot_email_invalid')
  }

  for (const file of built.files) {
    await putFileContents(api, {
      path: file.path,
      branch,
      message: `feat(teams): add ${built.packageId} contribution files`,
      file,
      committer,
    })
  }

  const body = buildPullRequestBody({
    handle: input.submission.handle,
    profileUrl: input.submission.profileUrl,
    submissionId: input.submission.id,
    packageId: built.packageId,
  })

  const pr = await createPullRequest(api, {
    title: `Community contribution: ${input.submission.handle} (${built.packageId})`,
    body,
    head: branch,
    base: input.config.githubBaseBranch,
  })

  return {
    branch,
    packageId: built.packageId,
    prNumber: pr.number,
    prUrl: pr.htmlUrl,
    tokenExpiresAt: installation.expiresAt,
    paths: built.files.map((f) => f.path),
  }
}

export const collectSubmissionImages = async (
  store: Store,
  submission: SubmissionRow,
): Promise<ImageAsset[]> => {
  const draft = submission.draftJson as WizardDraft
  const images: ImageAsset[] = []
  for (const player of draft.players ?? []) {
    if (!player.photo_asset_id) continue
    const image = await store.getImage(player.photo_asset_id, submission.contributorId)
    if (image) images.push(image)
  }
  return images
}

export const processQueuedSubmission = async (input: {
  config: AppConfig
  store: Store
  submissionId: string
  fetchImpl?: FetchLike
}): Promise<{ submission: SubmissionRow; opened: OpenPrResult | null }> => {
  const submission = await input.store.getSubmission(input.submissionId)
  if (!submission) throw new Error('submission_not_found')
  if (submission.status === 'pr_opened' && submission.prUrl) {
    return {
      submission,
      opened: {
        branch: submission.branchName ?? '',
        packageId: '',
        prNumber: submission.prNumber ?? 0,
        prUrl: submission.prUrl,
        tokenExpiresAt: '',
        paths: [],
      },
    }
  }
  if (submission.status !== 'queued') {
    throw new Error(`submission_not_queued:${submission.status}`)
  }
  if (!input.config.githubAppConfigured) {
    return { submission, opened: null }
  }

  const images = await collectSubmissionImages(input.store, submission)
  const opened = await openContributionPullRequest({
    config: input.config,
    submission,
    images,
    fetchImpl: input.fetchImpl,
  })
  const updated = await input.store.markSubmissionPrOpened({
    id: submission.id,
    prUrl: opened.prUrl,
    prNumber: opened.prNumber,
    branchName: opened.branch,
  })
  return { submission: updated, opened }
}
