import path from 'node:path'
import { openDb } from '../../server/src/db'
import { defaultConfig, type ServerConfig } from '../../server/src/config'
import { FileService, TurnFiles, type ToolCtx } from '../../server/src/files/service'
import { makeFixture, seed, type Fixture } from './fixtures'

export const WORK = path.resolve(import.meta.dir, '..', '.work')

export function makeEnv(name: string, over: Partial<ServerConfig> = {}) {
  const fx: Fixture = makeFixture(path.join(WORK, name))
  const cfg = defaultConfig({ teamRoot: fx.team, dataDir: fx.data, runDir: path.join(fx.base, 'run'), ...over })
  const db = openDb(path.join(fx.data, 'app.db'))
  seed(db)
  const files = new FileService(db, cfg)
  const ctx = (user: string, turnId: string | null = null): ToolCtx => ({ user: files.principal(user), turnId, files: new TurnFiles() })
  return { fx, cfg, db, files, ctx }
}
