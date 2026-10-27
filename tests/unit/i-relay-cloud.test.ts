// The team server against a production-like relay (closed registration, operator API), control-plane SV-4 and SV-9:
// a hosted server waits for <data>/relay/registration.json and then connects with no proof of work; the file must name
// this server's key and this relay; a self-hosted server registers with a claim code from the connection screen (used
// once) and says registration_closed / bad_claim otherwise. The connection route keeps the code out of server.json.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { buildApp } from '../../server/src/app'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { relayClientTimers } from '../../server/src/relay-client'
import {
  CLAIM_FILE, REGISTRATION_FILE, RelayRegistrationError, ensureRegistered, getRegistration, loadOrCreateKey, readClaimCode, saveClaimCode,
} from '../../server/src/relay-client/registration'
import { systemTestHooks } from '../../server/src/routes/system'
import { OWNER_PW, harness, withOwner } from './a-lib'
import { F_WORK, opsCall, opsCreateBody, startRelay, teamUrl, until, writeOpsKeys, type InProcessRelay, type OpsKeySet } from '../lib/f-relay'

const PORT = 19289
let R: InProcessRelay
let K: OpsKeySet
let ops = ''
const cp = (m: string, p: string, b?: unknown) => opsCall(ops, 'cp', K.keys.cp!, m, p, b)
const quiet = { info() {}, warn() {} }

beforeAll(async () => {
  K = writeOpsKeys(path.join(F_WORK, `i-cloud-keys-${process.pid}.json`), [{ keyId: 'cp', scopes: ['teams:read', 'teams:write', 'claims:write', 'notice:write'] }])
  R = await startRelay(PORT, { RELAY_OPEN_REGISTRATION: '0', RELAY_PRIVATE_LISTEN: '127.0.0.1:0', RELAY_OPERATOR_KEYS_FILE: K.file })
  ops = `http://127.0.0.1:${R.relay.privatePort}`
  relayClientTimers.awaitOperatorMs = 150
})
afterAll(async () => { relayClientTimers.awaitOperatorMs = 30_000; await R.stop() })

function dataDir(name: string): string {
  const d = path.join(F_WORK, `i-cloud-${name}-${process.pid}`)
  fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(d, { recursive: true })
  return d
}
async function registrationFor(dir: string, name: string, ref: string) {
  const kp = loadOrCreateKey(dir)
  const pem = fs.readFileSync(path.join(dir, 'relay', 'team-key.pem'), 'utf8')
  const r = await cp('POST', '/ops/v1/teams', opsCreateBody(name, { privatePem: pem, publicKey: kp.publicKey }, ref))
  expect(r.status).toBe(201)
  const t = r.json as { teamId: string; address: string }
  return { relayApi: R.base, teamId: t.teamId, teamName: name, publicKey: kp.publicKey, address: t.address }
}
const writeReg = (dir: string, reg: unknown) => fs.writeFileSync(path.join(dir, 'relay', REGISTRATION_FILE), typeof reg === 'string' ? reg : JSON.stringify(reg), { mode: 0o600 })
async function codeOf(p: Promise<unknown>): Promise<string> { try { await p; return 'ok' } catch (e) { return e instanceof RelayRegistrationError ? e.code : String(e) } }

describe('ensureRegistered against a closed relay', () => {
  test('hosted: waits without the file; adopts it (no proof of work); the file wins over the DB row', async () => {
    const dir = dataDir('adopt')
    const db = openDb(path.join(dir, 'app.db'))
    try {
      const { key, publicKey } = loadOrCreateKey(dir)
      const base = { db, dataDir: dir, relayApi: R.base, name: '', key, publicKey, hosted: true, log: quiet }
      expect(await codeOf(ensureRegistered(base))).toBe('awaiting_operator')
      const reg = await registrationFor(dir, 'hosted-one', 'cp-team-a')
      writeReg(dir, reg)
      const got = await ensureRegistered(base)
      expect(got).toMatchObject({ teamId: reg.teamId, teamName: 'hosted-one', address: reg.address })
      expect(getRegistration(db, R.base)?.teamId).toBe(reg.teamId)
      // the control plane renamed the address and rewrote the file: the next start takes the new name
      writeReg(dir, { ...reg, teamName: 'hosted-two', address: reg.address.replace('hosted-one', 'hosted-two') })
      expect((await ensureRegistered(base)).teamName).toBe('hosted-two')
    } finally { db.close() }
  })
  test('a file for another key, another relay, or not JSON is not used', async () => {
    const dir = dataDir('bad-file')
    const db = openDb(path.join(dir, 'app.db'))
    try {
      const { key, publicKey } = loadOrCreateKey(dir)
      const reg = await registrationFor(dir, 'bad-file-team', 'cp-team-b')
      const base = { db, dataDir: dir, relayApi: R.base, name: '', key, publicKey, hosted: true, log: quiet }
      writeReg(dir, { ...reg, publicKey: 'MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=' })
      expect(await codeOf(ensureRegistered(base))).toBe('registration_key_mismatch')
      writeReg(dir, { ...reg, relayApi: 'https://relay.example.com' })
      expect(await codeOf(ensureRegistered(base))).toBe('registration_other_relay')
      writeReg(dir, '{ not json')
      expect(await codeOf(ensureRegistered(base))).toBe('registration_file_invalid')
      writeReg(dir, { ...reg, teamName: 'Bad Name' })
      expect(await codeOf(ensureRegistered(base))).toBe('registration_file_invalid')
      expect(getRegistration(db, R.base)).toBeNull()
    } finally { db.close() }
  })
  test('self-hosted: registration_closed without a code; a claim code registers once (origin addon); a wrong one is bad_claim', async () => {
    const dir = dataDir('claim')
    const db = openDb(path.join(dir, 'app.db'))
    try {
      const { key, publicKey } = loadOrCreateKey(dir)
      const base = { db, dataDir: dir, relayApi: R.base, name: 'dental-clinic', key, publicKey, log: quiet }
      expect(await codeOf(ensureRegistered(base))).toBe('registration_closed')
      saveClaimCode(dir, { relayApi: R.base, name: 'dental-clinic', code: 'AAAA-BBBB-CCCC-DDDD-EEEE' })
      expect(await codeOf(ensureRegistered(base))).toBe('bad_claim')
      const c = await cp('POST', '/ops/v1/claims', { name: 'dental-clinic', ttlSec: 86400, externalRef: 'addon-77' })
      saveClaimCode(dir, { relayApi: `${R.base}/`, name: 'dental-clinic', code: (c.json as { code: string }).code })
      const reg = await ensureRegistered(base)
      expect(reg.address).toBe(`http://dental-clinic.localhost:${PORT}`)
      expect(R.relay.registry.team(reg.teamId)).toMatchObject({ origin: 'addon', external_ref: 'addon-77' })
      expect(readClaimCode(dir)).toBeNull() // used once, then gone
      expect(fs.existsSync(path.join(dir, 'relay', 'recovery-code.txt'))).toBe(true)
    } finally { db.close() }
  })
})

describe('the whole server, hosted', () => {
  let ctx: AppContext
  afterAll(async () => { await ctx?.close() })
  test('not_registered/awaiting_operator until the file appears, then connected and reachable at its address', async () => {
    const dir = dataDir('server')
    const config = {
      mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
      teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
      engine: { authMode: 'local-login' }, relay: { url: R.ws, teamName: null }, update: { channel: 'stable', feedUrl: null },
      validateResponses: true, setupToken: 'hosted-setup-token-0123456789abcdef', deployment: 'hosted',
    } as unknown as AppConfig
    fs.mkdirSync(config.dataDir, { recursive: true })
    fs.mkdirSync(config.teamRoot, { recursive: true })
    ctx = createContext({ config, db: openDb(path.join(config.dataDir, 'app.db')), log: silentLogger })
    await buildApp(ctx)
    await until(() => ctx.services.relay?.status().detail === 'awaiting_operator', 3000, 'waiting for the operator')
    expect(ctx.services.relay!.status().state).toBe('not_registered')
    writeReg(config.dataDir, await registrationFor(config.dataDir, 'hosted-srv', 'cp-team-s'))
    await until(() => ctx.services.relay?.status().state === 'connected', 5000, 'connected')
    expect(ctx.services.relay!.status().address).toBe(`http://hosted-srv.localhost:${PORT}`)
    expect((await fetch(teamUrl(PORT, 'hosted-srv', '/api/health'))).status).toBe(200)
    // the relay knows it as a cloud team, online
    const id = getRegistration(ctx.db, R.base)!.teamId
    expect((await cp('GET', `/ops/v1/teams/${id}`)).json).toMatchObject({ online: true, origin: 'cloud', name: 'hosted-srv' })
  })
})

describe('connection screen: claim code (SV-9)', () => {
  test('saved next to the team key for the next start, never in server.json; bad codes are a validation error', async () => {
    const cfgDir = dataDir('route')
    const cfgFile = path.join(cfgDir, 'server.json')
    fs.writeFileSync(cfgFile, JSON.stringify({ listen: { port: 19765 } }))
    systemTestHooks.restart = () => {}
    const h = await harness(`cloud-claim-${process.pid}`, { configFile: cfgFile, relay: { url: null, teamName: null, officialAvailable: true } })
    try {
      const owner = await withOwner(h)
      const bad = await owner.try('PUT', '/api/admin/connection', { mode: 'relay', teamName: 'clinic', claimCode: 'no!', password: OWNER_PW })
      expect(bad.status).toBe(400)
      const ok = await owner.try('PUT', '/api/admin/connection', { mode: 'relay', teamName: 'clinic', claimCode: 'abcd-efgh-jkmn-pqrs-tuvw', password: OWNER_PW })
      expect(ok.status).toBe(200)
      const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
      expect(saved.relay).toMatchObject({ url: 'wss://relay.treesoop.com/connect', teamName: 'clinic' })
      expect(JSON.stringify(saved)).not.toMatch(/abcd/i)
      expect(readClaimCode(h.ctx.config.dataDir)).toEqual({ relayApi: 'https://relay.treesoop.com', name: 'clinic', code: 'abcd-efgh-jkmn-pqrs-tuvw' })
      expect(fs.statSync(path.join(h.ctx.config.dataDir, 'relay', CLAIM_FILE)).mode & 0o077).toBe(0)
    } finally {
      systemTestHooks.restart = null
      await h.close()
    }
  })
})
