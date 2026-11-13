import type { WizardDraft } from '../wizard/validate.js'
import type { ImageAsset } from '../store/types.js'
import {
  assertAllowedRegistryPaths,
  contributionPackageId,
} from './paths.js'

export type ContributionFile = {
  path: string
  content: string | Uint8Array
  encoding: 'utf-8' | 'base64'
}

export const buildContributionFiles = (input: {
  submissionId: string
  handle: string
  profileUrl: string | null
  draft: WizardDraft
  images: ImageAsset[]
}): { packageId: string; files: ContributionFile[] } => {
  const packageId = contributionPackageId(input.submissionId)
  const imageById = new Map(input.images.map((img) => [img.id, img]))

  const players = input.draft.players.map((player) => {
    const row: Record<string, unknown> = {
      id: player.id,
      name: player.name,
      is_minor: player.is_minor === true,
    }
    if (player.alias) row.alias = player.alias
    if (player.is_minor === true) return row
    if (player.photo_asset_id) {
      const image = imageById.get(player.photo_asset_id)
      if (image) {
        row.photo = {
          path: `photos/${image.filename}`,
          mime: image.mime,
          attribution: player.photo?.attribution ?? 'Contributor upload',
          license: player.photo?.license ?? 'CC0-1.0',
        }
      }
    }
    return row
  })

  const memberships = input.draft.memberships.map((m, index) => ({
    id: m.id ?? `m_${index + 1}`,
    player_id: m.player_id,
    number: String(m.number),
    position_id: m.position_id ?? null,
  }))

  const registry = {
    schema_version: '0.1.0',
    sports: [{ id: input.draft.sport_id, name: input.draft.sport_id }],
    countries: [
      {
        id: input.draft.club.country_id,
        name: input.draft.club.country_id.toUpperCase(),
        iso3166_1_alpha2: input.draft.club.country_id.toUpperCase(),
      },
    ],
    competitions: [
      {
        id: input.draft.competition_id,
        name: input.draft.competition_id,
        sport_id: input.draft.sport_id,
        country_id: input.draft.club.country_id,
      },
    ],
    categories: [
      {
        id: input.draft.category_id,
        name: input.draft.category_id,
        sport_id: input.draft.sport_id,
      },
    ],
    clubs: [
      {
        id: input.draft.club.id,
        name: input.draft.club.name,
        country_id: input.draft.club.country_id,
        alias: input.draft.club.alias ?? null,
      },
    ],
    teams: [
      {
        id: input.draft.team.id,
        name: input.draft.team.name,
        club_id: input.draft.club.id,
        sport_id: input.draft.sport_id,
        category_id: input.draft.category_id,
        alias: input.draft.team.alias ?? null,
      },
    ],
    seasons: [
      {
        id: input.draft.season.id,
        name: input.draft.season.name,
        competition_id: input.draft.competition_id,
        label: input.draft.season.label ?? null,
      },
    ],
    squads: [
      {
        id: `squad_${input.draft.team.id}_${input.draft.season.id}`,
        team_id: input.draft.team.id,
        season_id: input.draft.season.id,
      },
    ],
    players,
    memberships: memberships.map((m) => ({
      ...m,
      squad_id: `squad_${input.draft.team.id}_${input.draft.season.id}`,
    })),
    credit: {
      handle: input.handle,
      profile_url: input.profileUrl,
    },
  }

  const manifest = {
    schema_version: '0.1.0',
    package_id: packageId,
    version: '0.1.0',
    display_name: `${input.draft.team.name} (community contribution)`,
    description: `Community contribution credited to handle ${input.handle}. Pending maintainer review.`,
    fiction: true,
    default_locale: 'en',
    contribution: {
      handle: input.handle,
      profile_url: input.profileUrl,
      submission_id: input.submissionId,
    },
  }

  const readme = [
    `# ${packageId}`,
    '',
    'Community registry contribution. Fiction marker is set until maintainers verify.',
    '',
    `Credited handle: ${input.handle}`,
    input.profileUrl ? `Profile: ${input.profileUrl}` : '',
    '',
    'Opened by the Open Matchday community GitHub App. Maintainers merge manually.',
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n')

  const files: ContributionFile[] = [
    {
      path: `packages/${packageId}/manifest.json`,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      encoding: 'utf-8',
    },
    {
      path: `packages/${packageId}/registry.json`,
      content: `${JSON.stringify(registry, null, 2)}\n`,
      encoding: 'utf-8',
    },
    {
      path: `packages/${packageId}/docs/README.md`,
      content: readme,
      encoding: 'utf-8',
    },
  ]

  for (const player of input.draft.players) {
    if (player.is_minor === true || !player.photo_asset_id) continue
    const image = imageById.get(player.photo_asset_id)
    if (!image) continue
    files.push({
      path: `packages/${packageId}/photos/${image.filename}`,
      content: image.bytes,
      encoding: 'base64',
    })
  }

  assertAllowedRegistryPaths(files.map((f) => f.path))
  return { packageId, files }
}

export const buildPullRequestBody = (input: {
  handle: string
  profileUrl: string | null
  submissionId: string
  packageId: string
}): string => {
  const lines = [
    '## Community registry contribution',
    '',
    `Credited handle: **${input.handle}**`,
  ]
  if (input.profileUrl) {
    lines.push(`Profile link: ${input.profileUrl}`)
  }
  lines.push(
    '',
    `Submission id: \`${input.submissionId}\``,
    `Package path: \`packages/${input.packageId}/\``,
    '',
    'Opened by the Open Matchday community GitHub App using a short-lived installation token.',
    'This PR does not auto-merge. Maintainers review and merge manually.',
    'Contributor Google email is never published.',
    '',
  )
  const body = lines.join('\n')
  if (/@gmail\.com|google_email|email_sha/i.test(body)) {
    throw new Error('pr_body_email_leak')
  }
  return body
}
