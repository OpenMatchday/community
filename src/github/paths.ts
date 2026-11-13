import { LOCAL_ID_PATTERN } from '../config.js'

/** Allowed registry write paths under OpenMatchday/teams (AC-10.6). */
const ALLOWED_PATH_PATTERNS: RegExp[] = [
  /^packages\/[a-z][a-z0-9_]*\/manifest\.json$/,
  /^packages\/[a-z][a-z0-9_]*\/registry\.json$/,
  /^packages\/[a-z][a-z0-9_]*\/integrity\.json$/,
  /^packages\/[a-z][a-z0-9_]*\/docs\/[A-Za-z0-9._-]+$/,
  /^packages\/[a-z][a-z0-9_]*\/photos\/[0-9a-f-]{36}\.(jpe?g|png|webp)$/,
]

const FORBIDDEN_SEGMENTS = new Set(['..', '.', ''])

export const isAllowedRegistryPath = (rawPath: string): boolean => {
  if (typeof rawPath !== 'string') return false
  if (rawPath.includes('\\') || rawPath.startsWith('/') || rawPath.includes('\0')) {
    return false
  }
  const parts = rawPath.split('/')
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part))) return false
  if (parts[0] !== 'packages') return false
  if (parts.length >= 2 && !LOCAL_ID_PATTERN.test(parts[1])) return false
  return ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(rawPath))
}

export const assertAllowedRegistryPaths = (paths: string[]) => {
  const rejected = paths.filter((p) => !isAllowedRegistryPath(p))
  if (rejected.length > 0) {
    throw new Error(`registry_path_rejected:${rejected.join(',')}`)
  }
}

export const contributionBranchName = (submissionId: string): string => {
  const compact = submissionId.replace(/-/g, '').toLowerCase().slice(0, 16)
  return `community/contrib-${compact}`
}

export const contributionPackageId = (submissionId: string): string => {
  const compact = submissionId.replace(/-/g, '').toLowerCase().slice(0, 16)
  return `contrib_${compact}`
}

export const FORBIDDEN_REF_NAMES = new Set(['main', 'master', 'HEAD'])

export const assertSafeBranchName = (branch: string) => {
  if (!branch.startsWith('community/contrib-')) {
    throw new Error('branch_must_be_community_contrib')
  }
  if (FORBIDDEN_REF_NAMES.has(branch) || branch.includes('..')) {
    throw new Error('branch_forbidden')
  }
}
