// Plugin lifecycle over the real HTTP app (docs/PLUGINS.md): install with the approved digest and permissions, enable,
// disable, update, roll back, uninstall; owner/admin only; audit; skill packs become company skills that load without
// warnings and cannot be edited in place; the Korean recommendation never installs anything; a broken store does not
// stop the server; hosted servers take no package files.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { listSkills, skillIssues } from '../../server/src/chat/skills'
import { PluginManager, pluginsOf } from '../../server/src/plugins/manager'
import { trustRoot } from '../../server/src/plugins/trust'
import { readMigrations, migrate } from '../../server/src/db'
import { openDb } from '../../server/src/db'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { catalogDir, newKey, packEntry, prodTrust, skillPack } from '../lib/plugins'

const key = newKey()
const ID = 'app.trina.office-starter'
let app: CApp
let cat: string

const upload = (bytes: Uint8Array, as: 'carol' | 'dana' | 'alice' = 'carol', csrf = true) => {
  const fd = new FormData()
  fd.set('file', new Blob([new Uint8Array(bytes)]), 'pack.trinaplugin')
  return app.json('/api/admin/plugins/inspect', { method: 'POST', body: fd, as, ...(csrf ? {} : { csrf: false }) } as never)
}
const install = (plan: any, o: Record<string, unknown> = {}, as: 'carol' | 'dana' = 'carol') =>
  app.json('/api/admin/plugins/install', { ...jsonBody({ token: plan.token, manifestSha256: plan.manifestSha256, enable: true, permissions: plan.permissions.filter((p: any) => p.required).map((p: any) => p.id), ...o }), as })
const post = (p: string, body: unknown = {}, as: 'carol' | 'dana' | 'alice' = 'carol') => app.json(p, { ...jsonBody(body), as })
const audits = (action: string) => app.ctx.db.query('SELECT actor_id, target, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { actor_id: string; target: string; detail: string }[]
const skillPaths = (who = 'alice') => listSkills(app.ctx.files, app.ctx.files.principal(who)).map((s) => s.path).filter((p) => p.startsWith(`skills/${ID}/`))
const managed = (rel: string) => path.join(app.team, ...rel.split('/'))

beforeAll(async () => {
  app = await makeCApp('plugins-lifecycle')
  cat = catalogDir(path.join(app.data, 'test-catalog'), [], {}, key.pem)
  pluginsOf(app.ctx).reconfigure({ trust: prodTrust(key.pub), catalogDir: cat, env: {} })
})
afterAll(async () => { await app.close() })

describe('company skill pack', () => {
  test('inspect shows the approval prompt; install needs the shown digest, every required permission and the same admin', async () => {
    const pkg = skillPack({ keyPem: key.pem }).bytes
    const r = await upload(pkg)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: ID, version: '1.0.0', trust: 'official', supported: true, update: null, skills: ['meeting-minutes', 'weekly-report'], permissions: [{ id: 'skills.company', required: true, new: false }] })
    // nothing installed by inspecting
    expect(app.ctx.db.query('SELECT COUNT(*) AS n FROM plugin_installs').get()).toEqual({ n: 0 })
    expect((await install(r.body, { manifestSha256: 'f'.repeat(64) })).body.error.params.reason).toBe('digest')
    const again = (await upload(pkg)).body
    expect((await install(again, {}, 'dana')).status).toBe(410)
    const third = (await upload(pkg)).body
    expect((await install(third, { permissions: [] })).body.error.params.reason).toBe('permissions')
    const fourth = (await upload(pkg)).body
    expect((await install(fourth, { permissions: ['skills.company', 'model.send.preview-pixels'] })).body.error.params.reason).toBe('permissions')
    const ok = (await upload(pkg)).body
    const done = await install(ok)
    expect(done.status).toBe(201)
    expect(done.body).toMatchObject({ id: ID, enabled: true, status: 'enabled', trust: 'official', access: { everyone: true, groups: [], users: [] }, previousVersion: null })
    // a token is single use
    expect((await install(ok)).status).toBe(410)
    expect(audits('plugin.install')).toHaveLength(1)
    expect(JSON.parse(audits('plugin.install')[0]!.detail)).toMatchObject({ version: '1.0.0', trust: 'official', permissions: ['skills.company'], enabled: true, source: 'file' })
    // stored outside the team folder
    expect(fs.existsSync(path.join(app.data, 'plugins/store', ID))).toBe(true)
    expect(fs.readdirSync(app.team)).not.toContain('plugins')
  })

  test('the skills load for everyone who reads skills/, without loader warnings', () => {
    expect(skillPaths().sort()).toEqual([`skills/${ID}/meeting-minutes/SKILL.md`, `skills/${ID}/weekly-report/SKILL.md`])
    expect(skillPaths('bob')).toHaveLength(2)
    expect(skillIssues(app.ctx.files, app.ctx.files.principal('carol')).filter((i) => i.path.startsWith(`skills/${ID}/`))).toEqual([])
    expect(fs.readFileSync(managed(`skills/${ID}/meeting-minutes/template.md`), 'utf8')).toContain('template')
  })

  test('nobody edits, moves, renames or deletes the managed copy in place, owner and admin included; the rest of skills/ stays writable', async () => {
    const rel = `skills/${ID}/meeting-minutes/SKILL.md`
    for (const as of ['carol', 'dana'] as const) {
      const save = await app.json('/api/files/content', { ...jsonBody({ path: rel, content: 'changed', baseSha256: null }, 'PUT'), as })
      expect(save.status, JSON.stringify(save.body)).toBe(403)
      expect(save.body.error.params.reason).toBe('plugin_managed')
      expect((await post('/api/files/move', { from: rel, to: 'skills/stolen.md' }, as)).status).toBe(403)
      expect((await post('/api/files/move', { from: `skills/${ID}`, to: 'skills/renamed' }, as)).status).toBe(403)
      expect((await app.json(`/api/files?path=${encodeURIComponent(`skills/${ID}/weekly-report`)}`, { method: 'DELETE', as })).status).toBe(403)
      // the folder that holds it cannot be moved or deleted either
      expect((await app.json('/api/files?path=skills', { method: 'DELETE', as })).status).toBe(403)
      expect((await post('/api/files/mkdir', { path: `skills/${ID}/extra` }, as)).status).toBe(403)
    }
    // the AI's file tools hit the same guard
    const t = app.toolCtx('carol')
    const w = await app.ctx.files.call('write', { file_path: rel, content: 'x' }, t)
    expect(w.isError).toBe(true)
    expect(w.text).toContain('managed by the plugin')
    // copying it out to edit the copy works
    const copied = await post('/api/files/copy', { from: rel, to: 'skills/my-minutes.md' }, 'carol')
    expect(copied.status, JSON.stringify(copied.body)).toBe(201)
    expect((await app.json('/api/files/content', { ...jsonBody({ path: 'skills/other-rules.md', content: '# rules\n', baseSha256: null }, 'PUT'), as: 'carol' })).status).toBe(200)
    expect(fs.readFileSync(managed(rel), 'utf8')).toContain('name: meeting-minutes')
  })

  test('disable removes the skills, enable brings them back', async () => {
    const off = await post(`/api/admin/plugins/${ID}/disable`)
    expect(off.body).toMatchObject({ enabled: false, status: 'disabled', skills: [] })
    expect(skillPaths()).toEqual([])
    expect(fs.existsSync(managed(`skills/${ID}`))).toBe(false)
    // while off, the folder name is ordinary again
    expect(app.ctx.files.fx.managed!.managerOf(['skills', ID, 'x.md'])).toBeNull()
    const on = await post(`/api/admin/plugins/${ID}/enable`)
    expect(on.body).toMatchObject({ enabled: true, status: 'enabled' })
    expect(skillPaths()).toHaveLength(2)
    expect(audits('plugin.disable')).toHaveLength(1)
    expect(audits('plugin.enable')).toHaveLength(1)
  })

  test('turning it off keeps a placed file changed outside the app; a taken folder blocks turning it on and nothing is saved', async () => {
    // an edit made outside the app (a shell, Finder on the office Mac): turning the pack off does not delete it
    const edited = managed(`skills/${ID}/weekly-report/template.md`)
    fs.chmodSync(edited, 0o600); fs.writeFileSync(edited, 'my own notes')
    expect((await post(`/api/admin/plugins/${ID}/disable`)).body).toMatchObject({ enabled: false, skills: [] })
    expect(fs.readFileSync(edited, 'utf8')).toBe('my own notes')
    expect(fs.existsSync(managed(`skills/${ID}/weekly-report/SKILL.md`))).toBe(false)
    // the folder is now someone else's: turning the pack on is refused before anything is saved
    const r = await post(`/api/admin/plugins/${ID}/enable`)
    expect(r.status).toBe(409)
    expect(r.body.error.params.reason).toBe('skills_conflict')
    expect(pluginsOf(app.ctx).view(ID, 'en')).toMatchObject({ enabled: false, status: 'disabled', skills: [] })
    expect(audits('plugin.enable')).toHaveLength(1)
    fs.rmSync(managed(`skills/${ID}`), { recursive: true })
    expect((await post(`/api/admin/plugins/${ID}/enable`)).body).toMatchObject({ enabled: true, status: 'enabled' })
    expect(skillPaths()).toHaveLength(2)
  })

  test('update changes the skills, keeps the old version for rollback, and refuses the same or a lower version', async () => {
    const v11 = skillPack({ keyPem: key.pem, version: '1.1.0', skills: { 'meeting-minutes': 'Minutes with decisions, owners and due dates.', 'customer-email': 'Draft a polite customer email.' } }).bytes
    const plan = (await upload(v11)).body
    expect(plan.update).toEqual({ from: '1.0.0' })
    const r = await install(plan)
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ version: '1.1.0', previousVersion: '1.0.0', enabled: true })
    expect(skillPaths().sort()).toEqual([`skills/${ID}/customer-email/SKILL.md`, `skills/${ID}/meeting-minutes/SKILL.md`])
    expect(fs.readFileSync(managed(`skills/${ID}/meeting-minutes/SKILL.md`), 'utf8')).toContain('due dates')
    expect(audits('plugin.update')).toHaveLength(1)
    expect((await upload(skillPack({ keyPem: key.pem, version: '1.1.0' }).bytes)).body.error.params.reason).toBe('same_version')
    expect((await upload(skillPack({ keyPem: key.pem, version: '1.0.0' }).bytes)).body.error.params.reason).toBe('downgrade')
    expect((await upload(skillPack({ keyPem: key.pem, version: '0.9.0' }).bytes)).body.error.params.reason).toBe('downgrade')
  })

  test('rollback returns to the verified previous version only, and refuses a changed store', async () => {
    const r = await post(`/api/admin/plugins/${ID}/rollback`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ version: '1.0.0', previousVersion: '1.1.0', enabled: true })
    expect(skillPaths().sort()).toEqual([`skills/${ID}/meeting-minutes/SKILL.md`, `skills/${ID}/weekly-report/SKILL.md`])
    expect(audits('plugin.rollback')).toHaveLength(1)
    // the 1.1.0 copy on disk is changed: rolling forward to it is refused
    const row = app.ctx.db.query("SELECT store_dir FROM plugin_packages WHERE plugin_id = ? AND version = '1.1.0'").get(ID) as { store_dir: string }
    const f = path.join(app.data, 'plugins/store', ID, row.store_dir, 'skills/customer-email/SKILL.md')
    fs.chmodSync(f, 0o644); fs.writeFileSync(f, 'replaced')
    const bad = await post(`/api/admin/plugins/${ID}/rollback`)
    expect(bad.status).toBe(409)
    expect(bad.body.error.params.reason).toBe('tampered')
  })

  test('only owners and admins manage plugins; CSRF is required', async () => {
    expect((await app.json('/api/admin/plugins', { as: 'alice' })).status).toBe(403)
    expect((await app.json('/api/admin/plugins')).status).toBe(401)
    expect((await upload(skillPack({ keyPem: key.pem }).bytes, 'alice')).status).toBe(403)
    expect((await post(`/api/admin/plugins/${ID}/disable`, {}, 'alice')).status).toBe(403)
    expect((await app.json(`/api/admin/plugins/${ID}`, { method: 'DELETE', as: 'alice' })).status).toBe(403)
    expect((await app.json(`/api/admin/plugins/${ID}/disable`, { ...jsonBody({}), as: 'carol', csrf: false } as never)).status).toBe(403)
    expect((await app.json('/api/admin/plugins', { as: 'dana' })).status).toBe(200)
  })

  test('uninstall removes the package and its skills; copies people made stay', async () => {
    const r = await app.json(`/api/admin/plugins/${ID}`, { method: 'DELETE', as: 'carol' })
    expect(r.status).toBe(204)
    expect(skillPaths()).toEqual([])
    expect(fs.existsSync(path.join(app.data, 'plugins/store', ID))).toBe(false)
    expect(app.ctx.db.query('SELECT COUNT(*) AS n FROM plugin_packages').get()).toEqual({ n: 0 })
    expect(fs.existsSync(managed('skills/my-minutes.md'))).toBe(true)
    expect(audits('plugin.uninstall')).toHaveLength(1)
    expect((await post(`/api/admin/plugins/${ID}/enable`)).status).toBe(404)
  })
})

describe('catalog, recommendation and hosting', () => {
  test('installing from a signed catalog checks the pinned digest; an unsigned list installs nothing', async () => {
    const bytes = skillPack({ keyPem: key.pem }).bytes
    catalogDir(cat, [packEntry(ID, '1.0.0', 'packages/office.trinaplugin', bytes)], { 'packages/office.trinaplugin': bytes }, key.pem)
    pluginsOf(app.ctx).reconfigure({ catalogDir: cat })
    const list = (await app.json('/api/admin/plugins', { as: 'carol' })).body
    expect(list.catalogSource).toBe('signed')
    expect(list.catalog[0]).toMatchObject({ id: ID, availability: 'available', installedVersion: null })
    const plan = await post('/api/admin/plugins/inspect-source', { source: 'catalog', id: ID })
    expect(plan.body).toMatchObject({ source: 'catalog', id: ID })
    expect((await install(plan.body, { enable: false })).body).toMatchObject({ source: 'catalog', enabled: false, status: 'disabled' })
    expect(skillPaths()).toEqual([])
    await app.json(`/api/admin/plugins/${ID}`, { method: 'DELETE', as: 'carol' })
    // a changed package next to the catalog
    fs.writeFileSync(path.join(cat, 'packages/office.trinaplugin'), skillPack({ keyPem: key.pem, version: '1.0.0', skills: { other: 'x' } }).bytes)
    expect((await post('/api/admin/plugins/inspect-source', { source: 'catalog', id: ID })).body.error.params.reason).toBe('tampered')
    // the same list without a signature: shown, not installable
    fs.rmSync(path.join(cat, 'catalog.sig'))
    pluginsOf(app.ctx).reconfigure({ catalogDir: cat })
    const unsigned = (await app.json('/api/admin/plugins', { as: 'carol' })).body
    expect(unsigned.catalogSource).toBe('release')
    expect(unsigned.catalog[0].availability).toBe('pending_clearance')
    expect((await post('/api/admin/plugins/inspect-source', { source: 'catalog', id: ID })).body.error.params.reason).toBe('not_available')
  })

  test('the bundled list recommends HWP only for a Korean workspace, and never installs or enables it', async () => {
    const repoCatalog = path.resolve(import.meta.dir, '../../resources/plugins')
    const m = pluginsOf(app.ctx)
    m.reconfigure({ catalogDir: repoCatalog, trust: prodTrust(key.pub) })
    updateTeamSettings(app.ctx.db, { defaultLocale: 'ko' })
    const ko = (await app.json('/api/admin/plugins', { as: 'carol' })).body
    expect(ko.catalogSource).toBe('release')
    const hwp = ko.catalog.find((c: any) => c.id === 'app.trina.hwp-preview')
    expect(hwp).toMatchObject({ recommended: true, installedVersion: null })
    // cleared and pinned for the four supported platforms: installable from the list where one fits this machine
    expect(['available', 'unsupported']).toContain(hwp.availability)
    expect(hwp.name).toBe('HWP Preview')
    expect((await app.json('/api/admin/plugins', { as: 'carol', headers: { 'x-mycel-locale': 'ko' } } as never)).status).toBe(200)
    // the person's language and the browser do not matter: only the workspace default does
    updateTeamSettings(app.ctx.db, { defaultLocale: 'en' })
    expect((await app.json('/api/admin/plugins', { as: 'carol', headers: { 'accept-language': 'ko-KR' } } as never)).body.catalog.find((c: any) => c.id === 'app.trina.hwp-preview').recommended).toBe(false)
    updateTeamSettings(app.ctx.db, { defaultLocale: 'ko' })
    // a fresh manager at start-up with a Korean workspace installs nothing either
    new PluginManager(app.ctx, { trust: prodTrust(key.pub), catalogDir: repoCatalog })
    expect(app.ctx.db.query('SELECT COUNT(*) AS n FROM plugin_installs').get()).toEqual({ n: 0 })
    expect(app.ctx.db.query('SELECT COUNT(*) AS n FROM plugin_access').get()).toEqual({ n: 0 })
    expect(m.usable('app.trina.hwp-preview')).toBe(false)
    // installing from the list downloads first (stubbed here: the feed is unreachable), and a failed download installs nothing
    m.reconfigure({ download: { fetch: (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch, lookup: async () => [{ address: '93.184.216.34', family: 4 }] } })
    if (hwp.availability === 'available') expect((await post('/api/admin/plugins/inspect-source', { source: 'catalog', id: 'app.trina.hwp-preview' })).body.error.params.reason).toBe('download')
    expect(app.ctx.db.query('SELECT COUNT(*) AS n FROM plugin_installs').get()).toEqual({ n: 0 })
    // Debian 12 (glibc 2.36): not supported on this server
    m.reconfigure({ host: { os: 'linux', arch: 'x64', libc: '2.36' } })
    expect((await app.json('/api/admin/plugins', { as: 'carol' })).body.catalog[0]).toMatchObject({ availability: 'unsupported', unsupported: 'libc', recommended: true })
    m.reconfigure({ host: { os: process.platform, arch: process.arch, libc: null }, catalogDir: cat })
    updateTeamSettings(app.ctx.db, { defaultLocale: 'en' })
  })

  test('hosted servers take no package files and ignore test trust', async () => {
    const hosted = await makeCApp('plugins-hosted')
    try {
      ;(hosted.ctx.config as { deployment?: string }).deployment = 'hosted'
      const m = new PluginManager(hosted.ctx, { env: { MYCEL_PLUGINS_TEST_KEYS: key.pub, MYCEL_PLUGINS_ALLOW_UNSIGNED: '1' } })
      expect(m.trust.keys).toEqual([])
      expect(m.trust.allowUnsigned).toBe(false)
      expect(m.list('en')).toMatchObject({ fileInstall: false, trustWarnings: [] })
      expect(() => m.inspect('carol', skillPack({ keyPem: key.pem }).bytes, 'file', 'en')).toThrow()
    } finally { await hosted.close() }
  })
})

describe('robustness', () => {
  test('a broken store never stops the server: the plugin shows as damaged and its features stay off', async () => {
    const plan = (await upload(skillPack({ keyPem: key.pem }).bytes)).body
    expect((await install(plan)).status).toBe(201)
    fs.rmSync(path.join(app.data, 'plugins/store', ID), { recursive: true, force: true })
    fs.writeFileSync(path.join(app.data, 'plugins/incoming-garbage'), 'x')
    const fresh = new PluginManager(app.ctx, { trust: prodTrust(key.pub), catalogDir: cat })
    expect(fresh.list('en').installed[0]).toMatchObject({ id: ID, status: 'unsupported', unsupported: 'damaged' })
    expect(fresh.usable(ID)).toBe(false)
    expect((await post(`/api/admin/plugins/${ID}/enable`)).body.error.params.reason).toBe('tampered')
    // the manager on the context still answers; removing the broken plugin works
    expect((await app.json(`/api/admin/plugins/${ID}`, { method: 'DELETE', as: 'carol' })).status).toBe(204)
    // a garbage manifest row does not break listing
    app.ctx.db.query("INSERT INTO plugin_packages (plugin_id, version, archive_sha256, manifest_sha256, manifest, trust, source, store_dir, installed_at) VALUES ('app.trina.broken','1.0.0','x','y','{not json','official','file','z','2026-10-30T00:00:00Z')").run()
    app.ctx.db.query("INSERT INTO plugin_installs (plugin_id, active_version, permissions, approved_manifest_sha256, approved_at, updated_at) VALUES ('app.trina.broken','1.0.0','[]','y','2026-10-30T00:00:00Z','2026-10-30T00:00:00Z')").run()
    expect((await app.json('/api/admin/plugins', { as: 'carol' })).status).toBe(200)
    expect((await app.json('/api/admin/plugins/app.trina.broken', { method: 'DELETE', as: 'carol' })).status).toBe(204)
  })

  test('the plugin migration does not raise the reader level: a 0.2.9 build (reader 4) still opens the database', () => {
    const m = readMigrations().find((x) => x.name === '321_c_plugins.sql')!
    expect(m.minCompatibleReader).toBe(1)
    const dir = path.join(app.data, 'old-migrations')
    fs.mkdirSync(dir, { recursive: true })
    for (const x of readMigrations()) if (x.version < 321) fs.writeFileSync(path.join(dir, x.name), x.sql)
    const db = openDb(path.join(app.data, 'rollback.db'))
    // the older build's own migration set and reader level against the newer database
    expect(() => migrate(db, { migrationsDir: dir, readerLevel: 4 })).not.toThrow()
    db.close()
  })

  test('test trust is announced in the list', () => {
    const m = new PluginManager(app.ctx, { trust: trustRoot({ runKind: 'dev', env: { MYCEL_PLUGINS_TEST_KEYS: key.pub }, productionKeys: [] }), catalogDir: cat })
    expect(m.list('en')).toMatchObject({ trustWarnings: ['test_keys'], trust: { testKeys: 1, productionKeys: 0 } })
  })
})
