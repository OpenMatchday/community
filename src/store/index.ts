import type { AppConfig } from '../config.js'
import { createMemoryStore } from './memory.js'
import { createPostgresStore } from './postgres.js'
import type { Store } from './types.js'

let cached: Store | null = null

export const getStore = (config: AppConfig): Store => {
  if (cached) return cached
  cached = config.databaseUrl
    ? createPostgresStore(config.databaseUrl)
    : createMemoryStore()
  return cached
}

export const resetStoreForTests = () => {
  cached = null
}

export type { Store }
