// Every route module, registered in this order (web last: its catch-all GET serves the app shell).
// Owners never edit this file: each owns its module file (docs/WORKPLAN.md).
import { adminRoutes } from './admin'
import { artifactsRoutes } from './artifacts'
import { authRoutes } from './auth'
import { browserRoutes } from './browser'
import { chatsRoutes } from './chats'
import { filesRoutes } from './files'
import { jobsRoutes } from './jobs'
import { memoriesRoutes } from './memories'
import type { RouteModule } from './module'
import { officeUpdateRoutes } from './office-update'
import { relayRoutes } from './relay'
import { systemRoutes } from './system'
import { webRoutes } from './web'
import { wsRoutes } from './ws'

export type { RouteModule } from './module'

export const ROUTE_MODULES: readonly RouteModule[] = [
  systemRoutes, // G
  officeUpdateRoutes, // G (office mode automatic updates)
  authRoutes, // A
  adminRoutes, // A
  chatsRoutes, // B
  memoriesRoutes, // B
  wsRoutes, // B
  browserRoutes, // B
  filesRoutes, // C
  artifactsRoutes, // C
  jobsRoutes, // C
  relayRoutes, // F
  webRoutes, // D (catch-all, keep last)
]
