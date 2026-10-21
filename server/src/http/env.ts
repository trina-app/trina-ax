// Hono environment shared by every route module.
import type { Context } from 'hono'
import type { Locale } from '@mycel/shared/api'
import type { Logger } from '../log'
import type { AuthInfo, RequestInfo } from '../services'

export interface AppBindings {
  /** set by whoever calls app.fetch: Bun.serve (socket peer), the relay client (OPEN-frame ip), tests */
  ip?: string | null
  via?: RequestInfo['via']
  /** direct: the listening port the request came in on (Bun.serve's server.port) */
  port?: number
  /** Bun server, for WebSocket upgrades (hono/bun) */
  server?: unknown
  /** direct: the request came through the office public address (http/tunnel.ts) */
  tunnel?: boolean
  /** the request Bun.serve handed over, when app.fetch got a rewritten copy (tunnel: https URL); Bun upgrades only
   * its own request object to a WebSocket */
  upgradeReq?: Request
}

export interface AppVariables {
  requestId: string
  log: Logger
  info: RequestInfo
  auth: AuthInfo | null
  locale: Locale
}

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables }
export type AppContextC = Context<AppEnv>
