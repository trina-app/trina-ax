// "Allow all websites" for the AI's web reads (docs/DECISIONS.md "Allow all websites covers the AI's web reads";
// server/src/tools/web-allow-all.ts, url-gate.ts rule ①d). A person's own switch, behind the team's webAllowAll (on by
// default, the owner's call) under browserAllowAll, lets ordinary public addresses open without the address card, with
// no budget, in the turns of that person (also in rooms and shared chats: always the caller's own switch, never another
// member's) that the person watches. What still asks: random-looking parts, long names before the site, user names, long queries, an
// unknown exit address, addresses with no site, echoes, confidential chats. Only the person turns it on: Settings with
// the risk sentence accepted, or the address card's own answer (on the first card). The team turning it off is
// race-free (an epoch) and audited, as are a stale warning and a deactivated account.
// Every DNS lookup is a stub (node:dns/promises lookup replaced for this file): nothing resolves or opens a real name.
import dnsP from 'node:dns/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { ALL_SITES_ANSWER, uuidv7, WEB_ALLOW_ALL_RISK, WEB_ALLOW_ALL_WARNING_VERSION } from '@mycel/shared'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { noteEgressIp } from '../../server/src/tools/egress'
import { toolRegistry } from '../../server/src/tools/registry'
import { TurnFiles } from '../../server/src/files/service'
import { allowSite, gateUrl, rememberUrls, type ConfirmExtra, type TurnPerson } from '../../server/src/tools/url-gate'
import { getTeamSettings, updateTeamSettings } from '../../server/src/admin/settings'
import { policyEpoch, setWebAllowAll, webAllowAll } from '../../server/src/tools/web-allow-all'
import { enforceAuth } from '../../server/src/http/route'

setDefaultTimeout(60_000)

const lookups: string[] = []
const original = dnsP.lookup
;(dnsP as unknown as { lookup: unknown }).lookup = async (host: string) => {
  lookups.push(host.toLowerCase())
  throw Object.assign(new Error('stub: not resolved'), { code: 'ENOTFOUND' })
}
const looked = (host: string) => lookups.filter((x) => x === host.toLowerCase()).length

let h: Harness
let alice: TestSocket
let bob: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'web-allow-all', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  noteEgressIp(h.ctx, '198.51.100.7')
  // the contract's group ids are UUIDv7 (GET /api/me checks its answer); the fixture's are short
  h.ctx.db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2']) h.ctx.db.query(sql).run(id, g)
  }
  h.ctx.db.exec('PRAGMA foreign_keys = ON')
  alice = await h.ws('alice', { windowId: 'win-web-all' })
  await alice.next('hello')
  bob = await h.ws('bob', { windowId: 'win-web-all-bob' })
  await bob.next('hello')
})
afterAll(async () => {
  ;(dnsP as unknown as { lookup: unknown }).lookup = original
  alice?.close()
  bob?.close()
  await h?.close()
})
const db = () => h.ctx.db
/** the team allows it (both switches), the way each test starts */
beforeEach(() => {
  updateTeamSettings(db(), { browserAllowAll: true, webAllowAll: true })
  for (const u of ['alice', 'bob', 'erin']) setWebAllowAll(db(), u, false, { via: 'settings' })
})

type Asked = { question: string; options?: { label: string; value: string }[]; extra?: ConfirmExtra }
/** answers every card with `answer` (an option value; null = declined) and records what it showed. `here`: the turn says
 * "Allow all websites" may apply (the person's own chat, watched); the gate checks the chat row as well */
function person(answer: string | null, asked: Asked[] = [], o: { here?: boolean; unattended?: boolean; changed?: () => void } = {}): TurnPerson {
  return {
    locale: 'en',
    async confirm(question, _a, _d, extra) { asked.push({ question, extra }); return answer === 'allow' },
    async choose(question, options, extra) { asked.push({ question, options, extra }); return answer },
    turnUrls: () => [],
    allSitesHere: () => o.here ?? true,
    ...(o.unattended ? { unattended: true } : {}),
    ...(o.changed ? { webAccessChanged: o.changed } : {}),
  }
}
async function chatOf(user = 'alice', content = 'hello') {
  const chat = await h.api(user).call(API.createChat, { body: {} })
  db().query("INSERT INTO messages (id, chat_id, role, author_id, content, status) VALUES (?, ?, 'user', ?, ?, 'done')").run(uuidv7(), chat.id, user, content)
  return chat.id as string
}
const gate = (chat: string, url: string, p: TurnPerson | null, o: { user?: string | null; turn?: string; egressKnown?: boolean } = {}) =>
  gateUrl(db(), chat, url, p, { turnId: o.turn ?? 't-all', userId: o.user === undefined ? 'alice' : o.user, ...(o.egressKnown === undefined ? {} : { egressKnown: o.egressKnown }) })
const on = (user = 'alice') => expect(setWebAllowAll(db(), user, true, { via: 'settings' })).toBe(true)
const values = (a: Asked | undefined) => a?.options?.map((o) => o.value)
const audits = (action: string, target: string) => (db().query('SELECT actor_id, detail FROM audit_log WHERE action = ? AND target = ? ORDER BY id').all(action, target) as { actor_id: string | null; detail: string }[])
  .map((r) => ({ actor: r.actor_id, ...JSON.parse(r.detail ?? '{}') }))
/** a card's request as these tests read it (the union of card kinds has no common question / options) */
type Req = { requestId: string; question?: string; origin?: string; options?: { value: string }[] }
const req = (f: { data: { request: unknown } }) => f.data.request as Req
const put = (user: string, body: unknown) => h.req(user, '/api/me/web-access', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('the card', () => {
  test('off: the first card already offers it, with the risk sentence; never while the team does not allow it', async () => {
    const chat = await chatOf()
    const asked: Asked[] = []
    await gate(chat, 'https://first.example/page', person('allow', asked))
    expect(values(asked[0])).toEqual(['allow', 'site', ALL_SITES_ANSWER, 'deny'])
    expect(asked[0]!.options![2]!.label).toBe('Allow all websites (turn off in Settings)')
    expect(asked[0]!.question).toContain('If you allow all websites, the AI opens public websites without asking when you ask it, in your chats and in rooms')
    expect(asked[0]!.question).toContain('catches obvious tokens only')
    expect(asked[0]!.question).toContain(WEB_ALLOW_ALL_RISK.en)
    // the team key off, or the browser switch above it off: not offered
    for (const s of [{ webAllowAll: false }, { browserAllowAll: false }]) {
      updateTeamSettings(db(), { browserAllowAll: true, webAllowAll: true, ...s })
      const none: Asked[] = []
      await gate(chat, `https://off-${JSON.stringify(s).length}.example/`, person('allow', none))
      expect(values(none[0])).toEqual(['allow', 'site', 'deny'])
    }
  })

  test('the team key is on by default for a team that never set it (the owner\'s call)', () => {
    db().query("DELETE FROM settings WHERE key = 'webAllowAll'").run()
    expect(getTeamSettings(db()).webAllowAll).toBe(true)
  })

  test('picking it opens this address and turns the switch on: the stored warning version is the card\'s, audited, the windows told', async () => {
    const chat = await chatOf()
    const asked: Asked[] = []
    let told = 0
    expect(await gate(chat, 'https://third.example/a', person(ALL_SITES_ANSWER, asked, { changed: () => told++ }), { turn: 'pick' })).toBe('confirmed')
    expect(asked[0]!.question).toContain(WEB_ALLOW_ALL_RISK.en)
    expect(webAllowAll(db(), 'alice')).toBe(true)
    expect(told).toBe(1)
    expect(db().query('SELECT allow_all, warning, via, turn_id FROM user_web_access WHERE user_id = ?').get('alice')).toEqual({ allow_all: 1, warning: WEB_ALLOW_ALL_WARNING_VERSION, via: 'card', turn_id: 'pick' })
    expect(audits('web.allow_all_on', 'alice').at(-1)).toEqual({ actor: 'alice', via: 'card', warningVersion: WEB_ALLOW_ALL_WARNING_VERSION, turnId: 'pick' })
    // from now on an ordinary address of any site opens without a card
    const none: Asked[] = []
    expect(await gate(chat, 'https://another-site.example/b', person(null, none), { turn: 'pick' })).toBe('all')
    expect(none).toHaveLength(0)
  })

  test('the team turned it off while the card was open: the address opens, the switch stays off', async () => {
    const chat = await chatOf()
    const p = person(ALL_SITES_ANSWER)
    const choose = p.choose!
    p.choose = async (q, opts, e) => { updateTeamSettings(db(), { webAllowAll: false }); return choose(q, opts, e) }
    expect(await gate(chat, 'https://race.example/a', p, { turn: 'race' })).toBe('confirmed')
    // nothing was written under the old policy: allowing again does not bring it back
    expect(db().query('SELECT allow_all FROM user_web_access WHERE user_id = ?').get('alice')).toEqual({ allow_all: 0 })
    updateTeamSettings(db(), { webAllowAll: true })
    expect(webAllowAll(db(), 'alice')).toBe(false)
  })
})

describe('with the switch on', () => {
  test('ordinary addresses open without a card: written by the AI, and learned links past the link budget', async () => {
    on()
    const chat = await chatOf()
    const asked: Asked[] = []
    expect(await gate(chat, 'https://written.example/page?q=short', person(null, asked))).toBe('all')
    const learned = Array.from({ length: 40 }, (_, i) => `https://learned.example/p${i}`)
    rememberUrls(db(), chat, learned)
    for (const u of learned) expect(['seen', 'all']).toContain(await gate(chat, u, person(null, asked), { turn: 'learn' }))
    expect(asked).toHaveLength(0)
  })

  test('still a card for every exception', async () => {
    on()
    const chat = await chatOf()
    for (const u of [
      'https://x.example/doc/aB3dE5fG7hJ9kL1mN3pQ5rT',
      'https://abcdefghijklmnopqrstuvwxyz.x.example/',
      'https://user:pw@x.example/',
      `https://x.example/?q=${'a'.repeat(201)}`,
      'https://203.0.113.9/x',
      'http://intranet/',
      'https://github.io/',
    ]) {
      const asked: Asked[] = []
      await expect(gate(chat, u, person(null, asked))).rejects.toThrow(/did not allow/)
      expect(asked).toHaveLength(1)
    }
    // the server's exit address unknown (web_fetch and save_url pass it; the browser tools never do)
    const asked: Asked[] = []
    await expect(gate(chat, 'https://plain.example/', person(null, asked), { egressKnown: false })).rejects.toThrow(/did not allow/)
    expect(asked).toHaveLength(1)
    // a confidential chat
    const secret = await chatOf()
    db().query('INSERT OR IGNORE INTO safe_ops_chats (chat_id) VALUES (?)').run(secret)
    const conf: Asked[] = []
    await expect(gate(secret, 'https://plain.example/', person(null, conf))).rejects.toThrow(/did not allow/)
    expect(conf).toHaveLength(1)
  })

  test('an echo asks, under a site allowed in the chat (①b) and under the switch (①d)', async () => {
    on()
    const chat = await chatOf()
    allowSite(db(), chat, 'alice', 'echo-site.example', null)
    rememberUrls(db(), chat, ['https://echo-site.example/out?d=hello', 'https://other-echo.example/p?d=hello'], 'fetched', () => true)
    for (const u of ['https://echo-site.example/out?d=hello', 'https://other-echo.example/p?d=hello']) {
      const asked: Asked[] = []
      await expect(gate(chat, u, person(null, asked))).rejects.toThrow(/did not allow/)
      // the echo card's words (#348: plain words in cards)
      expect(asked[0]!.question).toContain('contains something the AI sent earlier')
      expect(values(asked[0]) ?? []).not.toContain(ALL_SITES_ANSWER)
    }
    // a plain address of the allowed site still opens through ①b
    expect(await gate(chat, 'https://echo-site.example/plain', person(null))).toBe('site')
  })

  test('a run nobody watches does not use it, and says so', async () => {
    on()
    const chat = await chatOf()
    await expect(gate(chat, 'https://unattended.example/', person(null, [], { unattended: true }))).rejects.toThrow(/does not apply in a run the user does not answer step by step/)
    await expect(gate(chat, 'https://unattended.example/', null)).rejects.toThrow(/nobody can confirm/)
  })
})

describe('always the caller\'s own switch', () => {
  test('a chat others write in: the switch of the person whose turn it is, never the chat owner\'s or another member\'s', async () => {
    const chat = await chatOf('alice')
    db().query("INSERT INTO messages (id, chat_id, role, author_id, content, status) VALUES (?, ?, 'user', 'bob', 'hi', 'done')").run(uuidv7(), chat)
    // the chat's owner (alice) has it on; bob's turn in her chat does not get it
    on('alice')
    const asked: Asked[] = []
    await expect(gate(chat, 'https://shared-chat.example/a', person(null, asked), { user: 'bob' })).rejects.toThrow(/did not allow/)
    expect(asked).toHaveLength(1)
    // bob's own switch counts for bob's turn, whoever owns the chat; alice's turn without hers asks
    on('bob')
    setWebAllowAll(db(), 'alice', false, { via: 'settings' })
    expect(await gate(chat, 'https://shared-chat.example/b', person(null), { user: 'bob' })).toBe('all')
    await expect(gate(chat, 'https://shared-chat.example/c', person(null), { user: 'alice' })).rejects.toThrow(/did not allow/)
  })

  test('a room: @트리나 asked by Alice (on) opens without a card; asked by Bob (off) in the same room, a card', async () => {
    on('alice')
    const g = await h.api('dana').call(API.createGroup, { body: { name: `web-all-${uuidv7().slice(-6)}`, memberIds: ['alice', 'bob'] } })
    const room = (await h.api('alice').call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)!.id
    const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d).replace(/\//g, '\\u002f')).join('\n')
    const ask = (user: string, url: string) => h.api(user).call(API.sendRoomMessage, { params: { id: room }, body: { body: `@트리나 read it\n${fake({ tool: 'web_fetch', args: { url } }, { say: 'done' })}`, clientMessageId: 'cm-' + crypto.randomUUID(), mentions: [], fileIds: [] } })
    const qa = await ask('alice', 'https://room-alice.example/a')
    await alice.next('room.ai.run', (f) => f.data.run.questionId === qa.id && ['done', 'error', 'stopped'].includes(f.data.run.state), 30_000)
    expect(alice.frames.filter((f) => f.type === 'turn.request')).toEqual([])
    expect(looked('room-alice.example')).toBe(1)
    const qb = await ask('bob', 'https://room-bob.example/a')
    const card = await bob.next('turn.request', (f) => String(req(f).question ?? '').includes('room-bob.example'), 20_000)
    expect(looked('room-bob.example')).toBe(0)
    // Bob's own card offers Bob's own switch
    expect(req(card).options!.map((o) => o.value)).toContain(ALL_SITES_ANSWER)
    await h.api('bob').call(API.answerTurn, { params: { id: card.data.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'deny' } })
    await bob.next('room.ai.run', (f) => f.data.run.questionId === qb.id && ['done', 'error', 'stopped'].includes(f.data.run.state), 30_000)
    expect(webAllowAll(db(), 'bob')).toBe(false)
  })
})

describe('only the person turns it on', () => {
  test('Settings: the risk sentence accepted, the team allowing it; off always works; the windows are told', async () => {
    expect((await put('alice', { on: true })).status).toBe(409)
    expect((await put('alice', { on: true, acceptWarning: WEB_ALLOW_ALL_WARNING_VERSION + 1 })).status).toBe(409)
    const ok = await put('alice', { on: true, acceptWarning: WEB_ALLOW_ALL_WARNING_VERSION })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ allowAll: true })
    await alice.next('notice', (f) => f.data.code === 'web_access_changed', 5000)
    const me = await h.api('alice').call(API.me)
    expect(me.user.webAllowAll).toBe(true)
    expect(me.team.webAllowAll).toBe(true)
    expect(audits('web.allow_all_on', 'alice').at(-1)).toMatchObject({ actor: 'alice', via: 'settings', warningVersion: WEB_ALLOW_ALL_WARNING_VERSION })
    expect(await (await put('alice', { on: false })).json()).toEqual({ allowAll: false })
    expect(audits('web.allow_all_off', 'alice').at(-1)).toMatchObject({ actor: 'alice', via: 'settings' })
    expect((await h.api('alice').call(API.me)).user.webAllowAll).toBeUndefined()
  })

  test('not while a password change is pending, and not through the profile preferences', async () => {
    expect(API.setMyWebAccess.allowWhilePasswordChange).toBeFalsy()
    const pending = { user: { id: 'alice', username: 'alice', name: 'Alice', role: 'member', locale: 'en', mustChangePassword: true }, session: { id: 's', client: 'web' }, via: 'cookie' } as unknown as Parameters<typeof enforceAuth>[1]
    expect(() => enforceAuth(API.setMyWebAccess, pending)).toThrow()
    await h.api('alice').call(API.updateMe, { body: { prefs: { webAllowAll: true } as never } })
    expect(webAllowAll(db(), 'alice')).toBe(false)
    expect((await h.api('alice').call(API.me)).user.webAllowAll).toBeUndefined()
  })

  test("the AI's own card, typed text and another person's answer cannot turn it on", async () => {
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d).replace(/\//g, '\\u002f')).join('\n')
    const send = (content: string) => h.api('alice').call(API.sendMessage, { params: { id: chat }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    // the AI asks with the same answer value: the person's pick goes to the AI, nothing else
    const r1 = await send(fake({ tool: 'ask_user', args: { question: 'Allow all websites?', options: [{ label: 'Allow all websites (turn off in Settings)', value: ALL_SITES_ANSWER }] } }, { say: 'done' }))
    const own = await alice.next('turn.request', (f) => f.data.turnId === r1.turnId, 20_000)
    expect(req(own).origin).not.toBe('server')
    await h.api('alice').call(API.answerTurn, { params: { id: r1.turnId }, body: { kind: 'ask_user', requestId: own.data.request.requestId, answer: ALL_SITES_ANSWER } })
    await alice.next('message.done', (f) => f.data.messageId === r1.assistantMessage.id, 30_000)
    expect(webAllowAll(db(), 'alice')).toBe(false)
    // the server's address card that does not offer it (a random-looking part): that answer, typed text, another person
    const r2 = await send(fake({ tool: 'web_fetch', args: { url: 'https://card-only.example/doc/aB3dE5fG7hJ9kL1mN3pQ5rT' } }, { say: 'done' }))
    const card = await alice.next('turn.request', (f) => f.data.turnId === r2.turnId, 20_000)
    const answer = (who: string, value: unknown) => h.req(who, `/api/turns/${r2.turnId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ask_user', requestId: card.data.request.requestId, answer: value }) })
    expect(req(card).options!.map((o) => o.value)).not.toContain(ALL_SITES_ANSWER)
    expect((await answer('alice', ALL_SITES_ANSWER)).status).toBe(400)
    expect((await answer('alice', 'Allow all websites (turn off in Settings)')).status).toBe(400)
    expect((await answer('bob', ALL_SITES_ANSWER)).status).toBe(404)
    expect((await answer('alice', 'deny')).status).toBe(204)
    await alice.next('message.done', (f) => f.data.messageId === r2.assistantMessage.id, 30_000)
    expect(webAllowAll(db(), 'alice')).toBe(false)
    // the real card of a plain address offers it on the first card; the person's pick turns it on
    const r3 = await send(fake({ tool: 'web_fetch', args: { url: 'https://real-card.example/a' } }, { tool: 'web_fetch', args: { url: 'https://after-card.example/b' } }, { say: 'done' }))
    const real = await alice.next('turn.request', (f) => f.data.turnId === r3.turnId, 20_000)
    expect(req(real).options!.map((o) => o.value)).toEqual(['allow', 'site', ALL_SITES_ANSWER, 'deny'])
    expect(req(real).question).toContain(WEB_ALLOW_ALL_RISK.en)
    await h.api('alice').call(API.answerTurn, { params: { id: r3.turnId }, body: { kind: 'ask_user', requestId: real.data.request.requestId, answer: ALL_SITES_ANSWER } })
    await alice.next('message.done', (f) => f.data.messageId === r3.assistantMessage.id, 30_000)
    expect(webAllowAll(db(), 'alice')).toBe(true)
    await alice.next('notice', (f) => f.data.code === 'web_access_changed', 5000)
    // the second address of the same answer opened without a card
    expect(alice.frames.filter((f) => f.type === 'turn.request' && f.data.turnId === r3.turnId)).toHaveLength(1)
    expect(looked('after-card.example')).toBe(1)
    expect((db().query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'web_fetch' ORDER BY rowid").all(r3.turnId) as { summary: string }[]).length).toBe(2)
  })
})

describe('the team decides, race-free', () => {
  test('turning the key off turns everyone off (audited); PUT is refused; turning it on again leaves everyone off', async () => {
    on('alice')
    on('bob')
    const before = policyEpoch(db())
    expect((await h.req('alice', '/api/admin/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webAllowAll: false }) })).status).toBe(403)
    await h.api('dana').call(API.updateSettings, { body: { webAllowAll: false } })
    expect(policyEpoch(db())).toBe(before + 1)
    for (const u of ['alice', 'bob']) {
      expect(webAllowAll(db(), u)).toBe(false)
      expect(audits('web.allow_all_off', u).at(-1)).toEqual({ actor: 'dana', via: 'policy' })
    }
    expect((await h.api('alice').call(API.me)).team.webAllowAll).toBeUndefined()
    const refused = await put('alice', { on: true, acceptWarning: WEB_ALLOW_ALL_WARNING_VERSION })
    expect(refused.status).toBe(409)
    expect((await refused.json()).error?.params?.reason).toBe('web_allow_all_off')
    await h.api('dana').call(API.updateSettings, { body: { webAllowAll: true } })
    for (const u of ['alice', 'bob']) expect(webAllowAll(db(), u)).toBe(false)
    // a row written under the old policy never counts (the epoch)
    db().query('UPDATE user_web_access SET allow_all = 1, warning = ?, epoch = ? WHERE user_id = ?').run(WEB_ALLOW_ALL_WARNING_VERSION, before, 'alice')
    expect(webAllowAll(db(), 'alice')).toBe(false)
    // the browser switch above it off does the same
    on('bob')
    await h.api('dana').call(API.updateSettings, { body: { browserAllowAll: false } })
    expect(webAllowAll(db(), 'bob')).toBe(false)
    expect(policyEpoch(db())).toBe(before + 2)
  })

  test('implicit off is audited: an older risk sentence, a deactivated account', async () => {
    on('alice')
    db().query('UPDATE user_web_access SET warning = ? WHERE user_id = ?').run(WEB_ALLOW_ALL_WARNING_VERSION - 1, 'alice')
    const n = audits('web.allow_all_off', 'alice').length
    expect(webAllowAll(db(), 'alice')).toBe(false)
    expect(webAllowAll(db(), 'alice')).toBe(false)
    expect(audits('web.allow_all_off', 'alice').slice(n)).toEqual([{ actor: null, via: 'warning', warningVersion: WEB_ALLOW_ALL_WARNING_VERSION - 1, current: WEB_ALLOW_ALL_WARNING_VERSION }])
    on('erin')
    await h.api('carol').call(API.updateUser, { params: { id: 'erin' }, body: { status: 'disabled' } })
    try {
      expect(audits('web.allow_all_off', 'erin').at(-1)).toEqual({ actor: 'carol', via: 'account' })
      expect(webAllowAll(db(), 'erin')).toBe(false)
    } finally {
      await h.api('carol').call(API.updateUser, { params: { id: 'erin' }, body: { status: 'active' } })
    }
    expect(webAllowAll(db(), 'erin')).toBe(false)
  })
})

describe('save_url uses the same rule for its address', () => {
  test('on: a plain address passes the check without a card (then the stub resolves nothing)', async () => {
    on()
    const chat = await chatOf()
    const turnId = uuidv7()
    db().query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, ?, 'alice', 'claude-code', 'running')").run(turnId, chat)
    const asked: Asked[] = []
    const r = await toolRegistry(h.ctx.files).call('save_url', { url: 'https://files.save-all.example/a.png', save_as: 'users/alice/a.png' }, { user: h.ctx.files.principal('alice'), turnId, files: new TurnFiles(), person: person(null, asked) })
    expect(asked).toHaveLength(0)
    expect(r.text).toMatch(/resolve|files\.save-all\.example/)
    expect(looked('files.save-all.example')).toBe(1)
  })
})

describe('the real rule of which turns use it (chat/tools.ts turnPerson allSitesHere)', () => {
  const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d).replace(/\//g, '\\u002f')).join('\n')
  /** a real turn of alice's with this client kind that fetches `url` (written so it is not typed in the message) */
  async function turnWith(clientKind: string | null, url: string, o: { draft?: boolean } = {}) {
    const id = (await h.api('alice').call(API.createChat, { body: {} })).id as string
    if (o.draft) db().query("INSERT INTO onboarding_profile_drafts (chat_id, user_id, source, website, site, created_at) VALUES (?, 'alice', 'website', 'https://draft-scope.example/', 'draft-scope.example', ?)").run(id, new Date().toISOString())
    const row = h.rt().store.chatRow(id)!
    return h.rt().createTurn({ chat: row, userId: 'alice', locale: 'en', windowId: null, clientKind, engine: row.engine as 'claude-code', model: null,
      user: { parentId: row.active_leaf_id, content: fake({ tool: 'web_fetch', args: { url } }, { say: 'done' }), attachments: [], clientMessageId: 'cm-' + crypto.randomUUID() } })
  }
  const summaries = (turnId: string) => (db().query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'web_fetch'").all(turnId) as { summary: string }[]).map((r) => r.summary).join('\n')
  const doneOf = (turnId: string) => alice.next('message.done', (f) => f.data.message.turnId === turnId, 30_000)

  test('a Slack question and a turn with no client kind: a card, without the fourth answer', async () => {
    on()
    for (const kind of ['slack', null]) {
      const host = `kind-${kind ?? 'none'}.example`
      const t = await turnWith(kind, `https://${host}/a`)
      const card = await alice.next('turn.request', (f) => f.data.turnId === t.turnId, 20_000)
      expect([kind, req(card).options!.map((o) => o.value)]).toEqual([kind, ['allow', 'site', 'deny']])
      expect(looked(host)).toBe(0)
      await h.api('alice').call(API.answerTurn, { params: { id: t.turnId }, body: { kind: 'ask_user', requestId: req(card).requestId, answer: 'deny' } })
      await doneOf(t.turnId)
    }
  })

  test('a scheduled run and a company-profile draft: refused without a card, saying the setting does not apply', async () => {
    on()
    const run = await turnWith('schedule', 'https://kind-schedule.example/a')
    await doneOf(run.turnId)
    expect(summaries(run.turnId)).toContain('does not apply in a run the user does not answer step by step')
    const draft = await turnWith('web', 'https://draft-scope.example/about', { draft: true })
    await doneOf(draft.turnId)
    expect(summaries(draft.turnId)).toContain('does not apply in a run the user does not answer step by step')
    for (const t of [run, draft]) expect(alice.frames.some((f) => f.type === 'turn.request' && f.data.turnId === t.turnId)).toBe(false)
    expect(looked('kind-schedule.example') + looked('draft-scope.example')).toBe(0)
  })

  test('web_fetch of a turn by someone who does not own the chat uses that person\'s switch (t.user.id)', async () => {
    const chat = await chatOf('alice')
    const fetchAs = (user: string, url: string, p: TurnPerson) => {
      const turnId = uuidv7()
      db().query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, ?, ?, 'claude-code', 'running')").run(turnId, chat, user)
      return toolRegistry(h.ctx.files).call('web_fetch', { url }, { user: h.ctx.files.principal(user), turnId, files: new TurnFiles(), person: p })
    }
    on('bob')
    const none: Asked[] = []
    const r = await fetchAs('bob', 'https://bob-turn.example/a', person(null, none))
    expect(none).toHaveLength(0)
    expect(r.text).toContain('could not resolve bob-turn.example')
    setWebAllowAll(db(), 'bob', false, { via: 'settings' })
    on('alice')
    const asked: Asked[] = []
    const r2 = await fetchAs('bob', 'https://bob-turn2.example/a', person(null, asked))
    expect(asked).toHaveLength(1)
    expect(r2.isError).toBe(true)
    expect(looked('bob-turn2.example')).toBe(0)
  })
})

describe('notices and accounts', () => {
  /** a frame of `type` that came after `from` frames of the socket */
  async function after(sock: TestSocket, from: number, code: string) {
    const end = Date.now() + 5000
    for (;;) {
      if (sock.frames.slice(from).some((f) => f.type === 'notice' && f.data.code === code)) return true
      if (Date.now() > end) return false
      await Bun.sleep(50)
    }
  }
  test('the team key off: web_access_changed to the people who had it on, browser_policy_changed to everyone', async () => {
    on('alice')
    const a = alice.frames.length, b = bob.frames.length
    await h.api('dana').call(API.updateSettings, { body: { webAllowAll: false } })
    expect(await after(alice, a, 'web_access_changed')).toBe(true)
    expect(await after(bob, b, 'browser_policy_changed')).toBe(true)
    expect(bob.frames.slice(b).some((f) => f.type === 'notice' && f.data.code === 'web_access_changed')).toBe(false)
  })

  test('deleting a member turns the switch off, audited with the admin as actor', async () => {
    const u = await h.api('dana').call(API.createUser, { body: { username: `gone-${uuidv7().slice(-6)}`, name: 'Kim Sora', role: 'member', groupIds: [] } })
    const id = u.user.id
    on(id)
    await h.api('dana').call(API.deleteUser, { params: { id }, query: { personalFolder: 'delete' }, body: {} })
    expect(audits('web.allow_all_off', id).at(-1)).toEqual({ actor: 'dana', via: 'account' })
    expect(db().query('SELECT allow_all FROM user_web_access WHERE user_id = ?').get(id)).toEqual({ allow_all: 0 })
  })
})

