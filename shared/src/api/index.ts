// The whole HTTP API in one registry. Server route modules implement entries by key; clients call them by key.
// Adding an endpoint: put it in the group file of its owner (or a new file) and add the group here.
import { ADMIN } from './admin'
import { ARTIFACTS } from './artifacts'
import { AUTH } from './auth'
import { BROWSER } from './browser'
import { CHATS } from './chats'
import { FILES } from './files'
import { JOBS } from './jobs'
import { MEMORIES } from './memories'
import { SKILLS } from './skills'
import { SYSTEM } from './system'
import type { Endpoint } from './endpoint'

export const API = { ...AUTH, ...CHATS, ...MEMORIES, ...SKILLS, ...FILES, ...ARTIFACTS, ...JOBS, ...BROWSER, ...ADMIN, ...SYSTEM } as const
export type Api = typeof API
export type ApiName = keyof Api

export const API_GROUPS = { AUTH, CHATS, MEMORIES, SKILLS, FILES, ARTIFACTS, JOBS, BROWSER, ADMIN, SYSTEM } as const

/** All endpoints with their registry key. */
export function listEndpoints(): { name: ApiName; ep: Endpoint }[] {
  return (Object.keys(API) as ApiName[]).map((name) => ({ name, ep: API[name] as Endpoint }))
}

export * from '../ids'
export * from './common'
export * from './endpoint'
export * from './entities'
export * from './errors'
export * from './auth'
export * from './chats'
export * from './memories'
export * from './skills'
export * from './files'
export * from './artifacts'
export * from './jobs'
export * from './browser'
export * from './admin'
export * from './system'
export * from './ws'
export * from './client'
