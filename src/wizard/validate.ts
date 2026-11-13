import {
  HANDLE_PATTERN,
  LOCAL_ID_PATTERN,
  PRIVACY_BANNED_KEYS,
} from '../config.js'
import { rejectRemoteImageUrl } from '../images/pipeline.js'

export type WizardPlayer = {
  id: string
  name: string
  alias?: string
  is_minor?: boolean
  photo_asset_id?: string
  photo?: {
    path?: string
    mime?: string
    attribution?: string
    license?: string
    url?: string
  }
}

export type WizardDraft = {
  sport_id: string
  category_id: string
  competition_id: string
  club: { id: string; name: string; country_id: string; alias?: string }
  team: { id: string; name: string; alias?: string }
  season: { id: string; name: string; label?: string }
  players: WizardPlayer[]
  memberships: Array<{
    id?: string
    player_id: string
    number: string | number
    position_id?: string
  }>
}

export type ValidationResult = {
  ok: boolean
  errors: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const collectKeys = (value: unknown, into: Set<string>) => {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into)
    return
  }
  if (!isObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    into.add(key)
    collectKeys(child, into)
  }
}

const requireLocalId = (value: unknown, label: string, errors: string[]) => {
  if (typeof value !== 'string' || !LOCAL_ID_PATTERN.test(value)) {
    errors.push(`${label} must be snake_case local id`)
  }
}

const requireNonEmpty = (value: unknown, label: string, errors: string[]) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${label} is required`)
  }
}

export const validateDraft = (raw: unknown): ValidationResult => {
  const errors: string[] = []
  if (!isObject(raw)) {
    return { ok: false, errors: ['draft must be an object'] }
  }

  const banned = new Set<string>()
  collectKeys(raw, banned)
  for (const key of PRIVACY_BANNED_KEYS) {
    if (banned.has(key)) {
      errors.push(`privacy-banned field ${key}`)
    }
  }

  requireLocalId(raw.sport_id, 'sport_id', errors)
  requireLocalId(raw.category_id, 'category_id', errors)
  requireLocalId(raw.competition_id, 'competition_id', errors)

  if (!isObject(raw.club)) {
    errors.push('club is required')
  } else {
    requireLocalId(raw.club.id, 'club.id', errors)
    requireNonEmpty(raw.club.name, 'club.name', errors)
    requireLocalId(raw.club.country_id, 'club.country_id', errors)
  }

  if (!isObject(raw.team)) {
    errors.push('team is required')
  } else {
    requireLocalId(raw.team.id, 'team.id', errors)
    requireNonEmpty(raw.team.name, 'team.name', errors)
  }

  if (!isObject(raw.season)) {
    errors.push('season is required')
  } else {
    requireLocalId(raw.season.id, 'season.id', errors)
    requireNonEmpty(raw.season.name, 'season.name', errors)
  }

  if (!Array.isArray(raw.players) || raw.players.length === 0) {
    errors.push('players must be a non-empty array')
  } else {
    const playerIds = new Set<string>()
    for (const [i, player] of raw.players.entries()) {
      if (!isObject(player)) {
        errors.push(`players[${i}] must be an object`)
        continue
      }
      requireLocalId(player.id, `players[${i}].id`, errors)
      requireNonEmpty(player.name, `players[${i}].name`, errors)
      if (typeof player.id === 'string') {
        if (playerIds.has(player.id)) {
          errors.push(`duplicate player id ${player.id}`)
        }
        playerIds.add(player.id)
      }
      const isMinor = player.is_minor === true
      if (isMinor && (player.photo_asset_id || player.photo)) {
        errors.push(`players[${i}]: minors default to no photo (AC-9.3)`)
      }
      if (player.photo && isObject(player.photo)) {
        const remote = rejectRemoteImageUrl(player.photo.url)
        if (remote) errors.push(`players[${i}].photo: ${remote}`)
        if (player.photo.path && String(player.photo.path).toLowerCase().endsWith('.svg')) {
          errors.push(`players[${i}].photo: SVG rejected`)
        }
        if (player.photo.mime === 'image/svg+xml') {
          errors.push(`players[${i}].photo: SVG MIME rejected`)
        }
        if (player.photo_asset_id == null) {
          if (!player.photo.attribution || !player.photo.license) {
            errors.push(
              `players[${i}].photo requires attribution and license when present`,
            )
          }
        }
      }
      if (player.photo_asset_id != null && typeof player.photo_asset_id !== 'string') {
        errors.push(`players[${i}].photo_asset_id must be a string`)
      }
    }
  }

  if (!Array.isArray(raw.memberships)) {
    errors.push('memberships must be an array')
  } else {
    const playerIds = new Set(
      Array.isArray(raw.players)
        ? raw.players
            .filter(isObject)
            .map((p) => p.id)
            .filter((id): id is string => typeof id === 'string')
        : [],
    )
    for (const [i, membership] of raw.memberships.entries()) {
      if (!isObject(membership)) {
        errors.push(`memberships[${i}] must be an object`)
        continue
      }
      if (typeof membership.player_id !== 'string' || !playerIds.has(membership.player_id)) {
        errors.push(`memberships[${i}].player_id must reference a player`)
      }
      if (
        membership.number === undefined ||
        membership.number === null ||
        String(membership.number).trim() === ''
      ) {
        errors.push(`memberships[${i}].number is required`)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

export const validateSubmitMeta = (input: {
  handle: unknown
  profile_url?: unknown
  rights_confirmed: unknown
  consent_confirmed: unknown
  idempotency_key: unknown
}): ValidationResult => {
  const errors: string[] = []
  if (typeof input.handle !== 'string' || !HANDLE_PATTERN.test(input.handle)) {
    errors.push('handle must be 3-32 chars starting with a letter')
  }
  if (input.profile_url != null && input.profile_url !== '') {
    if (typeof input.profile_url !== 'string') {
      errors.push('profile_url must be a string')
    } else {
      try {
        const url = new URL(input.profile_url)
        if (url.protocol !== 'https:') {
          errors.push('profile_url must be https')
        }
      } catch {
        errors.push('profile_url must be a valid URL')
      }
    }
  }
  if (input.rights_confirmed !== true) {
    errors.push('rights_confirmed must be true')
  }
  if (input.consent_confirmed !== true) {
    errors.push('consent_confirmed must be true')
  }
  if (
    typeof input.idempotency_key !== 'string' ||
    input.idempotency_key.length < 8 ||
    input.idempotency_key.length > 128
  ) {
    errors.push('idempotency_key must be 8-128 characters')
  }
  return { ok: errors.length === 0, errors }
}
