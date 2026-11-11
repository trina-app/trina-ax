// A plugin's trust is checked again under the trust settings in effect now, not only at install (docs/PLUGINS.md): a
// package taken in while unsigned packages or test keys were allowed, or signed with a key later dropped from the trust
// list, stops being usable once that setting is gone. At start it is turned off and its skills leave the team folder;
// enable and rollback refuse it; Admin › Plugins shows it as unsupported ('untrusted'). Placing skills never follows a
// link planted in the team folder.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PluginManager, pluginsOf } from '../../server/src/plugins/manager'
import { trustRoot } from '../../server/src/plugins/trust'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { catalogDir, newKey, prodTrust, skillPack } from '../lib/plugins'

const key = newKey()
const ID = 'app.trina.office-starter'
let app: CApp
let cat: string
let outside: string

const devTrust = (env: Record<string, string>) => trustRoot({ runKind: 'dev', env, productionKeys: [] })
const noTrust = () => trustRoot({ runKind: 'selfhost', env: {}, productionKeys: [] })
const upload = (bytes: Uint8Array) => {
  const fd = new FormData()
  fd.set('file', new Blob([new Uint8Array(bytes)]), 'pack.trinaplugin')
  return app.json('/api/admin/plugins/inspect', { method: 'POST', body: fd, as: 'carol' } as never)
}
const installOn = async (bytes: Uint8Array) => {
  const plan = (await upload(bytes)).body
  expect(plan.token, JSON.stringify(plan)).toBeTruthy()
  return app.json('/api/admin/plugins/install', { ...jsonBody({ token: plan.token, manifestSha256: plan.manifestSha256, enable: true, permissions: ['skills.company'] }), as: 'carol' })
}
const post = (p: string) => app.json(p, { ...jsonBody({}), as: 'carol' })
const managed = (rel: string) => path.join(app.team, ...rel.split('/'))
const skillFile = `skills/${ID}/meeting-minutes/SKILL.md`
const audits = (action: string) => app.ctx.db.query('SELECT target, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { target: string; detail: string }[]
const reset = async () => {
  pluginsOf(app.ctx).reconfigure({ trust: devTrust({ MYCEL_PLUGINS_ALLOW_UNSIGNED: '1' }) })
  if (app.ctx.db.query('SELECT 1 FROM plugin_installs WHERE plugin_id = ?').get(ID)) expect((await app.json(`/api/admin/plugins/${ID}`, { method: 'DELETE', as: 'carol' })).status).toBe(204)
  fs.rmSync(managed(`skills/${ID}`), { recursive: true, force: true })
}

beforeAll(async () => {
  app = await makeCApp('plugins-trust-recheck')
  cat = catalogDir(path.join(app.data, 'test-catalog'), [])
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-outside-'))
  pluginsOf(app.ctx).reconfigure({ catalogDir: cat, env: {} })
})
afterAll(async () => { await app.close(); fs.rmSync(outside, { recursive: true, force: true }) })

describe('trust is checked again under the current settings', () => {
  test('an unsigned pack stops being usable at start once unsigned packages are no longer allowed', async () => {
    await reset()
    expect((await installOn(skillPack({ keyPem: null }).bytes)).body).toMatchObject({ trust: 'unverified', enabled: true, status: 'enabled' })
    expect(fs.existsSync(managed(skillFile))).toBe(true)
    // the server starts again without MYCEL_PLUGINS_ALLOW_UNSIGNED
    const fresh = new PluginManager(app.ctx, { trust: devTrust({}), catalogDir: cat })
    expect(fresh.usable(ID)).toBe(false)
    expect(fresh.view(ID, 'en')).toMatchObject({ status: 'unsupported', unsupported: 'untrusted', enabled: false, skills: [] })
    expect(fs.existsSync(managed(skillFile))).toBe(false)
    expect(fs.existsSync(managed(`skills/${ID}`))).toBe(false)
    expect(JSON.parse(audits('plugin.untrust').at(-1)!.detail)).toMatchObject({ trust: 'unverified', keyId: null })
    // the server answering requests has the same view; turning it on (or keeping it on) is refused
    pluginsOf(app.ctx).reconfigure({ trust: devTrust({}) })
    const r = await post(`/api/admin/plugins/${ID}/enable`)
    expect(r.status).toBe(409)
    expect(r.body.error.params.reason).toBe('signature')
    expect(fs.existsSync(managed(skillFile))).toBe(false)
    const list = (await app.json('/api/admin/plugins', { as: 'carol' })).body
    expect(list.installed.find((p: any) => p.id === ID)).toMatchObject({ status: 'unsupported', unsupported: 'untrusted' })
  })

  test('a usable() check alone already refuses it, before the start sweep', async () => {
    await reset()
    await installOn(skillPack({ keyPem: null }).bytes)
    const m = pluginsOf(app.ctx)
    expect(m.usable(ID)).toBe(true)
    m.trust = devTrust({})
    expect(m.usable(ID)).toBe(false)
  })

  test('a test-signed pack stops being usable once the test key setting is removed', async () => {
    await reset()
    pluginsOf(app.ctx).reconfigure({ trust: devTrust({ MYCEL_PLUGINS_TEST_KEYS: key.pub }) })
    expect((await installOn(skillPack({ keyPem: key.pem }).bytes)).body).toMatchObject({ trust: 'test', enabled: true })
    expect(fs.existsSync(managed(skillFile))).toBe(true)
    pluginsOf(app.ctx).reconfigure({ trust: devTrust({}) })
    expect(pluginsOf(app.ctx).view(ID, 'en')).toMatchObject({ status: 'unsupported', unsupported: 'untrusted', enabled: false })
    expect(fs.existsSync(managed(skillFile))).toBe(false)
    const r = await post(`/api/admin/plugins/${ID}/enable`)
    expect(r.status).toBe(409)
    expect(r.body.error.params.reason).toBe('untrusted')
    // the setting back on: the admin may turn it on again
    pluginsOf(app.ctx).reconfigure({ trust: devTrust({ MYCEL_PLUGINS_TEST_KEYS: key.pub }) })
    expect((await post(`/api/admin/plugins/${ID}/enable`)).body).toMatchObject({ enabled: true, status: 'enabled' })
    expect(fs.existsSync(managed(skillFile))).toBe(true)
  })

  test('a pack signed with a key later dropped from the trust list stops being usable', async () => {
    await reset()
    pluginsOf(app.ctx).reconfigure({ trust: prodTrust(key.pub) })
    expect((await installOn(skillPack({ keyPem: key.pem }).bytes)).body).toMatchObject({ trust: 'official', verifiedBy: 'key', enabled: true })
    // the next release no longer lists the key
    const fresh = new PluginManager(app.ctx, { trust: noTrust(), catalogDir: cat })
    expect(fresh.view(ID, 'en')).toMatchObject({ status: 'unsupported', unsupported: 'untrusted', enabled: false })
    expect(fs.existsSync(managed(skillFile))).toBe(false)
    // the same key only as a test key does not make a package recorded as official usable
    pluginsOf(app.ctx).reconfigure({ trust: devTrust({ MYCEL_PLUGINS_TEST_KEYS: key.pub }) })
    expect(pluginsOf(app.ctx).usable(ID)).toBe(false)
    // a key kept but no longer allowed for this id
    const narrowed = trustRoot({ runKind: 'selfhost', env: {}, productionKeys: [{ publicKey: key.pub, publishers: ['trina'], idPrefixes: ['app.other.'], catalog: true }] })
    pluginsOf(app.ctx).reconfigure({ trust: narrowed })
    expect(pluginsOf(app.ctx).view(ID, 'en').unsupported).toBe('untrusted')
    pluginsOf(app.ctx).reconfigure({ trust: prodTrust(key.pub) })
    expect(pluginsOf(app.ctx).view(ID, 'en')).toMatchObject({ status: 'disabled', unsupported: null })
  })

  test('rollback to a version this server no longer trusts is refused', async () => {
    await reset()
    pluginsOf(app.ctx).reconfigure({ trust: devTrust({ MYCEL_PLUGINS_ALLOW_UNSIGNED: '1', MYCEL_PLUGINS_TEST_KEYS: key.pub }) })
    expect((await installOn(skillPack({ keyPem: null }).bytes)).body).toMatchObject({ trust: 'unverified' })
    expect((await installOn(skillPack({ keyPem: key.pem, version: '1.1.0' }).bytes)).body).toMatchObject({ trust: 'test', previousVersion: '1.0.0' })
    pluginsOf(app.ctx).reconfigure({ trust: devTrust({ MYCEL_PLUGINS_TEST_KEYS: key.pub }) })
    expect(pluginsOf(app.ctx).usable(ID)).toBe(true)
    const r = await post(`/api/admin/plugins/${ID}/rollback`)
    expect(r.status).toBe(409)
    expect(r.body.error.params.reason).toBe('signature')
    expect(pluginsOf(app.ctx).view(ID, 'en')).toMatchObject({ version: '1.1.0', enabled: true })
  })
})

describe('placing skills never follows a link', () => {
  test('a link planted at skills/<id> while the pack is off blocks turning it on and nothing is written outside', async () => {
    await reset()
    pluginsOf(app.ctx).reconfigure({ trust: prodTrust(key.pub) })
    await installOn(skillPack({ keyPem: key.pem }).bytes)
    expect((await post(`/api/admin/plugins/${ID}/disable`)).body).toMatchObject({ enabled: false })
    for (const target of [outside, path.join(outside, 'missing')]) {
      fs.symlinkSync(target, managed(`skills/${ID}`))
      const r = await post(`/api/admin/plugins/${ID}/enable`)
      expect(r.status).toBe(409)
      expect(r.body.error.params.reason).toBe('skills_conflict')
      expect(fs.readdirSync(outside)).toEqual([])
      expect(pluginsOf(app.ctx).view(ID, 'en')).toMatchObject({ enabled: false })
      fs.unlinkSync(managed(`skills/${ID}`))
    }
    expect((await post(`/api/admin/plugins/${ID}/enable`)).body).toMatchObject({ enabled: true })
  })

  test('a link or a hard link planted inside the placed folder blocks an update and is never written through', async () => {
    const victim = path.join(outside, 'victim.md')
    for (const plant of ['folder', 'file', 'hardlink'] as const) {
      await reset()
      pluginsOf(app.ctx).reconfigure({ trust: prodTrust(key.pub) })
      await installOn(skillPack({ keyPem: key.pem }).bytes)
      fs.writeFileSync(victim, 'outside')
      if (plant === 'folder') {
        fs.rmSync(managed(`skills/${ID}/meeting-minutes`), { recursive: true, force: true })
        fs.symlinkSync(outside, managed(`skills/${ID}/meeting-minutes`))
      } else {
        fs.chmodSync(managed(skillFile), 0o600)
        fs.rmSync(managed(skillFile))
        if (plant === 'file') fs.symlinkSync(victim, managed(skillFile)); else fs.linkSync(victim, managed(skillFile))
      }
      const r = await installOn(skillPack({ keyPem: key.pem, version: '1.1.0' }).bytes)
      expect(r.status, plant).toBe(409)
      expect(r.body.error.params.reason).toBe('skills_conflict')
      expect(fs.readFileSync(victim, 'utf8')).toBe('outside')
      expect(fs.readdirSync(outside).sort()).toEqual(['victim.md'])
      expect(pluginsOf(app.ctx).view(ID, 'en').version).toBe('1.0.0')
      // turning it off never deletes through the link either
      await post(`/api/admin/plugins/${ID}/disable`)
      expect(fs.readFileSync(victim, 'utf8')).toBe('outside')
      fs.rmSync(managed(`skills/${ID}`), { recursive: true, force: true })
    }
  })

  test('a link planted at skills/ itself is refused', async () => {
    await reset()
    pluginsOf(app.ctx).reconfigure({ trust: prodTrust(key.pub) })
    const skills = managed('skills'), aside = managed('skills-aside')
    const had = fs.existsSync(skills)
    if (had) fs.renameSync(skills, aside)
    fs.symlinkSync(outside, skills)
    try {
      const r = await upload(skillPack({ keyPem: key.pem }).bytes)
      expect(r.status).toBe(409)
      expect(r.body.error.params.reason).toBe('skills_conflict')
      expect(fs.readdirSync(outside).filter((n) => n !== 'victim.md')).toEqual([])
    } finally {
      fs.unlinkSync(skills)
      if (had) fs.renameSync(aside, skills)
    }
  })
})
