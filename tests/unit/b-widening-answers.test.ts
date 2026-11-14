// The widening list (docs/DECISIONS.md "People who see a shared chat later: nothing new is hidden", chat/widening.ts,
// POST /api/sharing/widening-answers) and the count in the Members dialog's dry run (ProjectAccessPreview.hiddenAnswers).
// A team project of alice's with erin in it; its shared chats' answers are written straight into the database (the
// engine is not the point). bob (finance) is the person being added: he cannot open groups/marketing. alice (marketing)
// reads it but not groups/finance; erin's own folder is hers alone. Covered: places named only where the caller may
// open them, answers hidden from the caller left out, older answers no card covered left out (they stay hidden from bob
// anyway), the count and the list agree, pages and the signed cursor, who may ask, and the migration's y backfill.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiError, uuidv7, type ChatAudienceSubject, type WideningAnswers } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { setHiddenAnswersCutover } from '../../server/src/chat/shared-answers'
import { answerPreview } from '../../server/src/chat/widening'
import type { ReadGroup } from '../../server/src/chat/shared-answers'

setDefaultTimeout(60_000)
let h: Harness
let projectId: string
const CUT = '2026-06-01T00:00:00.000Z'
const before = (n: number) => new Date(Date.parse(CUT) - (1000 - n) * 60_000).toISOString()
const after = (n: number) => new Date(Date.parse(CUT) + n * 60_000).toISOString()
const MKT = { type: 'folder', id: 'f_groups_marketing' } as const
const FIN = { type: 'folder', id: 'f_groups_finance' } as const
const ERIN_OWN = { type: 'user', id: 'erin' } as const

beforeAll(async () => {
  h = await startHarness({ name: 'b-widening-answers' })
  projectId = (await h.api('alice').call(API.createProject, { body: { name: 'Widen', participants: [{ subjectType: 'user', subjectId: 'erin' }], instructions: '' } })).id
  setHiddenAnswersCutover(h.ctx.db, CUT)
})
afterAll(async () => { await h.close() })

const db = () => h.ctx.db
let n = 0
/** a shared chat of the project (alice's), titled */
function sharedChat(title: string): string {
  const id = uuidv7(), now = new Date().toISOString()
  db().query('INSERT INTO chats (id, user_id, project_id, shared_at, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'alice', projectId, now, title, now, now)
  return id
}
/** a question and its answer by `runner` at `at`, with its record */
function answer(chatId: string, runner: string, at: string, content: string, reads: ReadGroup[] | null): string {
  const q = uuidv7(), a = uuidv7(), turn = uuidv7()
  db().query("INSERT INTO messages (id, chat_id, role, author_id, content, status, created_at) VALUES (?, ?, 'user', ?, 'q', 'done', ?)").run(q, chatId, runner, at)
  db().query("INSERT INTO turns (id, chat_id, user_id, engine, status, message_id) VALUES (?, ?, ?, 'claude-code', 'done', ?)").run(turn, chatId, runner, a)
  db().query("INSERT INTO messages (id, chat_id, parent_id, role, content, status, turn_id, created_at) VALUES (?, ?, ?, 'assistant', ?, 'done', ?, ?)").run(a, chatId, q, content, turn, at)
  if (reads) db().query('INSERT INTO shared_answer_reads (message_id, chat_id, reads) VALUES (?, ?, ?)').run(a, chatId, JSON.stringify(reads))
  n++
  return a
}
const addBob: ChatAudienceSubject[] = [{ subjectType: 'user', subjectId: 'erin' }, { subjectType: 'user', subjectId: 'bob' }]
const list = (user: string, body: Partial<{ add: typeof addBob; cursor: string; limit: number }> = {}) =>
  h.api(user).call(API.wideningAnswers, { body: { target: { kind: 'project', projectId }, add: addBob, ...body } }) as Promise<WideningAnswers>
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }

describe('what is listed', () => {
  const ids: Record<string, string> = {}
  beforeAll(() => {
    const c1 = sharedChat('Q3 budget questions'), c2 = sharedChat('Supplier review')
    const ae = ['alice', 'erin']
    // (made in time order: the list goes by when they were made)
    // old, silent group: stays hidden from bob anyway: not listed
    ids.oldSilent = answer(c1, 'alice', before(1), 'old silent', [{ c: ae, s: [MKT] }])
    // old, a card's yes: covered, bob will see it: listed
    ids.oldYes = answer(c1, 'alice', before(2), 'old yes', [{ c: ae, s: [MKT], y: 1 }])
    // old, x: not listed
    ids.oldX = answer(c1, 'alice', before(3), 'old x', [{ c: ae, s: [MKT], x: 1 }])
    // old, hidden from alice (erin's own folder, no card, alice not in c): not listed although bob misses it
    ids.oldHiddenFromAlice = answer(c2, 'erin', before(4), 'OLD-HIDDEN-FROM-ALICE', [{ c: ['erin'], s: [ERIN_OWN] }])
    // new, silent, marketing: listed, place named (alice reads it)
    ids.newMkt = answer(c1, 'alice', after(1), '## The **finance** draft\nputs Q3 at 41 % over', [{ c: ae, s: [MKT] }])
    // new, marketing and finance: listed; finance is a place alice can't open
    ids.newBoth = answer(c2, 'erin', after(2), 'Two contracts renew in December', [{ c: ae, s: [MKT, FIN] }])
    // new, only what bob reads: not listed
    ids.newFin = answer(c2, 'erin', after(3), 'finance only', [{ c: ae, s: [FIN] }])
    // new, erin's own folder (alice can't open it), and hidden from nobody: listed with "a place you can't open"
    ids.newOwn = answer(c1, 'erin', after(4), 'from erin own', [{ c: ae, s: [ERIN_OWN] }])
    // a chat that is not shared: never
    const priv = uuidv7(), now = new Date().toISOString()
    db().query('INSERT INTO chats (id, user_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(priv, 'alice', projectId, 'private', now, now)
    ids.priv = answer(priv, 'alice', after(5), 'private', [{ c: ['alice'], s: [MKT] }])
  })

  test('the list: newest first, places by name only where alice may open them, answers hidden from her or still hidden from bob left out', async () => {
    const r = await list('alice')
    expect(r.items.map((i) => i.messageId)).toEqual([ids.newOwn, ids.newBoth, ids.newMkt, ids.oldYes])
    expect(r.total).toBe(4)
    expect(r.totalCapped).toBe(false)
    expect(r.nextCursor).toBeNull()
    const by = Object.fromEntries(r.items.map((i) => [i.messageId, i]))
    expect(by[ids.newMkt]).toMatchObject({ chatTitle: 'Q3 budget questions', askedBy: { id: 'alice', name: 'Alice Kim' }, preview: 'The finance draft', places: [{ name: 'groups/marketing/' }], missedBy: ['Bob Lee'] })
    expect(by[ids.newBoth]!.places).toEqual([{ name: 'groups/marketing/' }])
    expect(by[ids.newOwn]!.places).toEqual([{ hidden: true }])
    expect(JSON.stringify(r)).not.toContain('OLD-HIDDEN-FROM-ALICE')
    expect(JSON.stringify(r)).not.toContain('groups/finance')
    expect(JSON.stringify(r)).not.toContain('users/erin')
  })

  test('the dry run counts the same answers; nobody new: nothing', async () => {
    const p = await h.api('alice').call(API.previewProjectAccess, { body: { projectId, participants: addBob } })
    expect(p.added).toBe(1)
    expect(p.hiddenAnswers).toBe(4)
    const none = await h.api('alice').call(API.previewProjectAccess, { body: { projectId, participants: [{ subjectType: 'user', subjectId: 'erin' }] } })
    expect(none.hiddenAnswers).toBeUndefined()
    expect((await list('alice', { add: [{ subjectType: 'user', subjectId: 'erin' }] })).items).toEqual([])
  })

  test('a group picked: named in missedBy only with several picks; the owner and admins who do not read it get nothing', async () => {
    // a group of alice's with bob in it (she may pick only her own groups)
    const g = await h.api('dana').call(API.createGroup, { body: { name: 'Ops', memberIds: ['alice', 'bob'] } })
    const r = await list('alice', { add: [{ subjectType: 'user', subjectId: 'erin' }, { subjectType: 'group', subjectId: g.id }] })
    expect(r.total).toBe(4)
    expect(r.items[0]!.missedBy).toEqual(['Ops'])
    // bob by name and through the group: both named
    const both = await list('alice', { add: [...addBob, { subjectType: 'group', subjectId: g.id }] })
    expect(both.items[0]!.missedBy.sort()).toEqual(['Bob Lee', 'Ops'])
    for (const u of ['carol', 'dana']) {
      const x = await list(u)
      expect([x.total, x.items.length]).toEqual([0, 0])
    }
  })
})

describe('pages, the cursor and who may ask', () => {
  test('pages of 20 with a signed cursor; another set of people or a changed cursor: 409 changed', async () => {
    const c = sharedChat('Many')
    for (let i = 0; i < 25; i++) answer(c, 'alice', after(100 + i), `many ${i}`, [{ c: ['alice', 'erin'], s: [MKT] }])
    const first = await list('alice')
    expect(first.items).toHaveLength(20)
    expect(first.total).toBe(29)
    expect(first.items[0]!.preview).toBe('many 24')
    const second = await list('alice', { cursor: first.nextCursor! })
    expect(second.items).toHaveLength(9)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map((i) => i.messageId)).size).toBe(29)
    const bad = Buffer.from(JSON.stringify({ r: '999999', m: 'x' })).toString('base64url')
    const e1 = await errOf(list('alice', { cursor: bad }))
    expect([e1.status, e1.body.params?.reason]).toEqual([409, 'changed'])
    const e2 = await errOf(list('alice', { cursor: first.nextCursor!, add: [...addBob, { subjectType: 'user', subjectId: 'carol' }] }))
    expect([e2.status, e2.body.params?.reason]).toEqual([409, 'changed'])
    const small = await list('alice', { limit: 5 })
    expect(small.items).toHaveLength(5)
  })

  test('erin sees the project but may not change its members: 403; bob does not see it: 404', async () => {
    const e = await errOf(list('erin'))
    expect([e.status, e.body.params?.reason]).toEqual([403, 'widening_not_allowed'])
    expect((await errOf(list('bob'))).status).toBe(404)
  })
})

describe('the preview line', () => {
  test('first line, Markdown stripped, at most 120 characters', () => {
    expect(answerPreview('```js\nx\n```')).toBe('x')
    expect(answerPreview('# Title with [a link](https://x.example) and `code`')).toBe('Title with a link and code')
    expect(answerPreview('- **bold** item')).toBe('bold item')
    const long = answerPreview('a'.repeat(300))
    expect(long.length).toBe(120)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('migration 351', () => {
  test("marks the groups of a turn whose read card was answered 'shared' with y (not x ones), writes the cutover once, adds the index", () => {
    const sql = fs.readFileSync(path.join(import.meta.dir, '../../server/migrations/351_b_hidden_answers_cutover.sql'), 'utf8')
    const update = sql.slice(sql.indexOf('UPDATE shared_answer_reads'), sql.indexOf(';', sql.indexOf('UPDATE shared_answer_reads')) + 1)
    const c = sharedChat('migration')
    const yes = answer(c, 'alice', before(10), 'yes', [{ c: ['alice'], s: [MKT] }, { c: ['alice'], s: [FIN], x: 1 }])
    const no = answer(c, 'alice', before(11), 'no', [{ c: ['alice'], s: [MKT] }])
    const turnOf = (id: string) => (db().query('SELECT turn_id t FROM messages WHERE id = ?').get(id) as { t: string }).t
    db().query("INSERT INTO audit_log (actor_id, action, target, detail) VALUES ('alice', 'chat.shared_read', ?, ?)").run(c, JSON.stringify({ decision: 'shared', turnId: turnOf(yes) }))
    db().query("INSERT INTO audit_log (actor_id, action, target, detail) VALUES ('alice', 'chat.shared_read', ?, ?)").run(c, JSON.stringify({ decision: 'declined', turnId: turnOf(no) }))
    db().query("INSERT INTO audit_log (actor_id, action, target, detail) VALUES ('alice', 'chat.shared_read', ?, 'not json')").run(c)
    db().exec(update)
    const reads = (id: string) => JSON.parse((db().query('SELECT reads FROM shared_answer_reads WHERE message_id = ?').get(id) as { reads: string }).reads)
    expect(reads(yes)).toEqual([{ c: ['alice'], s: [MKT], y: 1 }, { c: ['alice'], s: [FIN], x: 1 }])
    expect(reads(no)).toEqual([{ c: ['alice'], s: [MKT] }])
    expect(db().query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'shared_answer_reads_chat_msg'").get()).toBeTruthy()
    expect(db().query("SELECT value FROM settings WHERE key = 'hidden_answers_cutover'").get()).toBeTruthy()
    expect(sql).toContain('INSERT OR IGNORE INTO settings')
    expect(sql.split('\n')[0]).toBe('-- min_compatible_reader: 1')
  })
})
