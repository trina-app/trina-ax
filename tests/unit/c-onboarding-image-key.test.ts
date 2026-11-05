// The hosting service's Higgsfield credential for the welcome steps' brand photos (credentials/hosted-image.ts): it
// arrives with mycel-ctl hosted-image-key-set (admin.js hosted-image-key, hosted servers only) as { token, workspace }
// or { token: null }, and is kept like the hosting speech key and the trial AI key: encrypted with the credentials vault,
// in no response, audit row or log line (not even its last characters), encrypted again by credentials-rekey, dropped
// off a server that is not hosted, left out of the team's export and kept as it is now over a restore.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { HostedImageKeyInput, tenantCommandProblem, TENANT_COMMANDS } from '@mycel/shared/cloud-protocol'
import type { AppConfig } from '../../server/src/app-config'
import { getTeamSettings, HOSTED_IMAGE_KEY_SETTING, setSetting } from '../../server/src/admin/settings'
import { dropHostedImageKey, hostedImageKeySet, readHostedImageKey, rekeyHostedImageKey, writeHostedImageKey } from '../../server/src/credentials/hosted-image'
import { rekeyCredentials } from '../../server/src/credentials/rekey'
import { SPEECH_KEY_SETTING } from '../../server/src/credentials/speech-key'
import { Vault } from '../../server/src/credentials/vault'
import { keepServerSettings, SERVER_OWN_SETTINGS, withoutHostingKey } from '../../server/src/system/backup'
import { setHostedImageKey } from '../../server/src/system/cloud-tenant'
import { openDb } from '../../server/src/db'
import { testCredCtx } from '../lib/credentials'
import { makeEnv, WORK } from '../lib/env'

setDefaultTimeout(60_000)
const TOKEN = 'hf.IMAGE-CANARY.' + 'k'.repeat(48) + '~+/='
const TOKEN2 = 'hf.IMAGE-ROTATED.' + 'r'.repeat(48)
const WS = '7b0e5c1a-3d2f-4a6b-9c8d-1e2f3a4b5c6d'
const WS2 = '0f6c2b1e-6a4c-4e0e-9a51-2d1f6f3b7c10'
const secretParts = [TOKEN, 'IMAGE-CANARY', TOKEN.slice(-8), TOKEN2, 'IMAGE-ROTATED', TOKEN2.slice(-8)]

const env = makeEnv('c-onboarding-image-key')
const secrets = path.join(env.fx.data, 'secrets')
const t = testCredCtx(env.db, secrets)
const lines: string[] = []
const log = { info: (...a: unknown[]) => { lines.push(JSON.stringify(a)) }, warn: (...a: unknown[]) => { lines.push(JSON.stringify(a)) }, error: (...a: unknown[]) => { lines.push(JSON.stringify(a)) } }
const o = (deployment: 'hosted' | 'self') => ({ db: env.db, secretsDir: secrets, config: { ...t.cc.config, deployment } as unknown as AppConfig, log })
const raw = () => (env.db.query('SELECT value FROM settings WHERE key = ?').get(HOSTED_IMAGE_KEY_SETTING) as { value: string } | null)?.value ?? null
const holdsNoSecret = (s: string) => { for (const p of secretParts) expect(s).not.toContain(p) }

describe('the tenant command hosted-image-key-set (mycel-ctl → admin.js hosted-image-key)', () => {
  test('the gate: { token, workspace } or { token: null }, strict; never an argument', () => {
    expect(Object.keys(TENANT_COMMANDS)).toContain('hosted-image-key-set')
    const ok = { token: TOKEN, workspace: WS }
    expect(tenantCommandProblem('hosted-image-key-set', {}, ok)).toBeNull()
    expect(tenantCommandProblem('hosted-image-key-set', {}, { token: 'a'.repeat(16), workspace: WS.toUpperCase() })).toBeNull()
    expect(tenantCommandProblem('hosted-image-key-set', {}, { token: 'a'.repeat(4096), workspace: WS })).toBeNull()
    expect(tenantCommandProblem('hosted-image-key-set', {}, { token: null })).toBeNull()
    for (const bad of [
      { ...ok, token: 'a'.repeat(15) }, { ...ok, token: 'a'.repeat(4097) }, { ...ok, token: 'has space ' + 'a'.repeat(20) }, { ...ok, token: 'a'.repeat(20) + '\n' },
      { ...ok, token: 'a'.repeat(20) + '"' }, { ...ok, token: 7 }, { ...ok, workspace: 'acme' }, { ...ok, workspace: WS.slice(0, -1) }, { ...ok, workspace: WS + 'a' },
      { ...ok, workspace: '7b0e5c1a3d2f4a6b9c8d1e2f3a4b5c6d' }, { ...ok, workspace: 'g' + WS.slice(1) }, { ...ok, workspace: null },
      { token: TOKEN }, { workspace: WS }, { ...ok, extra: 1 }, { ...ok, model: 'z_image' }, { token: null, workspace: WS }, { key: TOKEN, workspace: WS }, {}, null, [],
    ]) expect(tenantCommandProblem('hosted-image-key-set', {}, bad), JSON.stringify(bad)).not.toBeNull()
    expect(tenantCommandProblem('hosted-image-key-set', { token: TOKEN }, ok)).not.toBeNull()
    expect(HostedImageKeyInput.safeParse(ok).success).toBe(true)
  })

  test('hosted: set, read back, rotated and taken away; the answer is { ok, set }; audited as set / removed without the token', () => {
    env.db.query("DELETE FROM audit_log WHERE action = 'onboarding.hosted_image_key'").run()
    expect(setHostedImageKey(o('hosted'), { token: TOKEN, workspace: WS })).toEqual({ ok: true, set: true })
    expect(readHostedImageKey(t.cc)).toEqual({ token: TOKEN, workspace: WS })
    expect(hostedImageKeySet(env.db)).toBe(true)
    expect(setHostedImageKey(o('hosted'), { token: TOKEN2, workspace: WS2 })).toEqual({ ok: true, set: true })
    expect(readHostedImageKey(t.cc)).toEqual({ token: TOKEN2, workspace: WS2 })
    expect(setHostedImageKey(o('hosted'), { token: null })).toEqual({ ok: true, set: false })
    expect(readHostedImageKey(t.cc)).toBeNull()
    expect(hostedImageKeySet(env.db)).toBe(false)
    expect(raw()).toBeNull()
    const rows = env.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'onboarding.hosted_image_key' ORDER BY rowid").all() as { actor_id: string | null; target: string | null; detail: string }[]
    expect(rows.map((r) => [r.actor_id, r.target, JSON.parse(r.detail)])).toEqual([[null, null, { key: 'set' }], [null, null, { key: 'set' }], [null, null, { key: 'removed' }]])
    holdsNoSecret(JSON.stringify(rows))
  })

  test('refused on a server that is not hosted, and for anything else; errors never hold the token; nothing is stored', () => {
    writeHostedImageKey(t.cc, null)
    expect(() => setHostedImageKey(o('self'), { token: TOKEN, workspace: WS })).toThrow('hosted servers only')
    for (const bad of [{}, { token: TOKEN }, { token: TOKEN, workspace: 'acme' }, { token: TOKEN, workspace: WS, extra: 1 }, { token: 'short', workspace: WS },
      { token: TOKEN + ' x', workspace: WS }, { token: null, workspace: WS }, { key: TOKEN, workspace: WS }, null, [], 7]) {
      let msg = ''
      try { setHostedImageKey(o('hosted'), bad) } catch (e) { msg = (e as Error).message }
      expect(msg).toContain('stdin must be')
      holdsNoSecret(msg)
    }
    expect(raw()).toBeNull()
  })
})

describe('kept like the hosting speech key', () => {
  test('encrypted at rest (token and workspace); a row that no longer decrypts reads as none', () => {
    expect(writeHostedImageKey(t.cc, { token: TOKEN, workspace: WS })).toBe(true)
    const v = raw()!
    holdsNoSecret(v)
    expect(v).not.toContain(WS)
    expect(Object.keys(JSON.parse(v)).sort()).toEqual(['enc', 'keyVersion', 'updatedAt'])
    // another credential's AAD does not open it: the id and kind are bound
    const s = JSON.parse(v)
    expect(() => t.cc.vault.decrypt('speech.hosted', 'openrouter-api-key', s.enc, s.keyVersion)).toThrow()
    setSetting(env.db, HOSTED_IMAGE_KEY_SETTING, { ...s, enc: Buffer.from('not the ciphertext of anything at all').toString('base64') })
    expect(hostedImageKeySet(env.db)).toBe(true)
    expect(readHostedImageKey(t.cc)).toBeNull()
    setSetting(env.db, HOSTED_IMAGE_KEY_SETTING, { enc: 7 })
    expect(hostedImageKeySet(env.db)).toBe(false)
    expect(readHostedImageKey(t.cc)).toBeNull()
  })

  test('never in the team settings (GET /api/admin/settings), an answer, an audit row or a log line', () => {
    lines.length = 0
    setHostedImageKey(o('hosted'), { token: TOKEN, workspace: WS })
    setHostedImageKey(o('hosted'), { token: TOKEN2, workspace: WS2 })
    const settings = getTeamSettings(env.db) as Record<string, unknown>
    expect(Object.keys(settings)).not.toContain(HOSTED_IMAGE_KEY_SETTING)
    const dump = JSON.stringify(settings) + JSON.stringify(env.db.query('SELECT key, value FROM settings').all())
      + JSON.stringify(env.db.query('SELECT action, target, detail FROM audit_log').all()) + lines.join('\n')
    holdsNoSecret(dump)
  })

  test('credentials-rekey encrypts it again; it still opens and the old key file goes', () => {
    writeHostedImageKey(t.cc, { token: TOKEN, workspace: WS })
    const before = JSON.parse(raw()!)
    const oldKey = t.cc.vault.keyPath(before.keyVersion)
    expect(fs.existsSync(oldKey)).toBe(true)
    rekeyCredentials(t.cc)
    const after = JSON.parse(raw()!)
    expect(after.keyVersion).toBeGreaterThan(before.keyVersion)
    expect(after.enc).not.toBe(before.enc)
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(readHostedImageKey(t.cc)).toEqual({ token: TOKEN, workspace: WS })
    expect(fs.existsSync(oldKey)).toBe(false)
  })

  test('rekey alone: nothing stored needs no key file; a row that does not decrypt keeps its key version', () => {
    const next = new Vault(secrets, t.cc.vault.version + 1)
    writeHostedImageKey(t.cc, null)
    expect(rekeyHostedImageKey(env.db, t.cc.vault, next).versions).toEqual([])
    setSetting(env.db, HOSTED_IMAGE_KEY_SETTING, { enc: Buffer.from('garbage garbage garbage garbage').toString('base64'), keyVersion: 1, updatedAt: new Date().toISOString() })
    const r = rekeyHostedImageKey(env.db, t.cc.vault, next)
    expect(r.versions).toEqual([1])
    r.write()
    expect(JSON.parse(raw()!).keyVersion).toBe(1)
    writeHostedImageKey(t.cc, { token: TOKEN, workspace: WS })
    const ok = rekeyHostedImageKey(env.db, t.cc.vault, next)
    expect(ok.versions).toEqual([next.version])
    ok.write()
    expect(readHostedImageKey({ db: env.db, vault: next })).toEqual({ token: TOKEN, workspace: WS })
    fs.rmSync(next.keyPath(next.version), { force: true })
  })

  test('a server that is not hosted drops it at start (main.ts)', () => {
    writeHostedImageKey(t.cc, { token: TOKEN, workspace: WS })
    expect(dropHostedImageKey(env.db)).toBe(true)
    expect(dropHostedImageKey(env.db)).toBe(false)
    expect(hostedImageKeySet(env.db)).toBe(false)
    const main = fs.readFileSync(path.resolve(import.meta.dir, '../../server/src/main.ts'), 'utf8')
    expect(main).toMatch(/!isHosted\(cfg\) && dropHostedImageKey\(db\)/)
  })

  test('the team\'s export leaves it out, not even in its free pages; the team\'s own key stays', () => {
    const dir = path.join(env.fx.data, 'image-copies')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'export.db')
    const marker = 'IMAGE-CIPHERTEXT-MARKER-' + 'x'.repeat(40)
    const d = openDb(file)
    try {
      setSetting(d, HOSTED_IMAGE_KEY_SETTING, { enc: marker, keyVersion: 1, updatedAt: '2026-11-05T00:00:00Z' })
      setSetting(d, SPEECH_KEY_SETTING, { enc: 'TEAM', keyVersion: 1, hint: 'abcd', updatedAt: '2026-11-05T00:00:00Z' })
    } finally { d.close() }
    withoutHostingKey(file)
    expect(fs.readFileSync(file).includes(marker)).toBe(false)
    const c = openDb(file)
    try {
      expect(c.query('SELECT key FROM settings WHERE key = ?').get(HOSTED_IMAGE_KEY_SETTING)).toBeNull()
      expect(c.query('SELECT key FROM settings WHERE key = ?').get(SPEECH_KEY_SETTING)).toEqual({ key: SPEECH_KEY_SETTING })
    } finally { c.close() }
  })

  test('a restore keeps the current credential, or none when there is none, whatever the backup holds', () => {
    expect(SERVER_OWN_SETTINGS).toContain(HOSTED_IMAGE_KEY_SETTING)
    const dir = path.join(env.fx.data, 'image-restore')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const put = (file: string, value: string | null) => {
      const d = openDb(file)
      try { if (value === null) d.query('DELETE FROM settings WHERE key = ?').run(HOSTED_IMAGE_KEY_SETTING); else setSetting(d, HOSTED_IMAGE_KEY_SETTING, { enc: value, keyVersion: 1, updatedAt: '2026-11-05T00:00:00Z' }) } finally { d.close() }
    }
    const get = (file: string) => {
      const d = openDb(file)
      try { return (d.query('SELECT value FROM settings WHERE key = ?').get(HOSTED_IMAGE_KEY_SETTING) as { value: string } | null)?.value ?? null } finally { d.close() }
    }
    const live = path.join(dir, 'live.db'), staged = path.join(dir, 'staged.db')
    put(live, 'NEW')
    put(staged, 'OLD')
    keepServerSettings(live, staged)
    expect(JSON.parse(get(staged)!).enc).toBe('NEW')
    // the current server has none (taken away since the backup): the restored copy brings none back
    put(live, null)
    put(staged, 'OLD')
    keepServerSettings(live, staged)
    expect(get(staged)).toBeNull()
  })
})

describe('admin.js hosted-image-key through the real command line', () => {
  const W = path.join(WORK, `c-onboarding-image-key-cli-${process.pid}`)
  const install = (name: string, extra: object) => {
    const base = path.join(W, name)
    fs.rmSync(base, { recursive: true, force: true })
    fs.mkdirSync(path.join(base, 'team'), { recursive: true })
    fs.mkdirSync(path.join(base, 'data'), { recursive: true })
    const cfgFile = path.join(base, 'server.json')
    fs.writeFileSync(cfgFile, JSON.stringify({ mode: 'dev', dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), ...extra }))
    openDb(path.join(base, 'data', 'app.db')).close()
    const run = (stdin: string) => {
      const p = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, '../../server/src/system/cli.ts'), 'hosted-image-key'], { stdin: Buffer.from(stdin), env: { ...process.env, MYCEL_CONFIG: cfgFile, MYCEL_MODE: 'dev' } })
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
    }
    return { base, run, db: () => openDb(path.join(base, 'data', 'app.db')) }
  }

  test('hosted: JSON { ok, set } out, the row encrypted; a server that is not hosted refuses; no output holds the token', () => {
    const h = install('hosted', { deployment: 'hosted' })
    const set = h.run(JSON.stringify({ token: TOKEN, workspace: WS }))
    expect(set.code).toBe(0)
    expect(JSON.parse(set.out)).toEqual({ ok: true, set: true })
    const d = h.db()
    try {
      const v = (d.query('SELECT value FROM settings WHERE key = ?').get(HOSTED_IMAGE_KEY_SETTING) as { value: string }).value
      holdsNoSecret(v)
      expect(JSON.parse(v).keyVersion).toBeGreaterThanOrEqual(1)
    } finally { d.close() }
    const bad = h.run(JSON.stringify({ token: TOKEN, workspace: 'acme' }))
    expect(bad.code).not.toBe(0)
    const off = h.run(JSON.stringify({ token: null }))
    expect(JSON.parse(off.out)).toEqual({ ok: true, set: false })
    const s = install('self', {})
    const refused = s.run(JSON.stringify({ token: TOKEN, workspace: WS }))
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain('hosted servers only')
    holdsNoSecret(set.out + set.err + bad.out + bad.err + off.out + off.err + refused.out + refused.err)
    const sd = s.db()
    try { expect(sd.query('SELECT 1 FROM settings WHERE key = ?').get(HOSTED_IMAGE_KEY_SETTING)).toBeNull() } finally { sd.close() }
    fs.rmSync(W, { recursive: true, force: true })
  })
})
