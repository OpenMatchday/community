import type { FetchLike } from './auth.js'
import type { ContributionFile } from './files.js'

export type GitHubApiConfig = {
  owner: string
  repo: string
  token: string
  apiBase?: string
  fetchImpl?: FetchLike
}

const api = async (
  config: GitHubApiConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; text: string }> => {
  const fetchImpl = config.fetchImpl ?? (fetch as FetchLike)
  const base = (config.apiBase ?? 'https://api.github.com').replace(/\/$/, '')
  const response = await fetchImpl(`${base}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

export const getDefaultBranchSha = async (
  config: GitHubApiConfig,
  branch: string,
): Promise<string> => {
  const result = await api(
    config,
    'GET',
    `/repos/${config.owner}/${config.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
  )
  if (result.status !== 200) {
    throw new Error(`get_ref_failed:${result.status}:${result.text.slice(0, 200)}`)
  }
  const sha = (result.json as { object?: { sha?: string } })?.object?.sha
  if (!sha) throw new Error('get_ref_missing_sha')
  return sha
}

export const createBranchRef = async (
  config: GitHubApiConfig,
  branch: string,
  sha: string,
): Promise<void> => {
  if (branch === 'main' || branch === 'master') {
    throw new Error('refuses_main_branch_create')
  }
  const result = await api(config, 'POST', `/repos/${config.owner}/${config.repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha,
  })
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(`create_ref_failed:${result.status}:${result.text.slice(0, 200)}`)
  }
}

export const putFileContents = async (
  config: GitHubApiConfig,
  input: {
    path: string
    branch: string
    message: string
    file: ContributionFile
    committer: { name: string; email: string }
  },
): Promise<void> => {
  if (input.branch === 'main' || input.branch === 'master') {
    throw new Error('refuses_main_contents_write')
  }
  const content =
    input.file.encoding === 'base64'
      ? Buffer.from(input.file.content).toString('base64')
      : Buffer.from(String(input.file.content), 'utf8').toString('base64')

  const result = await api(
    config,
    'PUT',
    `/repos/${config.owner}/${config.repo}/contents/${input.path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
    {
      message: input.message,
      content,
      branch: input.branch,
      committer: input.committer,
      author: input.committer,
    },
  )
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(`put_contents_failed:${input.path}:${result.status}:${result.text.slice(0, 200)}`)
  }
}

export const createPullRequest = async (
  config: GitHubApiConfig,
  input: {
    title: string
    body: string
    head: string
    base: string
  },
): Promise<{ number: number; htmlUrl: string }> => {
  if (input.head === 'main' || input.head === 'master') {
    throw new Error('refuses_pr_from_main')
  }
  const result = await api(config, 'POST', `/repos/${config.owner}/${config.repo}/pulls`, {
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
    maintainer_can_modify: true,
    draft: false,
  })
  if (result.status !== 201) {
    throw new Error(`create_pr_failed:${result.status}:${result.text.slice(0, 200)}`)
  }
  const json = result.json as { number?: number; html_url?: string }
  if (!json.number || !json.html_url) throw new Error('create_pr_malformed')
  return { number: json.number, htmlUrl: json.html_url }
}
