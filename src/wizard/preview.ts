import type { WizardDraft } from './validate.js'

/** Exact public preview shape (AC-10.2). Never includes Google email or banned PII. */
export const buildPublicPreview = (draft: WizardDraft, meta: {
  handle: string
  profile_url?: string | null
}) => {
  const players = draft.players.map((player) => {
    const out: Record<string, unknown> = {
      id: player.id,
      name: player.name,
      is_minor: player.is_minor === true,
    }
    if (player.alias) out.alias = player.alias
    if (player.photo_asset_id && player.is_minor !== true) {
      out.photo = {
        asset_id: player.photo_asset_id,
        attribution: player.photo?.attribution ?? null,
        license: player.photo?.license ?? null,
        mime: player.photo?.mime ?? null,
      }
    } else if (player.photo && player.is_minor !== true) {
      out.photo = {
        path: player.photo.path ?? null,
        mime: player.photo.mime ?? null,
        attribution: player.photo.attribution ?? null,
        license: player.photo.license ?? null,
      }
    }
    return out
  })

  const memberships = draft.memberships.map((m, index) => ({
    id: m.id ?? `m_${index + 1}`,
    player_id: m.player_id,
    number: String(m.number),
    position_id: m.position_id ?? null,
  }))

  return {
    schema_version: '0.1.0',
    kind: 'registry_contribution_preview',
    credit: {
      handle: meta.handle,
      profile_url: meta.profile_url ?? null,
    },
    selection: {
      sport_id: draft.sport_id,
      category_id: draft.category_id,
      competition_id: draft.competition_id,
    },
    club: {
      id: draft.club.id,
      name: draft.club.name,
      country_id: draft.club.country_id,
      alias: draft.club.alias ?? null,
    },
    team: {
      id: draft.team.id,
      name: draft.team.name,
      alias: draft.team.alias ?? null,
    },
    season: {
      id: draft.season.id,
      name: draft.season.name,
      label: draft.season.label ?? null,
    },
    players,
    memberships,
  }
}

export const publicSubmissionView = (row: {
  id: string
  handle: string
  profileUrl: string | null
  status: string
  previewJson: unknown
  prUrl?: string | null
  prNumber?: number | null
  branchName?: string | null
  createdAt: string
  updatedAt: string
}) => ({
  id: row.id,
  handle: row.handle,
  profile_url: row.profileUrl,
  status: row.status,
  preview: row.previewJson,
  pr_url: row.prUrl ?? null,
  pr_number: row.prNumber ?? null,
  branch_name: row.branchName ?? null,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
})
