// Security review (multi-team-relay, round 1), the whole chain: the real server app behind a relay that runs the
// production client IP setting (CF-Connecting-IP, Cloudflare ranges trusted). Before the fix a visitor who reached the
// relay's origin directly put a new CF-Connecting-IP on every sign-in attempt; the team server took each one as the
// real client IP, so the per-IP sign-in limit (tab 4 "로그인 시도는 IP·계정별 횟수 제한") never triggered and the audit
// log recorded the invented addresses. Now the relay ignores that header from a peer that is not Cloudflare.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { buildApp } from '../../server/src/app'
import type { AppConfig } from '../../server/src/app-config'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { F_WORK, startRelay, teamUrl, until, type InProcessRelay } from '../lib/f-relay'

const PORT = 19184
let R: InProcessRelay
let ctx: AppContext

beforeAll(async () => {
  R = await startRelay(PORT, { RELAY_CLIENT_IP_HEADER: 'cf-connecting-ip' })
  const dir = path.join(F_WORK, 'app-client-ip')
  fs.rmSync(dir, { recursive: true, force: true })
  const config: AppConfig = {
    mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
    teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
    engine: { authMode: 'local-login' }, relay: { url: R.ws, teamName: 'sprayteam' }, update: { channel: 'stable', feedUrl: null },
    validateResponses: true, setupToken: null,
  }
  fs.mkdirSync(config.dataDir, { recursive: true })
  ctx = createContext({ config, db: openDb(path.join(config.dataDir, 'app.db')), log: silentLogger })
  await buildApp(ctx)
  await until(() => ctx.services.relay?.status().state === 'connected', 10_000, 'relay connected')
})
afterAll(async () => {
  await ctx?.close()
  await R?.stop()
})

test('rotating CF-Connecting-IP from a direct peer does not dodge the per-IP sign-in limit or forge the audited IP', async () => {
  const login = (i: number) => fetch(teamUrl(PORT, 'sprayteam', '/api/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1', 'cf-connecting-ip': `10.9.0.${i + 1}`, 'x-forwarded-for': '198.51.100.77' },
    body: JSON.stringify({ username: `spray${i}`, password: 'wrong-guess' }),
  })
  const statuses: number[] = []
  for (let i = 0; i < DEFAULT_LIMITS.perIp + 5; i++) statuses.push((await login(i)).status)
  expect(statuses.slice(0, DEFAULT_LIMITS.perIp).every((s) => s !== 429)).toBe(true)
  expect(statuses.slice(DEFAULT_LIMITS.perIp)).toEqual(Array(5).fill(429))
  const ips = new Set((ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.login_failed'").all() as { detail: string }[]).map((r) => JSON.parse(r.detail).ip))
  expect([...ips]).toEqual(['127.0.0.1'])
}, 30_000)
