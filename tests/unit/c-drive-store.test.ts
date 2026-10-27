import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { DriveStore } from '../../server/src/integrations/google-drive/store'
import { readDriveConfig } from '../../server/src/integrations/google-drive/config'
import { rekeyDrive } from '../../server/src/integrations/google-drive/rekey'
import { Vault } from '../../server/src/credentials/vault'
import { DRIVE_CONFIG } from '../lib/fake-google-drive'
import { addCred, testCredCtx } from '../lib/credentials'
import { rekeyCredentials } from '../../server/src/credentials/rekey'
import { getRow, secretOf } from '../../server/src/credentials/store'
let e: ReturnType<typeof makeEnv>, s: DriveStore, i = 0
beforeEach(() => { e = makeEnv('drive-store-' + ++i); s = new DriveStore(e.db, path.join(e.fx.base, 'secrets/integrations/google-drive')) })
afterEach(() => e.db.close())
test('AAD binds ciphertext to both owner and connection; dedicated rekey keeps AI and pending flows readable', () => {
  const sealed = s.seal('alice', 'x', { accessToken: 'CANARY-access', refreshToken: 'CANARY-refresh' })
  const row = { id: 'x', user_id: 'alice', secret_enc: sealed.enc, key_version: sealed.keyVersion }
  expect(s.open<any>(row).accessToken).toBe('CANARY-access')
  expect(() => s.open({ ...row, user_id: 'bob' })).toThrow('needs_reconnect')
  expect(() => s.open({ ...row, id: 'y' })).toThrow('needs_reconnect')
  const now = new Date().toISOString()
  e.db.query("INSERT INTO drive_connections(id,user_id,config_key,account,scopes,secret_enc,key_version,status,expires_at,created_at,updated_at) VALUES('x','alice','k','{}','[]',?,?,'connected',?,?,?)").run(sealed.enc, sealed.keyVersion, now, now, now)
  e.db.query("INSERT INTO sessions(id,user_id,token_hash,client,created_at,last_seen_at,expires_at) VALUES('s','alice','hash','web',?,?,?)").run(now, now, now)
  const pending = s.seal('alice', 'flow', { verifier: 'CANARY-pkce-verifier' })
  e.db.query("INSERT INTO drive_oauth_flows(id,user_id,session_id,state_hash,config_key,state,secret_enc,key_version,expires_at,created_at) VALUES('flow','alice','s','hashed-state','k','pending',?,?,?,?)").run(pending.enc, pending.keyVersion, now, now)
  const ai = new Vault(path.join(e.fx.base, 'secrets')), aiSecret = ai.encrypt('ai', 'test', { key: 'AI-CANARY' })
  expect(rekeyDrive(s)).toBe(2)
  expect(s.open<any>(s.connection('alice')!).accessToken).toBe('CANARY-access')
  expect(ai.decrypt('ai', 'test', aiSecret.enc, aiSecret.keyVersion)).toEqual({ key: 'AI-CANARY' })
  expect(s.open<any>(s.flow('flow')!).verifier).toBe('CANARY-pkce-verifier')
  const { cc } = testCredCtx(e.db, path.join(e.fx.base, 'secrets'))
  const aiId = addCred(cc, 'anthropic-api-key', 'AI-CANARY-key')
  expect(rekeyCredentials(cc)).toBe(1)
  expect(secretOf(cc, getRow(e.db, aiId)!)).toEqual({ key: 'AI-CANARY-key' })
  expect(new DriveStore(e.db, s.secretsDir).open<any>(s.connection('alice')!).accessToken).toBe('CANARY-access')
  // Another live store notices the key version; it must not write new ciphertext under a retired key.
  const sibling = new DriveStore(e.db, s.secretsDir)
  rekeyDrive(s)
  expect(sibling.seal('alice', 'new', {}).keyVersion).toBe(3)
  e.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  expect(fs.readFileSync(path.join(e.fx.data, 'app.db')).toString('latin1')).not.toContain('CANARY')
})
test('unsafe key-directory symlinks are refused, not followed', () => {
  fs.mkdirSync(path.dirname(s.secretsDir), { recursive: true, mode: 0o700 })
  const target = path.join(e.fx.base, 'stolen'); fs.mkdirSync(target)
  fs.symlinkSync(target, s.secretsDir)
  expect(() => s.seal('alice', 'id', { token: 'CANARY' })).toThrow()
  expect(fs.readdirSync(target)).toEqual([])
})
test('client config is private, https callback only, outside team and no symlink', () => {
  const file = path.join(e.fx.base, 'client.json')
  fs.writeFileSync(file, JSON.stringify(DRIVE_CONFIG), { mode: 0o600 })
  expect(readDriveConfig(file, e.fx.team)).toEqual(DRIVE_CONFIG)
  fs.chmodSync(file, 0o644); expect(readDriveConfig(file, e.fx.team)).toBeNull()
  fs.chmodSync(file, 0o600)
  fs.symlinkSync(file, file + '.link'); expect(readDriveConfig(file + '.link', e.fx.team)).toBeNull()
  const team = path.join(e.fx.team, 'client.json'); fs.writeFileSync(team, JSON.stringify(DRIVE_CONFIG), { mode: 0o600 })
  expect(readDriveConfig(team, e.fx.team)).toBeNull()
  fs.writeFileSync(file, JSON.stringify({ ...DRIVE_CONFIG, redirectUri: 'http://example.test/api/integrations/google-drive/callback' }))
  expect(readDriveConfig(file, e.fx.team)).toBeNull()
})
