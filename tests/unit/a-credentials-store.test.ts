// Where the AI connections' secrets live (docs/DECISIONS.md "AI 연결" D6, security T6 / T16, S-9): the database holds
// only AES-256-GCM ciphertext bound to its row (AAD id + kind); the key is a private regular file of the server
// account; a planted link or a readable file is refused; another key (a restore elsewhere) makes the connection
// "needs reconnect" and tells the admins once; the sealing key is a private file too.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { addCred, testCredCtx } from '../lib/credentials'
import { getRow, secretOf, toCredential } from '../../server/src/credentials/store'
import { createKeyFile, keyFileName, openWithKey, readKeyFile, sealWithKey, Vault, VaultError } from '../../server/src/credentials/vault'
import { Sealer, SEALING_KEY_FILE } from '../../server/src/credentials/seal'
import { sealSecret } from '../../web/src/lib/seal'
import { rekeyCredentials } from '../../server/src/credentials/rekey'

const env = makeEnv('a-cred-store')
const dir = path.join(env.fx.data, 'secrets-store')
const t = testCredCtx(env.db, dir)
const TOKEN = 'sk-ant-oat01-' + 'S'.repeat(50)

describe('vault (S-9)', () => {
  test('the database file has no plaintext token; the key file is 0600 base64 of 32 bytes', () => {
    const id = addCred(t.cc, 'anthropic-oauth', TOKEN)
    env.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const bytes = fs.readFileSync(path.join(env.fx.data, 'app.db')).toString('latin1')
    expect(bytes).not.toContain(TOKEN)
    expect(bytes).not.toContain(TOKEN.slice(13, 40))
    const st = fs.statSync(path.join(dir, 'credentials.key'))
    expect(st.mode & 0o777).toBe(0o600)
    expect(Buffer.from(fs.readFileSync(path.join(dir, 'credentials.key'), 'utf8').trim(), 'base64').length).toBe(32)
    t.cc.cache.clear()
    expect(secretOf(t.cc, getRow(env.db, id)! as never)).toEqual({ token: TOKEN })
  })
  test('a ciphertext moved onto another row does not decrypt (AAD = id + kind)', () => {
    const a = addCred(t.cc, 'anthropic-api-key', 'sk-ant-api03-' + 'A'.repeat(40))
    const b = addCred(t.cc, 'anthropic-api-key', 'sk-ant-api03-' + 'B'.repeat(40))
    const encA = getRow(env.db, a)!.secret_enc
    env.db.query('UPDATE engine_credentials SET secret_enc = ?, updated_at = ? WHERE id = ?').run(encA, new Date().toISOString(), b)
    t.cc.cache.clear(); t.notices.length = 0
    expect(secretOf(t.cc, getRow(env.db, b)! as never)).toBeNull()
    expect(getRow(env.db, b)).toMatchObject({ status: 'needs_reconnect', status_code: 'decrypt_failed' })
    expect(t.notices.map((x) => x.n.code)).toEqual(['credential_needs_reconnect'])
    expect((env.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'credential.decrypt_failed' AND target = ?").get(b) as { n: number }).n).toBe(1)
    expect(toCredential(t.cc, getRow(env.db, b)!, 'en').state).toBe('needs_reconnect')
    // the right row still opens
    expect(secretOf(t.cc, getRow(env.db, a)! as never)).toEqual({ key: 'sk-ant-api03-' + 'A'.repeat(40) })
  })
  test('another key (restored on another server): needs reconnect, the server keeps running', () => {
    const d2 = path.join(env.fx.data, 'secrets-other')
    const other = testCredCtx(env.db, d2)
    const id = addCred(t.cc, 'anthropic-api-key', 'sk-ant-api03-' + 'C'.repeat(40))
    expect(secretOf(other.cc, getRow(env.db, id)! as never)).toBeNull()
    expect(getRow(env.db, id)!.status).toBe('needs_reconnect')
  })
  test('a link, a readable file or a wrong size in place of the key is refused (never used, never overwritten)', () => {
    const d = path.join(env.fx.data, 'secrets-bad')
    fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    const f = path.join(d, keyFileName(1))
    const real = path.join(d, 'elsewhere'); createKeyFile(real)
    fs.symlinkSync(real, f)
    expect(() => readKeyFile(f)).toThrow(VaultError)
    expect(() => new Vault(d).encrypt('x', 'anthropic-api-key', { key: 'k' })).toThrow(VaultError)
    expect(fs.lstatSync(f).isSymbolicLink()).toBe(true) // not replaced
    fs.rmSync(f); fs.writeFileSync(f, Buffer.alloc(32).toString('base64') + '\n', { mode: 0o644 })
    fs.chmodSync(f, 0o644)
    expect(() => readKeyFile(f)).toThrow(/readable/)
    fs.chmodSync(f, 0o600); fs.writeFileSync(f, 'short\n')
    expect(() => readKeyFile(f)).toThrow(/32-byte/)
    expect(new Vault(d).check().state).toBe('unsafe')
    expect(new Vault(path.join(d, 'none')).check().state).toBe('missing')
  })
  test('ciphertext changed in the database: refused (GCM tag)', () => {
    const k = Buffer.alloc(32, 7)
    const enc = sealWithKey(k, 'id1', 'anthropic-api-key', { key: 'v' })
    const raw = Buffer.from(enc, 'base64'); raw[20]! ^= 1
    expect(() => openWithKey(k, 'id1', 'anthropic-api-key', raw.toString('base64'))).toThrow(VaultError)
    expect(openWithKey(k, 'id1', 'anthropic-api-key', enc)).toEqual({ key: 'v' })
    expect(() => openWithKey(k, 'id1', 'openai-api-key', enc)).toThrow(VaultError)
  })
  test('credentials-rekey: every row under a new key version, the old key file gone, secrets the same', () => {
    const d = path.join(env.fx.data, 'secrets-rekey')
    const r = testCredCtx(env.db, d)
    const id = addCred(r.cc, 'anthropic-oauth', 'sk-ant-oat01-' + 'R'.repeat(40))
    env.db.query('DELETE FROM engine_credentials WHERE id != ?').run(id)
    const n = rekeyCredentials(r.cc)
    expect(n).toBe(1)
    expect(getRow(env.db, id)!.key_version).toBe(2)
    expect(fs.existsSync(path.join(d, 'credentials.key'))).toBe(false)
    expect(fs.existsSync(path.join(d, 'credentials.key.2'))).toBe(true)
    const fresh = testCredCtx(env.db, d)
    expect(secretOf(fresh.cc, getRow(env.db, id)! as never)).toEqual({ token: 'sk-ant-oat01-' + 'R'.repeat(40) })
  })
})

describe('sealing key', () => {
  test('a private JWK file (0600) made once; the browser seal opens here; a link in its place is refused', async () => {
    const d = path.join(env.fx.data, 'secrets-seal')
    const s = new Sealer(d)
    const pub = await s.publicKey()
    expect((fs.statSync(path.join(d, SEALING_KEY_FILE)).mode & 0o777)).toBe(0o600)
    expect(await new Sealer(d).publicKey()).toEqual(pub) // the same key on the next start
    expect(await s.unseal(await sealSecret(pub, 'hello-secret', 'credential.create'), 'credential.create')).toBe('hello-secret')
    const d2 = path.join(env.fx.data, 'secrets-seal-link')
    fs.mkdirSync(d2, { recursive: true, mode: 0o700 })
    fs.symlinkSync(path.join(d, SEALING_KEY_FILE), path.join(d2, SEALING_KEY_FILE))
    await expect(new Sealer(d2).publicKey()).rejects.toThrow()
  })
})
