// Gmail, Calendar, Docs and Sheets shared with the team (server/src/integrations/google-apps/service.ts "the account
// shared with the team", docs/GOOGLE-APPS.md "Shared with the team", QA TC-198). Covered: only an active owner or admin
// can start, complete, change or remove the shared account (members get 403 from every endpoint, and the service refuses
// a member called directly); a personal sign-in never completes the team's and the other way round; a new shared
// account is used by nobody until its people are saved; the people its rule includes (everyone, a group, a person) get
// its tools in a chat with the shared account's token, and nobody else (not the admin who made it, unless the rule
// includes them; not through a scheduled run or another API path); members see "shared by an admin" only when it
// includes them; members' own connections are never read or written by it; changes ask on the card (the member's own
// Always allow, cleared when the account changes), a scheduled run cannot send; the generic connection APIs do not list
// or manage it; Google is not asked to revoke a grant another sign-in of the same admin still uses. Fake Google and a
// fake library on 127.0.0.1 only.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, PEOPLE, type CApp, type Person } from '../lib/c-app'
import { APP_CLIENT, FakeGoogle, FakeLibrary, sessionRow } from '../lib/fake-google-apps'
import { googleAppsOf, type GoogleApps } from '../../server/src/integrations/google-apps/service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { usersOf } from '../../server/src/integrations/connections/store'
import { readScope } from '../../server/src/chat/read-scope'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnTool, TurnToolContext } from '../../server/src/services'

setDefaultTimeout(60_000)

let A: CApp, lib: FakeLibrary, google: FakeGoogle, apps: GoogleApps, n = 0

beforeAll(() => { lib = new FakeLibrary().start(); process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL = lib.url })
afterAll(() => { lib.stop(); delete process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL })
beforeEach(async () => {
  A = await makeCApp('gapps-team-' + ++n)
  ;(A.ctx.config as any).tunnel = { host: 'team.example.test' }
  google = new FakeGoogle(lib)
  apps = googleAppsOf(A.ctx, { fetch: google.fetch })
  for (const p of PEOPLE) sessionRow(A.ctx.db, p)
  for (const app of ['gmail', 'sheets']) {
    const r = await A.json(`/api/admin/google-apps/${app}/client`, { method: 'PUT', as: 'carol', headers: { 'content-type': 'application/json' }, body: JSON.stringify(APP_CLIENT) })
    expect(r.status).toBe(200)
  }
})
afterEach(async () => { await A?.close() })

type App = 'gmail' | 'calendar' | 'docs' | 'sheets'
const browser = (who: string) => ({ userId: who, sessionId: `${who}-session` })
const send = (as: Person, method: string, p: string, body?: unknown) =>
  A.json(p, { method, as, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })

/** a person's own connection */
async function connectOwn(who: Person, app: App = 'gmail') {
  const f = await apps.authorize(who, `${who}-session`, app)
  expect(await apps.callback(google.authorize(f.authorizationUrl, who), browser(who))).toBe(true)
  return apps.complete(who, `${who}-session`, app, f.flowId)
}
/** the shared account, signed in by `admin` with the Google account `google` */
async function connectTeam(admin: Person, app: App = 'gmail', account = 'teambox') {
  const f = await apps.authorize(admin, `${admin}-session`, app, 'team')
  expect(await apps.callback(google.authorize(f.authorizationUrl, account), browser(admin))).toBe(true)
  return apps.completeTeam(admin, `${admin}-session`, app, f.flowId)
}
const teamId = (app: App = 'gmail') => (A.ctx.db.query("SELECT id FROM integrations WHERE scope='team' AND google_app=?").get(app) as { id: string } | null)?.id ?? null
const everyone = { everyone: true, groups: [], users: [] }

interface Card { asked: string[]; choices: string[][]; answer: string }
const card = (answer: string): Card => ({ asked: [], choices: [], answer })
function turn(user: Person, o: { person?: Card; scheduled?: boolean } = {}) {
  const chat = A.chat(user)
  const turnId = A.turn(user, chat)
  const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: !!o.scheduled })
  const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles(), signal: new AbortController().signal } as unknown as TurnToolContext['files']
  if (o.person) {
    const p = o.person
    files.person = {
      locale: 'en',
      async confirm(q) { p.asked.push(q); return p.answer === 'yes' },
      async choose(q, options) { p.asked.push(q); p.choices.push(options.map((x) => x.label)); const want = p.answer === 'yes' ? 'allow' : p.answer === 'no' ? 'deny' : p.answer; return options.some((x) => x.value === want) ? want : null },
      *turnUrls() {},
      // a turn the person watches from their own app (the card may offer Always allow); never a scheduled run
      allSitesHere: () => !o.scheduled,
      ...(o.scheduled ? { unattended: true } : {}),
    }
  }
  const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale: 'en', signal: new AbortController().signal, files }
  const tools = new Map(built.tools.map((t) => [t.name, t as TurnTool]))
  const call = async (name: string, args: unknown) => {
    const t = tools.get(name)
    if (!t) throw new Error(`no tool ${name}; have ${[...tools.keys()].join(', ')}`)
    const r = await t.call(args, tc)
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), isError: !!r.isError, summary: r.summary ?? '' }
  }
  return { chat, tools, prompt: built.prompt ?? '', call }
}
const teamTools = (user: Person, scheduled = false) => [...turn(user, { scheduled }).tools.keys()].filter((x) => x.startsWith('team_gmail__'))

test('members cannot make, change or remove the shared account: 403 from every endpoint, and the service refuses them too', async () => {
  for (const who of ['alice', 'bob'] as const) {
    expect((await send(who, 'POST', '/api/admin/google-apps/gmail/team/authorize', {})).status).toBe(403)
    expect((await send(who, 'GET', '/api/admin/google-apps/gmail/team/flows/x')).status).toBe(403)
    expect((await send(who, 'DELETE', '/api/admin/google-apps/gmail/team/flows/x')).status).toBe(403)
    expect((await send(who, 'POST', '/api/admin/google-apps/gmail/team/flows/x/complete', {})).status).toBe(403)
    expect((await send(who, 'PUT', '/api/admin/google-apps/gmail/team', { access: everyone })).status).toBe(403)
    expect((await send(who, 'DELETE', '/api/admin/google-apps/gmail/team')).status).toBe(403)
  }
  // called directly (another path than the route): refused
  await expect(apps.authorize('alice', 'alice-session', 'gmail', 'team')).rejects.toMatchObject({ reason: 'access_denied', status: 403 })
  await connectTeam('carol')
  expect(() => apps.setTeamAccess('alice', 'gmail', everyone)).toThrow()
  await expect(apps.removeTeam('alice', 'gmail')).rejects.toMatchObject({ reason: 'access_denied' })
  expect(teamId()).not.toBeNull()
  // an admin who lost the role on the way cannot finish a team sign-in started before
  const f = await apps.authorize('carol', 'carol-session', 'gmail', 'team')
  expect(await apps.callback(google.authorize(f.authorizationUrl, 'teambox'), browser('carol'))).toBe(true)
  A.ctx.db.query("UPDATE users SET role='member' WHERE id='carol'").run()
  await expect(apps.completeTeam('carol', 'carol-session', 'gmail', f.flowId)).rejects.toMatchObject({ status: 403 })
  // the owner can
  A.ctx.db.query("UPDATE users SET role='admin' WHERE id='carol'").run()
  expect((await apps.authorize('dana', 'dana-session', 'gmail', 'team')).flowId).toBeString()
})

test('a personal sign-in never completes the shared account, nor a team sign-in a personal connection', async () => {
  const own = await apps.authorize('carol', 'carol-session', 'gmail')
  expect(await apps.callback(google.authorize(own.authorizationUrl, 'carol'), browser('carol'))).toBe(true)
  await expect(apps.completeTeam('carol', 'carol-session', 'gmail', own.flowId)).rejects.toMatchObject({ status: 404 })
  const team = await apps.authorize('carol', 'carol-session', 'gmail', 'team')
  expect(await apps.callback(google.authorize(team.authorizationUrl, 'teambox'), browser('carol'))).toBe(true)
  await expect(apps.complete('carol', 'carol-session', 'gmail', team.flowId)).rejects.toMatchObject({ status: 404 })
  // both still complete through their own path: starting one did not cancel the other
  expect((await apps.complete('carol', 'carol-session', 'gmail', own.flowId)).status).toBe('connected')
  expect((await apps.completeTeam('carol', 'carol-session', 'gmail', team.flowId)).team).toMatchObject({ status: 'connected', account: { email: 'teambox@acme.example' } })
  // the same flow over HTTP: bound to its session (another session of the same admin cannot poll it)
  expect([401, 404]).toContain((await send('carol', 'GET', `/api/admin/google-apps/gmail/team/flows/${team.flowId}`)).status)
  await expect(Promise.resolve().then(() => apps.flow('carol', 'other-session', 'gmail', team.flowId, 'team'))).rejects.toBeDefined()
})

test('a new shared account is used by nobody until its people are saved; then only the people its rule includes', async () => {
  const st = await connectTeam('carol')
  expect(st.team).toMatchObject({ status: 'connected', access: { everyone: false, groups: [], users: [] }, usedBy: 0, connectedBy: { id: 'carol' } })
  for (const who of PEOPLE) expect(teamTools(who)).toEqual([])
  // a group and one person
  const r = await send('carol', 'PUT', '/api/admin/google-apps/gmail/team', { access: { everyone: false, groups: ['finance'], users: ['alice'] } })
  expect(r.status).toBe(200)
  expect(r.body.team).toMatchObject({ usedBy: 2, access: { groups: ['finance'], users: ['alice'] } })
  expect(teamTools('alice').length).toBeGreaterThan(0)
  expect(teamTools('bob').length).toBeGreaterThan(0)
  // not covered: erin (marketing), and the admin who made it and the owner (being an admin is not a rule)
  expect(teamTools('erin')).toEqual([])
  expect(teamTools('carol')).toEqual([])
  expect(teamTools('dana')).toEqual([])
  expect([...usersOf(A.ctx.db, teamId()!)].sort()).toEqual(['alice', 'bob'])
  // members see it as shared by an admin only when it includes them
  expect((await send('alice', 'GET', '/api/integrations/google-apps')).body.apps[0].shared).toMatchObject({ account: { email: 'teambox@acme.example' }, status: 'connected', alwaysAllowed: false })
  expect((await send('erin', 'GET', '/api/integrations/google-apps')).body.apps[0].shared).toBeNull()
  // a group or person that does not exist is refused
  expect((await send('carol', 'PUT', '/api/admin/google-apps/gmail/team', { access: { everyone: false, groups: ['nope'], users: [] } })).status).toBe(400)
  // taken away: bob leaves the rule
  await send('carol', 'PUT', '/api/admin/google-apps/gmail/team', { access: { everyone: false, groups: [], users: ['alice'] } })
  expect(teamTools('bob')).toEqual([])
  // an older generic path does not reach it: not in the lists, not manageable, refused per call for someone outside
  const id = teamId()!
  expect((await send('bob', 'GET', '/api/integrations')).body.items.some((x: any) => x.id === id)).toBe(false)
  expect((await send('alice', 'GET', '/api/integrations')).body.items.some((x: any) => x.id === id)).toBe(false)
  const adminList = await send('carol', 'GET', '/api/admin/integrations')
  expect(adminList.status).toBe(200)
  expect(adminList.body.items.some((x: any) => x.id === id)).toBe(false)
  expect((await send('carol', 'PATCH', `/api/integrations/${id}`, { writePolicy: 'allow' })).status).toBe(404)
  expect((await send('carol', 'DELETE', `/api/integrations/${id}`)).status).toBe(404)
  expect(() => integrationsOf(A.ctx).forCall('bob', id)).toThrow('may not use')
})

test('a member\'s call uses the shared account\'s token; their own connection is never touched by the shared one', async () => {
  const own = await connectOwn('alice')
  const ownRow = () => A.ctx.db.query("SELECT id, secret_enc, account, write_policy, version FROM integrations WHERE owner_user_id='alice' AND google_app='gmail'").get()
  A.ctx.db.query("UPDATE integrations SET write_policy='allow' WHERE owner_user_id='alice' AND google_app='gmail'").run()
  const before = ownRow()
  await connectTeam('carol')
  await send('carol', 'PUT', '/api/admin/google-apps/gmail/team', { access: everyone })
  expect(ownRow()).toEqual(before)
  const t = turn('alice', { person: card('no') })
  // both: their own (my_) and the team's (team_), and the list says which account is shared
  expect([...t.tools.keys()].some((x) => x.startsWith('my_gmail__'))).toBe(true)
  expect([...t.tools.keys()].some((x) => x.startsWith('team_gmail__'))).toBe(true)
  expect(t.prompt).toContain("Gmail (team connection, the team's shared Google account teambox@acme.example")
  lib.calls = []
  const r = await t.call('team_gmail__search_gmail_messages', { query: 'lunch' })
  expect(r.isError).toBe(false)
  expect(lib.calls.map((c) => c.who)).toEqual(['teambox'])
  // the answer may reach the people the shared account is for (a team connection's scope), not alice's own
  expect(readScope(A.ctx.db, t.chat)).toEqual(expect.arrayContaining([{ type: 'integration', id: teamId() }]))
  expect(readScope(A.ctx.db, t.chat)).not.toEqual(expect.arrayContaining([{ type: 'user', id: 'alice', via: 'connection' }]))
  expect(own.status).toBe('connected')
  // reconnecting and removing the shared one leave alice's own as it was
  await connectTeam('carol', 'gmail', 'otherbox')
  expect(ownRow()).toEqual(before)
  expect((await send('carol', 'DELETE', '/api/admin/google-apps/gmail/team')).body).toMatchObject({ removed: true })
  expect(ownRow()).toEqual(before)
  expect(teamId()).toBeNull()
  expect(teamTools('alice')).toEqual([])
  expect((await send('alice', 'GET', '/api/integrations/google-apps')).body.apps[0]).toMatchObject({ status: 'connected', shared: null })
})

test('changes ask on the card; Always allow is the member\'s own and goes when the account changes; a scheduled run cannot send', async () => {
  await connectTeam('carol')
  await send('carol', 'PUT', '/api/admin/google-apps/gmail/team', { access: everyone })
  const id = teamId()!
  expect((A.ctx.db.query('SELECT write_policy FROM integrations WHERE id=?').get(id) as { write_policy: string }).write_policy).toBe('ask')
  lib.calls = []
  const no = card('no')
  expect((await turn('alice', { person: no }).call('team_gmail__send_gmail_message', { to: 'x@acme.example', subject: 's', body: 'b' })).isError).toBe(true)
  expect(no.choices).toEqual([['Send once', 'Always allow', 'Don’t send']])
  expect(lib.calls).toEqual([])
  // Always allow: alice's own row, never the team's rule
  expect((await turn('alice', { person: card('always') }).call('team_gmail__send_gmail_message', { to: 'x@acme.example', subject: 's', body: 'b' })).isError).toBe(false)
  expect((A.ctx.db.query('SELECT write_policy FROM integrations WHERE id=?').get(id) as { write_policy: string }).write_policy).toBe('ask')
  expect((await send('alice', 'GET', '/api/integrations/google-apps')).body.apps[0].shared.alwaysAllowed).toBe(true)
  const bob = card('no')
  expect((await turn('bob', { person: bob }).call('team_gmail__send_gmail_message', { to: 'x@acme.example', subject: 's', body: 'b' })).isError).toBe(true)
  expect(bob.asked).toHaveLength(1)
  // a scheduled run: nobody to ask, nothing sent
  lib.calls = []
  expect((await turn('bob', { person: card('yes'), scheduled: true }).call('team_gmail__send_gmail_message', { to: 'x@acme.example', subject: 's', body: 'b' })).isError).toBe(true)
  expect(lib.calls).toEqual([])
  // she can take it back
  expect((await send('alice', 'DELETE', `/api/integrations/${id}/always-allow`)).status).toBe(200)
  expect((await send('alice', 'GET', '/api/integrations/google-apps')).body.apps[0].shared.alwaysAllowed).toBe(false)
  await turn('alice', { person: card('always') }).call('team_gmail__send_gmail_message', { to: 'x@acme.example', subject: 's', body: 'b' })
  // the same account signed in again keeps her choice; another account ends it
  await connectTeam('carol', 'gmail', 'teambox')
  expect((await send('alice', 'GET', '/api/integrations/google-apps')).body.apps[0].shared.alwaysAllowed).toBe(true)
  await connectTeam('carol', 'gmail', 'otherbox')
  expect((await send('alice', 'GET', '/api/integrations/google-apps')).body.apps[0].shared).toMatchObject({ alwaysAllowed: false, account: { email: 'otherbox@acme.example' } })
  // a reconnect keeps the rule
  expect(apps.teamView('gmail')!.access).toEqual(everyone)
})

test('one shared account per app; the admin page says who signed it in and who uses it; the audit has no address or token', async () => {
  await connectTeam('carol', 'gmail')
  await connectTeam('dana', 'gmail', 'otherbox')
  expect((A.ctx.db.query("SELECT count(*) n FROM integrations WHERE scope='team' AND google_app='gmail'").get() as { n: number }).n).toBe(1)
  expect(() => A.ctx.db.query("INSERT INTO integrations (id, scope, kind, name, slug, url, auth, write_policy, status, tools_json, version, created_at, updated_at, google_app) VALUES ('x','team','mcp','Gmail','gmail9','https://gmail.invalid/mcp','oauth','ask','connected','[]',1,'t','t','gmail')").run()).toThrow()
  await connectTeam('carol', 'sheets')
  const list = (await send('carol', 'GET', '/api/admin/google-apps')).body.apps
  expect(list.find((a: any) => a.id === 'gmail').team).toMatchObject({ connectedBy: { id: 'dana' }, account: { email: 'otherbox@acme.example' } })
  expect(list.find((a: any) => a.id === 'sheets').team).toMatchObject({ connectedBy: { id: 'carol' } })
  expect(list.find((a: any) => a.id === 'calendar').team).toBeNull()
  const audit = JSON.stringify(A.ctx.db.query("SELECT action, detail FROM audit_log WHERE action LIKE 'google_app.team%'").all())
  expect(audit).toContain('google_app.team_connected')
  expect(audit).not.toContain('@acme.example')
  expect(audit).not.toContain('CANARY')
})

test('Google is not asked to revoke a grant the same admin still uses here; removing the last one asks', async () => {
  await connectOwn('carol')
  await connectTeam('carol')
  // carol's own Gmail goes: her shared account still uses her sign-in here
  expect((await send('carol', 'DELETE', '/api/integrations/google-apps/gmail')).body.revocation).toBe('not_needed')
  expect(google.revoked).toEqual([])
  expect(apps.teamView('gmail')!.status).toBe('connected')
  // and the other way round: the shared one goes while she keeps her own Sheets
  await connectOwn('carol', 'sheets')
  expect((await send('carol', 'DELETE', '/api/admin/google-apps/gmail/team')).body).toEqual({ removed: true, revocation: 'not_needed' })
  expect(google.revoked).toEqual([])
  // the last sign-in: asked
  await connectTeam('carol')
  await send('carol', 'DELETE', '/api/integrations/google-apps/sheets')
  expect((await send('carol', 'DELETE', '/api/admin/google-apps/gmail/team')).body).toEqual({ removed: true, revocation: 'revoked' })
  expect(google.revoked).toHaveLength(1)
})
