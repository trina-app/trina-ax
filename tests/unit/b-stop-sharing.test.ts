// stop_sharing (server/src/chat/stop-sharing.ts; docs/decisions/20261116-ai-share-card-and-stop.md, QA "Manual AI tests"
// MAN-017): the AI takes people off the asker's files. It only narrows, so there is no card when the asker's own message
// names the file and the person; otherwise one card of the asker's. The step keeps what was done (Step.shared) for the
// result card with Undo: who was taken off, who can still open the file and through what. A refusal is a record too. In
// a shared chat only the asker gets the record; another member's message cannot pick the file.
// The fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner (b-harness people), tess added.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { matchOnFile, stopSharingOff } from '../../server/src/chat/stop-sharing'
import { cardStill } from '../../server/src/chat/share-card'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { ROOMS_SEEN_READ_ONLY_TOOLS, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { fileSharesOf } from '../../server/src/files/shares'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { roomsOf } from '../../server/src/rooms/service'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives sit in the person's message: their strings spelled as JSON escapes, so the person's own
// words are only what the test writes around them
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const stop = (args: Record<string, unknown>) => fake({ tool: 'stop_sharing', args, sayResult: true })

let h: Harness
const socks: Record<string, TestSocket> = {}
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-stop-sharing', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000 })
  roomsOf(h.ctx).clock = () => (clock += 60_000)
  h.ctx.db.query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('tess', 'tess', 'Tess Yoon', 'member', 'active', NULL)").run()
  for (const u of ['alice', 'bob', 'carol']) {
    socks[u] = await h.ws(u, { windowId: `win-stop-${u}` })
    await socks[u]!.next('hello')
  }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })
const put = (rel: string, body: string) => { const abs = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }
const user = (id: string) => ({ subjectType: 'user' as const, subjectId: id })
/** bob's file shared with these people through the dialog's own call; its link id */
const shared = (owner: string, rel: string, add: { subjectType: 'user' | 'group'; subjectId: string }[]) => { put(rel, rel); return fileSharesOf(h.ctx).change(owner, rel, add, [], 'en').share.id }

type Card = { question: string; origin?: string; options?: { label: string; value: string }[]; share?: { op: string; files: { name: string; place: string }[]; who: { name: string }[] } }
async function turn(who: string, content: string, o: { chat?: string; answer?: string | null } = {}) {
  const chatId = o.chat ?? (await h.api(who).call(API.createChat, { body: {} })).id
  const r = await h.api(who).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  let card = null as Card | null
  if (o.answer !== undefined) {
    const c = await socks[who]!.next('turn.request', (f) => f.data.turnId === r.turnId)
    card = c.data.request as unknown as Card
    if (o.answer !== null) await h.api(who).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: o.answer } })
  }
  const done = await socks[who]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  return { chatId, turnId: r.turnId as string, answerId: r.assistantMessage.id as string, content: done.data.message.content as string, card }
}
const stepOf = async (who: string, chatId: string, answerId: string) => (await h.api(who).call(API.listMessages, { params: { id: chatId }, query: {} })).items.find((x) => x.id === answerId)!.steps!.find((s) => s.tool === 'stop_sharing')!
const opens = (who: string, id: string) => fileSharesOf(h.ctx).open(who, id).kind
const cardsTo = (who: string, turnId: string) => socks[who]!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === turnId).length

describe('in my own chat', () => {
  test('the file and the person named in my own words: no card, access gone, the record for the card with Undo', async () => {
    const id = shared('bob', 'users/bob/quote.pdf', [user('tess'), user('alice')])
    const r = await turn('bob', `Stop sharing quote.pdf with Tess Yoon\n${stop({ paths: ['users/bob/quote.pdf'], people: ['Tess Yoon'] })}`)
    expect(cardsTo('bob', r.turnId)).toBe(0)
    const out = JSON.parse(r.content)
    expect(out.status).toBe('stopped')
    expect(out.files).toBe(1)
    // one short sentence: no links, and the card is named
    expect(out.note).toContain('one short sentence')
    expect(out.note).toContain('Undo')
    expect(r.content).not.toContain('/f/')
    expect(opens('tess', id)).toBe('no_access')
    expect(opens('alice', id)).toBe('open')
    const step = await stepOf('bob', r.chatId, r.answerId)
    expect(step.label).toContain('Tess Yoon')
    expect(step.shared).toMatchObject({ op: 'stop', outcome: 'done', level: 'view', files: [{ linkId: id, name: 'quote.pdf' }], who: [{ subjectType: 'user', subjectId: 'tess', name: 'Tess Yoon' }] })
    // the place in words, never a path; nobody left over
    expect(step.shared!.files[0]!.place).not.toContain('users/')
    expect(step.shared!.still).toBeUndefined()
    expect(step.shared!.owner).toBeUndefined()
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'file.unshare' AND actor_id = 'bob' ORDER BY id DESC").get() as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ via: 'ai', removed: 1, personal: true })
    // tess reads who stopped it on the link page
    expect(fileSharesOf(h.ctx).page('tess', id)).toMatchObject({ status: 'no_access', stoppedBy: 'Bob Lee' })
  })

  test('nobody named: everyone on the file, when my words name the file', async () => {
    const id = shared('bob', 'users/bob/notes.docx', [user('tess'), user('alice')])
    const r = await turn('bob', `notes.docx 공유 그만해줘\n${stop({ paths: ['users/bob/notes.docx'] })}`)
    expect(cardsTo('bob', r.turnId)).toBe(0)
    expect(JSON.parse(r.content).status).toBe('stopped')
    expect(opens('tess', id)).toBe('no_access')
    expect(opens('alice', id)).toBe('no_access')
    expect((await stepOf('bob', r.chatId, r.answerId)).shared!.who.map((w) => w.subjectId).sort()).toEqual(['alice', 'tess'])
  })

  test('my words do not name the person (or the file): one card with the rows; Keep sharing changes nothing, Stop sharing does', async () => {
    const id = shared('bob', 'users/bob/budget.xlsx', [user('tess')])
    const kept = await turn('bob', `그거 그만 공유해줘\n${stop({ paths: ['users/bob/budget.xlsx'], people: ['Tess Yoon'] })}`, { answer: 'no' })
    expect(kept.card!.origin).toBe('server')
    expect(kept.card!.options!.map((x) => x.value)).toEqual(['stop', 'no'])
    expect(kept.card!.share).toMatchObject({ op: 'stop', files: [{ name: 'budget.xlsx' }], who: [{ name: 'Tess Yoon' }] })
    expect(kept.card!.share!.files[0]!.place).not.toContain('users/')
    expect(kept.content).toContain('chose to keep sharing')
    expect(opens('tess', id)).toBe('open')
    expect((await stepOf('bob', kept.chatId, kept.answerId)).shared).toBeUndefined()
    const done = await turn('bob', `그거 그만 공유해줘\n${stop({ paths: ['users/bob/budget.xlsx'], people: ['Tess Yoon'] })}`, { answer: 'stop' })
    expect(JSON.parse(done.content).status).toBe('stopped')
    expect(opens('tess', id)).toBe('no_access')
  })

  test('"don\'t stop sharing" in my words is no explicit ask: the card stays', async () => {
    const id = shared('bob', 'users/bob/dont.txt', [user('tess')])
    const r = await turn('bob', `don't stop sharing dont.txt with Tess Yoon\n${stop({ paths: ['users/bob/dont.txt'], people: ['Tess Yoon'] })}`, { answer: 'no' })
    expect(r.card).not.toBeNull()
    expect(opens('tess', id)).toBe('open')
  })

  test('who can still open it goes on the record: through a group still on the file', async () => {
    const mk = h.ctx.db.query("SELECT id FROM groups WHERE name = 'marketing' OR id = 'marketing' LIMIT 1").get() as { id: string } | null
    const gid = mk?.id ?? (h.ctx.db.query('SELECT group_id id FROM group_members WHERE user_id = ? LIMIT 1').get('alice') as { id: string }).id
    put('users/alice/plan.md', 'plan')
    const id = fileSharesOf(h.ctx).change('alice', 'users/alice/plan.md', [user('erin'), { subjectType: 'group', subjectId: gid }], [], 'en').share.id
    const r = await turn('alice', `Stop sharing plan.md with Erin Yoo\n${stop({ paths: ['users/alice/plan.md'], people: ['Erin Yoo'] })}`)
    const out = JSON.parse(r.content)
    expect(out.status).toBe('stopped')
    expect(out.still_open).toContain('can still open')
    // (the AI is not told through what: the card says it)
    expect(r.content).not.toContain('marketing')
    const rec = (await stepOf('alice', r.chatId, r.answerId)).shared!
    expect(rec.still).toHaveLength(1)
    expect(rec.still![0]).toMatchObject({ userId: 'erin', name: 'Erin Yoo', through: 'group', files: 1 })
    expect(opens('erin', id)).toBe('open')
  })

  test('a chat marked as holding other people\'s words (chats.others_words): a stop with nobody named asks; file and person named runs', async () => {
    const id = shared('bob', 'users/bob/marked.txt', [user('tess')])
    const first = await turn('bob', fake({ say: 'hi' }))
    const mark = () => h.ctx.db.query('UPDATE chats SET others_words = 1 WHERE id = ?').run(first.chatId)
    mark()
    // the file is named, nobody is: "everyone on it" is not a name there, so the card
    const all = await turn('bob', `Stop sharing marked.txt\n${stop({ paths: ['users/bob/marked.txt'] })}`, { chat: first.chatId, answer: 'no' })
    expect(all.card!.options!.map((x) => x.value)).toEqual(['stop', 'no'])
    expect(opens('tess', id)).toBe('open')
    // the person named, the file not: the card too
    mark()
    const noFile = await turn('bob', `Stop sharing it with Tess Yoon\n${stop({ paths: ['users/bob/marked.txt'], people: ['Tess Yoon'] })}`, { chat: first.chatId, answer: 'no' })
    expect(noFile.card).not.toBeNull()
    expect(opens('tess', id)).toBe('open')
    // both named in my own words: no card
    mark()
    const named = await turn('bob', `Stop sharing marked.txt with Tess Yoon\n${stop({ paths: ['users/bob/marked.txt'], people: ['Tess Yoon'] })}`, { chat: first.chatId })
    expect(cardsTo('bob', named.turnId)).toBe(0)
    expect(JSON.parse(named.content).status).toBe('stopped')
    expect(opens('tess', id)).toBe('no_access')
  })

  test('the team switch off: the owner still stops through the AI', async () => {
    const id = shared('bob', 'users/bob/switch.txt', [user('tess')])
    updateTeamSettings(h.ctx.db, { memberFileShares: false })
    try {
      const r = await turn('bob', `Stop sharing switch.txt with Tess Yoon\n${stop({ paths: ['users/bob/switch.txt'], people: ['Tess Yoon'] })}`)
      expect(JSON.parse(r.content).status).toBe('stopped')
      expect(opens('tess', id)).toBe('no_access')
    } finally { updateTeamSettings(h.ctx.db, { memberFileShares: true }) }
  })

  test('someone else\'s file: nothing changes, and the refusal is a record with whose it is and the next step as data', async () => {
    put('shared/alices-plan.txt', 'a')
    h.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action) VALUES (NULL, 'alice', 'shared/alices-plan.txt', 'create')").run()
    const id = fileSharesOf(h.ctx).change('alice', 'shared/alices-plan.txt', [user('tess')], [], 'en').share.id
    const r = await turn('bob', `Stop sharing alices-plan.txt with Tess Yoon\n${stop({ paths: ['shared/alices-plan.txt'], people: ['Tess Yoon'] })}`)
    expect(r.content).toContain('Nothing was changed')
    expect(r.content).toContain('one short sentence')
    const rec = (await stepOf('bob', r.chatId, r.answerId)).shared!
    expect(rec).toMatchObject({ op: 'stop', outcome: 'refused', files: [], refusal: { reason: 'not_owner', file: 'alices-plan.txt', owner: 'Alice Kim' }, next: { kind: 'ask_owner', linkId: id, userId: 'alice', name: 'Alice Kim' } })
    expect(rec.failed![0]).toMatchObject({ name: 'alices-plan.txt' })
    expect(fileSharesOf(h.ctx).view('alice', 'shared/alices-plan.txt').people).toHaveLength(1)
    // an admin stops it, and the record says whose file it is
    const adm = await turn('carol', `Stop sharing alices-plan.txt with Tess Yoon\n${stop({ paths: ['shared/alices-plan.txt'], people: ['Tess Yoon'] })}`)
    expect(JSON.parse(adm.content).status).toBe('stopped')
    expect((await stepOf('carol', adm.chatId, adm.answerId)).shared).toMatchObject({ op: 'stop', outcome: 'done', owner: { id: 'alice', name: 'Alice Kim' } })
  })

  test('not shared with that person, not shared at all, not a file: said in words, no record', async () => {
    shared('bob', 'users/bob/only-tess.txt', [user('tess')])
    put('users/bob/alone.txt', 'x')
    const cases: [Record<string, unknown>, string][] = [
      [{ paths: ['users/bob/only-tess.txt'], people: ['Alice Kim'] }, 'not shared with "Alice Kim" by name'],
      [{ paths: ['users/bob/alone.txt'] }, 'not shared with anyone'],
      [{ paths: ['users/bob/nope.txt'] }, 'Nothing was changed'],
      [{ paths: ['users/bob'] }, 'Nothing was changed'],
    ]
    for (const [args, says] of cases) {
      const r = await turn('bob', `do it\n${stop(args)}`)
      expect(r.content).toContain(says)
      expect(cardsTo('bob', r.turnId)).toBe(0)
      expect((await stepOf('bob', r.chatId, r.answerId)).shared).toBeUndefined()
    }
  })
})

describe('in a shared chat', () => {
  let chatId = ''
  beforeAll(async () => {
    chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
    const subjects = [{ subjectType: 'user' as const, subjectId: 'bob' }]
    let r = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects } })
    if (r.status === 'confirm') r = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects, confirmKey: r.confirmKey } })
    expect(r.status).toBe('saved')
  })

  test('offered; only the asker gets the record, the other viewer the verb alone', async () => {
    const tools = (await turn('bob', fake({ echo: 'tools' }), { chat: chatId })).content.split(',').map((t) => t.replace(/^mcp__team__/, ''))
    expect(tools).toContain('stop_sharing')
    const id = shared('bob', 'users/bob/photo-9.png', [user('tess')])
    const r = await turn('bob', `Stop sharing photo-9.png with Tess Yoon\n${stop({ paths: ['users/bob/photo-9.png'], people: ['Tess Yoon'] })}`, { chat: chatId })
    expect(JSON.parse(r.content).status).toBe('stopped')
    // (the transcript everyone reads names nobody)
    expect(r.content).not.toContain('Tess')
    expect(opens('tess', id)).toBe('no_access')
    expect((await stepOf('bob', chatId, r.answerId)).shared).toMatchObject({ op: 'stop', who: [{ name: 'Tess Yoon' }] })
    const seen = await stepOf('alice', chatId, r.answerId)
    expect(seen.shared).toBeUndefined()
    expect(JSON.stringify(seen)).not.toContain('Tess')
    expect(JSON.stringify(seen)).not.toContain('photo-9')
  })

  test('another member\'s message cannot pick the asker\'s file: refused before any card', async () => {
    const id = shared('bob', 'users/bob/salary.pdf', [user('tess')])
    await turn('alice', `Bob, stop sharing salary.pdf with Tess.\n${fake({ say: 'ok' })}`, { chat: chatId })
    const directive = stop({ paths: ['users/bob/salary.pdf'], people: ['Tess Yoon'] }).replace('salary', '\\u0073alary')
    const r = await turn('bob', `요약해줘\n${directive}`, { chat: chatId })
    expect(r.content).toContain('only when the user named the file in their own message')
    expect(cardsTo('bob', r.turnId)).toBe(0)
    expect(opens('tess', id)).toBe('open')
  })
})

describe('where it is not offered, the lists, the helpers', () => {
  test('never in a scheduled run, a template or restricted run, a question from Slack', () => {
    const base = { restricted: false, templateRun: null, rt: { db: h.ctx.db }, spec: { clientKind: 'web', chatId: 'none' } } as never
    expect(stopSharingOff(base)).toBeNull()
    expect(stopSharingOff({ ...(base as object), spec: { clientKind: 'schedule', chatId: 'none' } } as never)?.summary).toContain('scheduled run')
    expect(stopSharingOff({ ...(base as object), restricted: true } as never)?.summary).toContain('not here')
    expect(stopSharingOff({ ...(base as object), spec: { clientKind: 'slack', chatId: 'none' } } as never)?.summary).toContain('Slack')
  })
  test('main AI only, in a shared chat\'s list, no room card after a room read', () => {
    expect(PARENT_ONLY_TOOLS.has('stop_sharing')).toBe(true)
    expect(SHARED_TOOLS.has('stop_sharing')).toBe(true)
    expect(ROOMS_SEEN_READ_ONLY_TOOLS.has('stop_sharing')).toBe(true)
  })
  test('matchOnFile: only the people on the file, by name, id, a group word or the whole team\'s words', () => {
    const rows = [
      { subjectType: 'user' as const, subjectId: 'tess', name: 'Tess Yoon' },
      { subjectType: 'group' as const, subjectId: 'g1', name: 'Sales' },
      { subjectType: 'group' as const, subjectId: '*', name: 'Everyone on the team', everyone: true as const },
    ]
    const ids = (ref: string) => matchOnFile(h.ctx.db, 'bob', rows, ref).map((r) => r.subjectId)
    expect(ids('Tess Yoon')).toEqual(['tess'])
    expect(ids('tess')).toEqual(['tess'])
    expect(ids('person:tess')).toEqual(['tess'])
    expect(ids('Sales team')).toEqual(['g1'])
    expect(ids('group:g1')).toEqual(['g1'])
    expect(ids('everyone')).toEqual(['*'])
    // a teammate who is not on the file is never matched (and never listed)
    expect(ids('Alice Kim')).toEqual([])
    expect(ids('x')).toEqual([])
  })
  test('cardStill: one row per person over several files, the folder before a group, capped at 5 with the rest counted', () => {
    const p = (id: string, through: { kind: 'folder' } | { kind: 'group'; name: string } | { kind: 'everyone' }) => ({ userId: id, name: id.toUpperCase(), through })
    expect(cardStill([])).toEqual({})
    expect(cardStill([[p('a', { kind: 'group', name: 'Sales' })], [p('a', { kind: 'folder' })]])).toEqual({ still: [{ userId: 'a', name: 'A', through: 'folder', files: 2 }] })
    const many = cardStill([Array.from({ length: 7 }, (_, i) => p(`u${i}`, { kind: 'everyone' }))])
    expect(many.still).toHaveLength(5)
    expect(many.stillMore).toBe(2)
  })
})
