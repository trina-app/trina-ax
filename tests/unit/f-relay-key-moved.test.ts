// QA TC-350: when the relay moves the team address to another key (an operator's key rotation, or the recovery code used
// on another server), this server's connections are cut ('key rotated') and every retry is refused ('signature does not
// match the registered key'). It used to record offline / auth_failed and retry, telling nobody. Now the owners and
// admins get one Inbox notice per change (relay event key_moved): not one per retry, not again after a restart while
// it is still refused, and again after a connection in between.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ControlClose, generateTeamKey, keyRotationString, loadPrivateKey, signB64 } from '@mycel/shared/relay-protocol'
import { buildApp } from '../../server/src/app'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { notificationsOf } from '../../server/src/notifications/service'
import { ROUTE_MODULES } from '../../server/src/routes'
import { F_WORK, startRelay, until, type InProcessRelay } from '../lib/f-relay'

setDefaultTimeout(90_000)
const PORT = 19186
let R: InProcessRelay
let config: AppConfig

const start = async () => {
  const ctx = createContext({ config, db: openDb(path.join(config.dataDir, 'app.db')), log: silentLogger })
  await buildApp(ctx, ROUTE_MODULES)
  return ctx
}
const moved = (ctx: AppContext, userId: string) => notificationsOf(ctx).list(userId, {}).items.filter((n) => n.code === 'relay.address_moved')
/** handshakes the relay refused (its private reject(), counted) */
let refused = 0
const events = (ctx: AppContext, kind: string) => (ctx.db.query('SELECT COUNT(*) AS n FROM relay_events WHERE kind = ?').get(kind) as { n: number }).n

beforeAll(async () => {
  R = await startRelay(PORT)
  const relay = R.relay as unknown as { reject: (...a: unknown[]) => void }
  const reject = relay.reject.bind(relay)
  relay.reject = (...a: unknown[]) => { refused++; reject(...a) }
  const dir = path.join(F_WORK, 'key-moved')
  fs.rmSync(dir, { recursive: true, force: true })
  config = {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
    teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
    engine: { authMode: 'local-login' }, relay: { url: R.ws, teamName: 'keyteam' }, update: { channel: 'stable', feedUrl: null },
    validateResponses: true, setupToken: null,
  } as AppConfig
  fs.mkdirSync(config.dataDir, { recursive: true })
  const db = openDb(path.join(config.dataDir, 'app.db'))
  db.query(`INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner'), ('adam', 'adam', 'Adam', 'admin'),
    ('mina', 'mina', 'Mina', 'member')`).run()
  db.close()
})
afterAll(async () => { await R?.stop() })

test('the address moved to another key: one notice to each owner and admin across retries and a restart, none to members', async () => {
  let ctx = await start()
  try {
    await until(() => ctx.services.relay?.status().state === 'connected', 10_000, 'connected')
    expect(moved(ctx, 'olga')).toEqual([])
    // the operator moves the address to another key (ops API PUT /teams/<id>/key does exactly this)
    const team = R.relay.registry.teamByName('keyteam')!
    const other = generateTeamKey()
    R.relay.registry.rotateKey(team.id, other.publicKey, signB64(loadPrivateKey(other.privatePem), keyRotationString(team.id, other.publicKey)))
    R.relay.disconnectTeam(team.id, ControlClose.AUTH_FAILED, 'key rotated')
    await until(() => events(ctx, 'key_moved') > 0, 10_000, 'key_moved recorded')
    // the client keeps retrying and is refused each time: still one event, one notice each
    const r0 = refused
    await until(() => refused >= r0 + 3, 20_000, 'several refused retries')
    expect(ctx.services.relay!.status()).toMatchObject({ state: 'offline', detail: 'auth_failed' })
    expect(events(ctx, 'key_moved')).toBe(1)
    for (const who of ['olga', 'adam']) {
      const n = moved(ctx, who)
      expect(n).toHaveLength(1)
      expect(n[0]).toMatchObject({ code: 'relay.address_moved', readAt: null, link: null, outcome: null })
    }
    expect(moved(ctx, 'mina')).toEqual([])
    await ctx.close()

    // a restart while it is still refused: nothing new
    ctx = await start()
    const r1 = refused
    await until(() => refused >= r1 + 2, 20_000, 'refused after the restart')
    expect(events(ctx, 'key_moved')).toBe(1)
    expect(moved(ctx, 'olga')).toHaveLength(1)
    await ctx.close()

    // a connection in between (as when the address came back) arms it again: the next move is told again
    const db = openDb(path.join(config.dataDir, 'app.db'))
    db.query("INSERT INTO relay_events (id, at, kind, detail) VALUES ('01900000-0000-7000-8000-000000000001', ?, 'connected', NULL)").run(new Date().toISOString())
    db.close()
    ctx = await start()
    await until(() => events(ctx, 'key_moved') === 2, 20_000, 'second key_moved')
    expect(moved(ctx, 'olga')).toHaveLength(2)
    expect(moved(ctx, 'adam')).toHaveLength(2)
    expect(moved(ctx, 'mina')).toEqual([])
  } finally {
    await ctx.close()
  }
})
