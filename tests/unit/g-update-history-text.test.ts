// Admin › System › Health "Updates": what the bootstrap's update history says in plain words (QA TC-167 F1/F2).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { resolveLayout } from '../../server/src/system/layout'
import { OpsService } from '../../server/src/system/ops'

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-update-text-')))
const base = path.join(ROOT, 'srv')
const app = path.join(base, 'app')
let ctx: AppContext

type Entry = { from: string | null; to: string; result: 'ok' | 'rolled_back' | 'failed'; detail: string | null }
const history = (...h: Entry[]) => fs.writeFileSync(path.join(app, 'state.json'), JSON.stringify({
  format: 1, current: '0.5.0-beta.1', previous: null, pending: null, pendingSince: null, attempts: 0,
  history: h.map((e) => ({ at: new Date().toISOString(), ...e })),
}))
const line = async (l: 'en' | 'ko' = 'en') => {
  const o = new OpsService(ctx, { layout: resolveLayout(ctx.config, { MYCEL_INSTALL_BASE: base, MYCEL_LABEL: 'mycel' }, 'linux'), platform: 'linux', engines: async () => [], launcherStatus: async () => null })
  return (await o.diagnostics(l)).checks.find((c) => c.id === 'update')!
}

beforeAll(() => {
  for (const d of ['run', 'root', 'config', 'data', 'team', 'secrets', 'status', 'app/versions/0.5.0-beta.1']) fs.mkdirSync(path.join(base, d), { recursive: true })
  fs.symlinkSync('versions/0.5.0-beta.1', path.join(app, 'current'))
  const cfg: AppConfig = {
    mode: 'prod', configFile: path.join(base, 'config', 'server.json'), listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
    teamRoot: path.join(base, 'team'), dataDir: path.join(base, 'data'), logDir: null, logLevel: 'error',
    engine: { authMode: 'managed', runDir: path.join(ROOT, 'r') }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
    validateResponses: false, setupToken: null,
  }
  ctx = createContext({ config: cfg, db: openDb(path.join(cfg.dataDir, 'app.db')), log: silentLogger })
})
afterAll(async () => { await ctx.close(); fs.rmSync(ROOT, { recursive: true, force: true }) })

const STOP = 'stopped: 0.5.0-beta.2 exited 2 times before it was healthy (last: exit status 1), and 0.5.0-beta.1 cannot read the database it already updated. Restore the database backup made before the update: /x/data/backups/pre-migrate-a.db (the newest data/backups/pre-migrate-*.db); everything recorded in the app since the update (messages, settings, the history of file changes) will be lost; the files in the team folder stay as they are. Or install a version that starts.'

describe('Health › Updates after the bootstrap stopped the server', () => {
  test('says it stopped and runs again now, without the bootstrap instructions or "went back to" the stopped version', async () => {
    history({ from: '0.5.0-beta.2', to: '0.5.0-beta.1', result: 'rolled_back', detail: 'exited 1 times before it was healthy' }, { from: '0.5.0-beta.2', to: '0.5.0-beta.2', result: 'rolled_back', detail: STOP })
    const c = await line()
    expect(c.status).toBe('ok')
    expect(c.detail).toContain('After the update to 0.5.0-beta.2, the server could not start, so it was stopped')
    expect(c.detail).toContain(`running again now on version ${ctx.version}`)
    expect(c.detail).toContain('changes made after the update are not there any more')
    expect(c.detail).not.toContain('went back to')
    expect(c.detail).not.toContain('stopped:')
    expect(c.detail).not.toContain('pre-migrate')
    expect((await line('ko')).detail).toContain('서버를 멈췄어요')
  })

  test('an ordinary roll-back still warns with its reason', async () => {
    history({ from: '0.5.0-beta.2', to: '0.5.0-beta.1', result: 'rolled_back', detail: 'exited 3 times before it was healthy' })
    const c = await line()
    expect(c.status).toBe('warn')
    expect(c.detail).toBe('The new version did not start properly, so the server went back to 0.5.0-beta.1: exited 3 times before it was healthy')
  })
})

describe('Health › Updates after an update that failed once and went forward', () => {
  test('shows the version and that it recovered', async () => {
    history({ from: '0.5.0-beta.2', to: '0.5.0-beta.1', result: 'rolled_back', detail: 'exited 1 times before it was healthy' },
      { from: '0.5.0-beta.1', to: '0.5.0-beta.2', result: 'ok', detail: 'started again after 0.5.0-beta.1 could not read the database this version had already updated' })
    const c = await line()
    expect(c.status).toBe('ok')
    expect(c.detail).toBe(`Version ${ctx.version}. The update did not start on the first try, but the server tried again and it works now. Nothing to do.`)
    expect((await line('ko')).detail).toContain('다시 시도해서')
  })

  test('started again by hand after a stop says that instead', async () => {
    history({ from: '0.5.0-beta.2', to: '0.5.0-beta.2', result: 'rolled_back', detail: STOP }, { from: '0.5.0-beta.1', to: '0.5.0-beta.2', result: 'ok', detail: 'started again after it was stopped' })
    expect((await line()).detail).toBe(`Version ${ctx.version}. The server had stopped after the update, but it was started again and works now. Nothing to do.`)
  })

  test('a plain update shows only the version', async () => {
    history({ from: '0.5.0-beta.1', to: '0.5.0-beta.2', result: 'ok', detail: null })
    expect((await line()).detail).toBe(`Version ${ctx.version}`)
  })
})
