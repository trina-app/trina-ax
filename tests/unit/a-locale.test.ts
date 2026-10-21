// Language (docs/DECISIONS.md "언어"): English unless someone chose otherwise. A person's own choice -> the team
// default -> English. New people follow the team default (users.locale_follows_team = 1, migration 102), so changing
// the default changes everyone who has not chosen; people who chose keep their language and existing rows are not
// rewritten. Before sign-in the page's own language header or the team default decides, never Accept-Language.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LOCALE, LOCALE_HEADER } from '@mycel/shared/api'
import { openDb } from '../../server/src/db'
import { syncFollowingLocales, teamDefaultLocale } from '../../server/src/admin/settings'
import { WORK } from '../lib/env'
import { OWNER_PW, SETUP_TOKEN, addMember, harness, type Harness } from './a-lib'

const owner = { username: 'olga', name: 'Olga Owner', password: OWNER_PW }

describe('a fresh install speaks English', () => {
  let h: Harness
  beforeAll(async () => { h = await harness('locale-fresh') })
  afterAll(async () => { await h.close() })

  test('default language, setup status, messages before setup', async () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(teamDefaultLocale(h.ctx.db)).toBe('en')
    expect(await h.client().call('GET', '/api/setup')).toEqual({ needed: true, teamName: null, defaultLocale: 'en' })
    // a Korean browser does not turn the server's messages Korean
    const bad = await h.client().try('POST', '/api/setup', { setupToken: 'x'.repeat(32), teamName: 'Acme', owner }, { 'accept-language': 'ko-KR,ko;q=0.9' })
    expect(bad.status).toBe(403)
    expect(bad.body.error.message).toMatch(/^[\x20-\x7e]+$/)
    // the page's own language (picked on the setup screen) does
    const ko = await h.client().try('POST', '/api/setup', { setupToken: 'x'.repeat(32), teamName: 'Acme', owner }, { [LOCALE_HEADER]: 'ko' })
    expect(ko.body.error.message).toMatch(/[가-힣]/)
    const id = await h.client().try('POST', '/api/setup', { setupToken: 'x'.repeat(32), teamName: 'Acme', owner }, { [LOCALE_HEADER]: 'id' })
    expect(id.body.error.message).not.toBe(bad.body.error.message)
    // garbage in the header is ignored
    const junk = await h.client().try('POST', '/api/setup', { setupToken: 'x'.repeat(32), teamName: 'Acme', owner }, { [LOCALE_HEADER]: 'xx' })
    expect(junk.body.error.message).toBe(bad.body.error.message)
  })

  test('setup without a language makes an English team; the owner follows it', async () => {
    const c = h.client()
    const r = await c.call('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Acme', owner })
    expect(r.me.team.defaultLocale).toBe('en')
    expect(r.me.user).toMatchObject({ locale: 'en', localeChoice: null })
    expect(await h.client().call('GET', '/api/setup')).toEqual({ needed: false, teamName: 'Acme', defaultLocale: 'en' })
    // a wrong password before sign-in: English, the team default
    const fail = await h.client().try('POST', '/api/auth/login', { username: 'olga', password: 'wrong wrong wrong' }, { 'accept-language': 'ko' })
    expect(fail.status).toBe(401)
    expect(fail.body.error.message).toMatch(/^[\x20-\x7e]+$/)
  })
})

describe('own choice, team default and followers', () => {
  let h: Harness
  beforeAll(async () => { h = await harness('locale-follow') })
  afterAll(async () => { await h.close() })

  test('choices, the team default moving followers only, invites and admin edits', async () => {
    const o = h.client()
    await o.call('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Acme', locale: 'ko', owner })
    expect((await o.call('GET', '/api/me')).user).toMatchObject({ locale: 'ko', localeChoice: null })
    // anonymous requests now get the team default (Korean)
    const fail = await h.client().try('POST', '/api/auth/login', { username: 'olga', password: 'wrong wrong wrong' })
    expect(fail.body.error.message).toMatch(/[가-힣]/)

    // a member made by an admin follows the team; one with a language of their own keeps it
    const bob = await addMember(h, o, { username: 'bob' })
    const made = await o.call('POST', '/api/admin/users', { username: 'erin', name: 'Erin', role: 'member', groupIds: [], locale: 'id' })
    expect(made.user).toMatchObject({ locale: 'id', localeChoice: 'id' })
    expect((await bob.client.call('GET', '/api/me')).user).toMatchObject({ locale: 'ko', localeChoice: null })

    // an invitee who picked a language on the invite page keeps it; one who did not follows the team
    const inv1 = await o.call('POST', '/api/admin/invites', { role: 'member', groupIds: [] })
    const inv2 = await o.call('POST', '/api/admin/invites', { role: 'member', groupIds: [] })
    const tok = (i: any) => i.token as string
    const ann = h.client({ ip: '10.0.0.8' })
    await ann.call('POST', `/api/invites/${tok(inv1)}/accept`, { username: 'ann', name: 'Ann', password: 'river stone lamp 7', locale: 'en' })
    const ben = h.client({ ip: '10.0.0.9' })
    await ben.call('POST', `/api/invites/${tok(inv2)}/accept`, { username: 'ben', name: 'Ben', password: 'river stone lamp 8' })
    expect((await ann.call('GET', '/api/me')).user).toMatchObject({ locale: 'en', localeChoice: 'en' })
    expect((await ben.call('GET', '/api/me')).user).toMatchObject({ locale: 'ko', localeChoice: null })

    // the owner (follower) changes the team default: followers move, people with a choice stay
    h.hub.events = []
    const s = await o.call('PATCH', '/api/admin/settings', { defaultLocale: 'id' })
    expect(s.defaultLocale).toBe('id')
    // every open window asks for its language again (no reload)
    const changed = (target: string) => h.hub.events.some((e) => e.kind === 'publish' && e.target === target && (e.data as any).data.code === 'locale_changed')
    expect(changed('*')).toBe(true)
    expect((await o.call('GET', '/api/me')).user).toMatchObject({ locale: 'id', localeChoice: null })
    expect((await bob.client.call('GET', '/api/me')).user.locale).toBe('id')
    expect((await ben.call('GET', '/api/me')).user.locale).toBe('id')
    expect((await ann.call('GET', '/api/me')).user.locale).toBe('en')
    const users = (await o.call('GET', '/api/admin/users')).items
    expect(users.find((u: any) => u.username === 'erin')).toMatchObject({ locale: 'id', localeChoice: 'id' })
    // a member's own messages follow their language (bob follows: Indonesian now)
    const forbidden = await bob.client.try('GET', '/api/admin/users')
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.error.message).toBe('Anda tidak memiliki izin.')

    // bob picks English, then goes back to the team default
    expect((await bob.client.call('PATCH', '/api/me', { locale: 'en' })).user).toMatchObject({ locale: 'en', localeChoice: 'en' })
    await o.call('PATCH', '/api/admin/settings', { defaultLocale: 'ko' })
    expect((await bob.client.call('GET', '/api/me')).user.locale).toBe('en')
    expect((await bob.client.call('PATCH', '/api/me', { locale: null })).user).toMatchObject({ locale: 'ko', localeChoice: null })
    // an admin can set or clear someone's language too (their open windows switch)
    const erin = users.find((u: any) => u.username === 'erin')
    h.hub.events = []
    expect(await o.call('PATCH', `/api/admin/users/${erin.id}`, { locale: null })).toMatchObject({ locale: 'ko', localeChoice: null })
    expect(changed(erin.id)).toBe(true)
    // other settings do not ask anyone to reload their language
    h.hub.events = []
    await o.call('PATCH', '/api/admin/settings', { concurrency: 2 })
    expect(changed('*')).toBe(false)
    expect(await o.call('PATCH', `/api/admin/users/${erin.id}`, { locale: 'en' })).toMatchObject({ locale: 'en', localeChoice: 'en' })
    // the stored rows: flag and the mirrored language
    const rows = h.ctx.db.query('SELECT username, locale, locale_follows_team AS f FROM users ORDER BY username').all()
    expect(rows).toEqual([
      { username: 'ann', locale: 'en', f: 0 },
      { username: 'ben', locale: 'ko', f: 1 },
      { username: 'bob', locale: 'ko', f: 1 },
      { username: 'erin', locale: 'en', f: 0 },
      { username: 'olga', locale: 'ko', f: 1 },
    ])
  })

  test('conflict copies and restored names use the team default language', async () => {
    const { conflictCopyName } = await import('../../server/src/files/store')
    const d = new Date(2026, 9, 21, 10, 0)
    expect(conflictCopyName('plan.md', 'Bob', d)).toBe('plan (conflict copy - Bob 2026-10-21 10.00).md')
    expect(conflictCopyName('plan.md', 'Bob', d, 'ko')).toBe('plan (충돌 사본 - Bob 2026-10-21 10.00).md')
    expect(conflictCopyName('plan.md', 'Bob', d, 'id')).toBe('plan (salinan konflik - Bob 2026-10-21 10.00).md')
  })
})

describe('migration 102 on an existing database', () => {
  test('existing people keep their language; nothing is rewritten; followers resync at start', () => {
    const dir = path.join(WORK, 'a-locale-migrate')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'app.db')
    // a database from before migration 102: apply only the migrations up to 101
    const raw = new Database(file)
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, min_compatible_reader INTEGER NOT NULL DEFAULT 1)')
    const migDir = path.resolve(import.meta.dir, '../../server/migrations')
    for (const f of fs.readdirSync(migDir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
      const v = Number(f.split('_')[0])
      if (v >= 102) continue
      raw.exec(fs.readFileSync(path.join(migDir, f), 'utf8'))
      raw.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(v, f, new Date().toISOString())
    }
    raw.exec("INSERT INTO users (id, username, name, role, locale) VALUES ('kim', 'kim', 'Kim', 'owner', 'ko'), ('lee', 'lee', 'Lee', 'member', 'en')")
    raw.exec(`INSERT INTO settings (key, value) VALUES ('defaultLocale', '"ko"')`)
    raw.close()

    const db = openDb(file)
    try {
      const before = db.query('SELECT id, locale, locale_follows_team AS f FROM users ORDER BY id').all()
      expect(before).toEqual([{ id: 'kim', locale: 'ko', f: 0 }, { id: 'lee', locale: 'en', f: 0 }])
      // the team default changes: nobody follows it, so nobody's language changes
      db.query(`UPDATE settings SET value = '"id"' WHERE key = 'defaultLocale'`).run()
      syncFollowingLocales(db)
      expect(db.query('SELECT id, locale FROM users ORDER BY id').all()).toEqual([{ id: 'kim', locale: 'ko' }, { id: 'lee', locale: 'en' }])
      // a follower left behind (an older build changed the default) is brought up to date at start
      db.exec("INSERT INTO users (id, username, name, role, locale, locale_follows_team) VALUES ('new', 'new', 'New', 'member', 'ko', 1)")
      syncFollowingLocales(db)
      expect(db.query("SELECT locale FROM users WHERE id = 'new'").get()).toEqual({ locale: 'id' })
    } finally {
      db.close()
    }
  })
})
