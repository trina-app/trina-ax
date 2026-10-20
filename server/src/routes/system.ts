// Route module "system" — owner: component G (docs/WORKPLAN.md).
// Implements: SYSTEM (health, diagnostics, update, backups, restore, export, connection).
// Contract: shared/src/api/system.ts. Health is implemented by the foundation (the dev server, CI smoke test and
// the menubar app need it from day one); G implements the rest.
import { API, type Health } from '@mycel/shared/api'
import { SCHEMA_READER_LEVEL, schemaInfo } from '../db'
import type { RouteModule } from './module'

export const systemRoutes: RouteModule = {
  name: 'system',
  owner: 'G',
  register(kit, ctx) {
    kit.handle(API.health, (): Health => {
      let dbOk = true
      let applied = 0
      try { applied = schemaInfo(ctx.db).maxVersion } catch { dbOk = false }
      return {
        ok: dbOk,
        version: ctx.version,
        schema: { applied, readerLevel: SCHEMA_READER_LEVEL },
        uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
        time: new Date().toISOString(),
      }
    })
  },
}
