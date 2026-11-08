// "이 방에서는 항상 허용" (docs/DECISIONS.md "대화방에서 새 파일은 미리 허용"): a room's change card offers to allow new
// team files in one folder in advance; [이번만 허용] covers the rest of the answer for that folder; a call that needs the
// wider-audience card too gets that one card. With the fake engine through the real launcher and gate. One test per
// guardrail: an existing file, other spellings, subfolders and top folders, the merged card, each lapse, the admin
// switch, the person's own chat and a scheduled run, edit_files, an edit of a file the answer made, the audit rows
// (a DM by its kind only), and the list and delete endpoints (only one's own).
//
// Rooms here are alice, erin, carol and dana (the people who may read groups/marketing), so a second question, whose
// context holds the first, needs no wider-audience card for a folder there unless a test reads something narrower.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type RoomAiRun, type RoomMessage, type TurnRequest } from '@mycel/shared/api'
import { ask as askChat, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { createGrant, grantFor, listGrants, ROOM_GRANT_DAYS, type GrantRow } from '../../server/src/rooms/ai-grants'
import { wouldSeeFrom } from '../../server/src/rooms/history'
import { makePng } from '../lib/images'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
type Ask = Extract<TurnRequest, { kind: 'ask_user' }>

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-room-ai-grants', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const ALL = ['alice', 'erin', 'carol', 'dana']
let n = 0
let groups = 0
/** a team room of its own: a new group of these people, made by the owner (a person may make only 10 group chats an
 * hour) */
async function teamRoomOf(memberIds: string[] = ALL): Promise<{ roomId: string; groupId: string }> {
  const g = await h.api('dana').call(API.createGroup, { body: { name: `grant-room-${++groups}`, memberIds } })
  const r = (await h.api(memberIds[0]!).call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)
  if (!r) throw new Error('no team room')
  return { roomId: r.id, groupId: g.id }
}
const teamRoom = async (memberIds: string[] = ALL) => (await teamRoomOf(memberIds)).roomId
/** a group chat of `by` with `others` */
const groupChat = async (by: string, others: string[]) => (await h.api(by).call(API.createRoom, { body: { kind: 'group', userIds: others } })).id
/** a folder of its own under groups/marketing (alice, erin, carol and dana may read and write it) */
function folder(name = `g${++n}`): string {
  const rel = `groups/marketing/${name}`
  fs.mkdirSync(path.join(h.team, rel), { recursive: true })
  return rel
}
const put = (rel: string, body = 'x\n') => { const abs = path.join(h.team, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body); return abs }
const exists = (rel: string) => fs.existsSync(path.join(h.team, rel))
const read = (rel: string) => fs.readFileSync(path.join(h.team, rel), 'utf8')
const values = (c: Ask) => c.options?.map((o) => o.value)
const isWiden = (c: Ask) => values(c)?.includes('save') ?? false
const grantsOf = (user: string, roomId?: string) => h.ctx.db.query(`SELECT * FROM room_ai_grants WHERE user_id = ?${roomId ? ' AND room_id = ?' : ''}`).all(...(roomId ? [user, roomId] : [user])) as GrantRow[]
const audits = (action: string, target?: string) => (h.ctx.db.query(`SELECT actor_id, target, detail FROM audit_log WHERE action = ?${target ? ' AND target = ?' : ''} ORDER BY id`).all(...(target ? [action, target] : [action])) as { actor_id: string | null; target: string; detail: string }[]).map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }))
const lines = (turnId: string) => (h.ctx.db.query("SELECT tool, summary, ok FROM tool_events WHERE turn_id = ? AND tool <> '(connect)' ORDER BY id").all(turnId) as { tool: string; summary: string; ok: number }[])
const rule = (p: string, type: string, id: string | null, access: string) => {
  let f = h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string } | null
  if (!f) { f = { id: 'f_' + crypto.randomUUID() }; h.ctx.db.query('INSERT INTO folders (id, path) VALUES (?, ?)').run(f.id, p) }
  const id_ = crypto.randomUUID()
  h.ctx.db.query('INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, ?, ?, ?)').run(id_, f.id, type, id, access)
  return () => h.ctx.db.query('DELETE FROM folder_rules WHERE id = ?').run(id_)
}

async function send(user: string, roomId: string, body: string): Promise<RoomMessage> {
  const clientMessageId = cm()
  for (let i = 0; ; i++) {
    try {
      return await h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId, mentions: [], fileIds: [] } })
    } catch (e) {
      const err = e as { status?: number; body?: { retryAfter?: number } }
      if (err.status !== 429 || i >= 5) throw e
      await Bun.sleep(1000 * (err.body?.retryAfter ?? 1))
    }
  }
}

/** Ask in a room and answer each card with `answer` (null: leave it until it closes); the cards in order. The
 * wider-audience card is answered "save" unless `answer` says otherwise. */
async function ask(user: string, roomId: string, steps: unknown[], answer: (c: Ask, i: number) => string | null | Promise<string | null> = (c) => (isWiden(c) ? 'save' : 'skip')) {
  const q = await send(user, roomId, `@트리나 do it\n${fake(...steps, { say: 'done' })}`)
  const turnId = (await ws[user]!.next('room.ai.run', (f) => f.data.run.questionId === q.id, 20_000)).data.run.turnId
  const cards: Ask[] = []
  const answered = new Set<string>()
  for (let waited = 0; ; waited += 50) {
    if (waited > 60_000) throw new Error('the answer did not end')
    for (const f of ws[user]!.frames) {
      if (f.type !== 'turn.request' || f.data.turnId !== turnId || answered.has(f.data.request.requestId)) continue
      answered.add(f.data.request.requestId)
      const c = f.data.request as Ask
      cards.push(c)
      const v = await answer(c, cards.length - 1)
      if (v !== null) await h.api(user).call(API.answerTurn, { params: { id: turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: v } })
    }
    let end: RoomAiRun | null = null
    for (const f of ws[user]!.frames) if (f.type === 'room.ai.run' && f.data.run.turnId === turnId && ['done', 'stopped', 'error'].includes(f.data.run.state)) end = f.data.run
    if (end) return { q, turnId, cards, roomCards: cards.filter((c) => !isWiden(c)), run: end }
    await Bun.sleep(50)
  }
}
const write = (file_path: string, content = 'made by the AI\n') => ({ tool: 'write', args: { file_path, content } })
const answerTo = async (user: string, roomId: string, q: RoomMessage) => (await h.api(user).call(API.listRoomMessages, { params: { id: roomId }, query: {} })).items.find((m) => m.authorKind === 'ai' && m.replyTo?.id === q.id)

/** A room and a folder with alice's grant for it (the card's third button). */
async function granted(): Promise<{ roomId: string; dir: string; grant: GrantRow }> {
  const roomId = await teamRoom()
  const dir = folder()
  const r = await ask('alice', roomId, [write(`${dir}/first.md`)], (c) => (values(c)?.includes('always') ? 'always' : 'skip'))
  expect(r.roomCards.map(values)).toEqual([['allow', 'always', 'skip']])
  expect(read(`${dir}/first.md`)).toBe('made by the AI\n')
  const [grant] = grantsOf('alice', roomId)
  expect(grant).toMatchObject({ folder: dir, scope: 'new_files' })
  return { roomId, dir, grant: grant! }
}

describe('the room card', () => {
  test('a new file: three buttons and a line, words of what it does; [항상] saves a grant, and the next new file there goes on without a card', async () => {
    const roomId = await teamRoom()
    const dir = folder()
    const r = await ask('alice', roomId, [write(`${dir}/견적서_A사.md`, 'quote\n')], () => 'always')
    expect(r.cards).toHaveLength(1)
    const c = r.cards[0]!
    expect(c).toMatchObject({ origin: 'server', buttons: true, note: 'Applies only when you call it, to new files in this folder.' })
    expect(c.options).toEqual([{ label: 'Allow once', value: 'allow' }, { label: 'Always allow in this room', value: 'always' }, { label: "Don't allow", value: 'skip' }])
    expect(c.question).toMatch(new RegExp(`^(Trina|The AI) wants to save a new file in ${dir}: 견적서_A사\\.md\\. Changed files can be restored from their history\\.$`))
    expect(c.question).not.toContain("other people's messages")
    expect(c.details?.[0]?.text).toBe('quote\n')
    expect(read(`${dir}/견적서_A사.md`)).toBe('quote\n')
    const [g] = grantsOf('alice', roomId)
    expect(g).toMatchObject({ folder: dir })
    expect(Date.parse(g!.expires_at) - Date.parse(g!.created_at)).toBe(ROOM_GRANT_DAYS * 86_400_000)

    // the next answer: a new file in the folder and one in a new subfolder, no card; the step line and the answer say so
    const next = await ask('alice', roomId, [write(`${dir}/견적서_B사.md`, 'b\n'), write(`${dir}/2026/11/견적서_C사.md`, 'c\n')])
    expect(next.cards).toHaveLength(0)
    expect([read(`${dir}/견적서_B사.md`), read(`${dir}/2026/11/견적서_C사.md`)]).toEqual(['b\n', 'c\n'])
    const steps: string[] = []
    for (const f of ws.alice!.frames) if (f.type === 'room.ai.step' && f.data.turnId === next.turnId && f.data.step.tool === 'write') steps.push(f.data.step.label)
    expect(steps.some((l) => l.endsWith('allowed: always in this room'))).toBe(true)
    const answer = await answerTo('alice', roomId, next.q)
    expect(answer!.body).toContain('Saved in a folder allowed in advance: [견적서_B사.md]')
    expect(answer!.body).toContain(encodeURIComponent(`${dir}/2026/11/견적서_C사.md`))
    expect(audits('room.ai_grant_use', g!.id).map((a) => a.detail.path)).toEqual([`${dir}/견적서_B사.md`, `${dir}/2026/11/견적서_C사.md`])
  })

  test('an existing file after a read: a card every time, never "always"', async () => {
    const { roomId, dir } = await granted()
    put(`${dir}/old.md`, 'old\n')
    const r = await ask('alice', roomId, [{ tool: 'read', args: { file_path: `${dir}/old.md` } }, write(`${dir}/old.md`, 'overwritten\n')])
    expect(r.roomCards.map(values)).toEqual([['allow', 'skip']])
    expect(r.roomCards[0]!.buttons).toBeUndefined()
    expect(read(`${dir}/old.md`)).toBe('old\n')
  })

  test('one allowed edit of an existing file does not let a second edit of it through (only files the answer made count)', async () => {
    const roomId = await teamRoom()
    const dir = folder()
    put(`${dir}/doc.md`, 'one two\n')
    const r = await ask('alice', roomId, [
      { tool: 'read', args: { file_path: `${dir}/doc.md` } },
      { tool: 'edit', args: { file_path: `${dir}/doc.md`, old_string: 'one', new_string: 'ONE' } },
      { tool: 'edit', args: { file_path: `${dir}/doc.md`, old_string: 'two', new_string: 'TWO' } },
    ], () => 'allow')
    expect(r.roomCards.map(values)).toEqual([['allow', 'skip'], ['allow', 'skip']])
    expect(read(`${dir}/doc.md`)).toBe('ONE TWO\n')
  })

  test('[이번만 허용] covers a second new file in the folder and changes of files the answer made, not an existing file', async () => {
    const roomId = await teamRoom()
    const dir = folder()
    put(`${dir}/there.md`, 'there\n')
    const r = await ask('alice', roomId, [
      write(`${dir}/a.md`, 'a\n'),
      write(`${dir}/sub/b.md`, 'b\n'),
      { tool: 'edit', args: { file_path: `${dir}/a.md`, old_string: 'a', new_string: 'A' } },
      write(`${dir}/a.md`, 'A again\n'),
      { tool: 'read', args: { file_path: `${dir}/there.md` } },
      { tool: 'edit', args: { file_path: `${dir}/there.md`, old_string: 'there', new_string: 'changed' } },
    ], (c, i) => (i === 0 ? 'allow' : 'skip'))
    // one card for a.md (allowed once), one for the existing file (declined)
    expect(r.roomCards.map(values)).toEqual([['allow', 'always', 'skip'], ['allow', 'skip']])
    expect([read(`${dir}/a.md`), read(`${dir}/sub/b.md`), read(`${dir}/there.md`)]).toEqual(['A again\n', 'b\n', 'there\n'])
    expect(grantsOf('alice', roomId)).toHaveLength(0)
    // each file it let through without a card is audited (once, no grant) and named under the answer
    const once = audits('room.ai_grant_use').filter((a) => a.detail.turnId === r.turnId)
    expect(once.map((a) => [a.target, a.detail.once, a.detail.path])).toEqual([[null, true, `${dir}/sub/b.md`], [null, true, `${dir}/a.md`], [null, true, `${dir}/a.md`]])
    const body = (await answerTo('alice', roomId, r.q))!.body
    expect(body).toContain('Saved in a folder allowed in advance: [b.md]')
    expect(body).toContain('[a.md]')
    const steps: string[] = []
    for (const f of ws.alice!.frames) if (f.type === 'room.ai.step' && f.data.turnId === r.turnId && f.data.step.tool === 'write') steps.push(f.data.step.label)
    expect(steps.some((l) => l.endsWith('allowed once in this answer'))).toBe(true)
    // the next answer asks again: [이번만] was for that answer only
    const again = await ask('alice', roomId, [write(`${dir}/c.md`)])
    expect(again.roomCards.map(values)).toEqual([['allow', 'always', 'skip']])
  })

  test('[이번만 허용] on a card that did not offer "always" (the switch off) is that call only: the next new file gets a card', async () => {
    const roomId = await teamRoom()
    const dir = folder()
    await h.api('dana').call(API.updateSettings, { body: { roomAlwaysAllow: false } })
    try {
      const r = await ask('alice', roomId, [write(`${dir}/one.md`, '1\n'), write(`${dir}/two.md`, '2\n')], (c, i) => (i === 0 ? 'allow' : 'skip'))
      expect(r.roomCards.map(values)).toEqual([['allow', 'skip'], ['allow', 'skip']])
      expect(read(`${dir}/one.md`)).toBe('1\n')
      expect(exists(`${dir}/two.md`)).toBe(false)
      expect(audits('room.ai_grant_use').some((a) => a.detail.turnId === r.turnId)).toBe(false)
    } finally { await h.api('dana').call(API.updateSettings, { body: { roomAlwaysAllow: true } }) }
    // a folder that is not there yet: no "always", so [이번만] is that call only too
    const fresh = `${dir}/new-sub`
    const r2 = await ask('alice', roomId, [write(`${fresh}/x.md`, 'x\n'), write(`${fresh}/y.md`, 'y\n')], (c, i) => (i === 0 ? 'allow' : 'skip'))
    expect(r2.roomCards.map(values)).toEqual([['allow', 'skip'], ['allow', 'always', 'skip']])
    expect(exists(`${fresh}/y.md`)).toBe(false)
  })

  test('something from outside the team files in the question (a web search): no grant, no [이번만] cover, the card as before', async () => {
    const { roomId, dir, grant } = await granted()
    const r = await ask('alice', roomId, [{ webSearch: { query: 'quote template', hits: [{ title: 'Quotes', url: 'https://quotes.example/a' }] } }, write(`${dir}/from-web.md`, 'w\n'), write(`${dir}/from-web-2.md`, 'w2\n')], (c, i) => (i === 0 ? 'allow' : 'skip'))
    expect(r.roomCards.map(values)).toEqual([['allow', 'skip'], ['allow', 'skip']])
    expect(read(`${dir}/from-web.md`)).toBe('w\n')
    expect(exists(`${dir}/from-web-2.md`)).toBe(false)
    expect(audits('room.ai_grant_use', grant.id).some((a) => a.detail.turnId === r.turnId)).toBe(false)
    // the grant itself is kept: the next question without outside content uses it
    const next = await ask('alice', roomId, [write(`${dir}/after-web.md`)])
    expect(next.cards).toHaveLength(0)
  })

  test('make_file is checked where it saves (its output with the extension): an existing file there gets the card', async () => {
    const { roomId, dir } = await granted()
    put(`${dir}/sheet.xlsx`, 'not really a sheet')
    const r = await ask('alice', roomId, [{ tool: 'make_file', args: { output: `${dir}/sheet`, format: 'xlsx', content: 'a,b\n1,2' } }])
    expect(r.roomCards.map(values)).toEqual([['allow', 'skip']])
    expect(read(`${dir}/sheet.xlsx`)).toBe('not really a sheet')
  })

  test('a granted call is checked again right before it writes: a member who can no longer write there brings the card back', async () => {
    const { roomId, dir } = await granted()
    let undo: (() => void) | null = null
    try {
      const r = await ask('alice', roomId, [{ tool: 'read', args: { file_path: 'projects/falcon/plan.md' } }, write(`${dir}/late.md`, 'late\n')], (c) => {
        // while the wider-audience card waits, erin may only read the folder now
        if (isWiden(c)) { undo = rule(dir, 'user', 'erin', 'read'); return 'save' }
        return 'skip'
      })
      expect(r.cards.map(values)).toEqual([['save', 'skip'], ['allow', 'skip']])
      expect(exists(`${dir}/late.md`)).toBe(false)
    } finally { (undo as (() => void) | null)?.() }
  })

  test("and again after make_file's own card for its pictures: a member who can no longer write there brings the card back", async () => {
    const { roomId, dir } = await granted()
    fs.writeFileSync(path.join(h.team, 'projects/falcon/rg-pic.png'), makePng())
    let undo: (() => void) | null = null
    try {
      const r = await ask('alice', roomId, [{ tool: 'make_file', args: { output: `${dir}/report`, format: 'docx', content: '# Report\n\n![pic](projects/falcon/rg-pic.png)\n' } }], (c) => {
        // the picture is one erin cannot read: make_file's own wider-audience card; while it waits, erin may only read
        if (isWiden(c)) { undo = rule(dir, 'user', 'erin', 'read'); return 'save' }
        return 'skip'
      })
      expect(r.cards.map(values)).toEqual([['save', 'skip'], ['allow', 'skip']])
      expect(exists(`${dir}/report.docx`)).toBe(false)
    } finally { (undo as (() => void) | null)?.(); fs.rmSync(path.join(h.team, 'projects/falcon/rg-pic.png'), { force: true }) }
  })

  test('NFC / NFD and letter case: one folder, one grant', async () => {
    const { roomId, dir } = await granted()
    const nfc = `${dir}/견적서`
    fs.mkdirSync(path.join(h.team, nfc))
    const nfd = nfc.normalize('NFD')
    const r = await ask('alice', roomId, [write(`${nfd}/nfd.md`, 'nfd\n')])
    expect(r.roomCards).toHaveLength(0)
    expect(read(`${nfc}/nfd.md`)).toBe('nfd\n')
    if (h.ctx.files.fx.caseInsensitive) {
      const upper = dir.replace('groups/marketing/', 'Groups/MARKETING/')
      const c = await ask('alice', roomId, [write(`${upper}/case.md`, 'case\n')])
      expect(c.roomCards).toHaveLength(0)
      expect(read(`${dir}/case.md`)).toBe('case\n')
    }
  })

  test('a subfolder with folder rules of its own is not covered; top, group, personal, skills, instruction and plugin folders never offer "always"', async () => {
    const { roomId, dir } = await granted()
    fs.mkdirSync(path.join(h.team, dir, 'own-rules'))
    const marketing = (h.ctx.db.query("SELECT id FROM groups WHERE name = 'Marketing'").get() as { id: string }).id
    const undo = rule(`${dir}/own-rules`, 'group', marketing, 'write')
    try {
      const r = await ask('alice', roomId, [write(`${dir}/own-rules/x.md`)])
      // the same readers and writers, but its own rules: the grant stops above it (the card offers a grant of its own)
      expect(r.roomCards.map(values)).toEqual([['allow', 'always', 'skip']])
    } finally { undo() }
    const fx = h.ctx.files.fx
    const saved = fx.managed
    fx.managed = { managerOf: (segs) => (segs.join('/').startsWith('groups/marketing/pack-x') ? 'test-pack' : saved?.managerOf(segs) ?? null), heldBelow: (segs) => saved?.heldBelow(segs) ?? null }
    try {
      fs.mkdirSync(path.join(h.team, 'groups/marketing/pack-x'), { recursive: true })
      fs.mkdirSync(path.join(h.team, 'users/alice/notes-g'), { recursive: true })
      const fresh = await teamRoom()
      const r = await ask('alice', fresh, [
        write(`shared/top-${n}.md`), write(`groups/marketing/root-${n}.md`), write(`users/alice/notes-g/${n}.md`), write(`groups/marketing/skills/s-${n}.md`),
        write(`${folder()}/CLAUDE.md`), write('groups/marketing/pack-x/y.md'), write(`groups/marketing/.hidden-${n}/z.md`),
      ])
      for (const c of r.roomCards) expect({ q: c.question, v: values(c) }).toEqual({ q: c.question, v: ['allow', 'skip'] })
      expect(r.roomCards.length).toBeGreaterThanOrEqual(6)
      expect(grantsOf('alice', fresh)).toHaveLength(0)
    } finally { fx.managed = saved }
  })

  test('edit_files, moves and save_url always ask, without "always"', async () => {
    const { roomId, dir } = await granted()
    const r = await ask('alice', roomId, [
      write(`${dir}/e1.md`, 'k1\n'),
      { tool: 'edit_files', args: { file_paths: [`${dir}/e1.md`], old_string: 'k1', new_string: 'k2' } },
      { tool: 'move_files', args: { paths: [`${dir}/e1.md`], to_folder: dir + '/2026' } },
    ])
    expect(r.roomCards.map(values)).toEqual([['allow', 'skip'], ['allow', 'skip']])
    expect(read(`${dir}/e1.md`)).toBe('k1\n')
  })
})

describe('one card per call', () => {
  test('a narrower read, then a new file where more people see it: the wider-audience card alone, with what it writes', async () => {
    const roomId = await teamRoom()
    const dir = folder()
    const r = await ask('alice', roomId, [{ tool: 'read', args: { file_path: 'projects/falcon/plan.md' } }, write(`${dir}/summary.md`, 'falcon summary\n')], () => 'save')
    expect(r.cards).toHaveLength(1)
    const c = r.cards[0]!
    expect(values(c)).toEqual(['save', 'skip'])
    expect(c.buttons).toBeUndefined()
    expect(c.details?.[0]).toMatchObject({ fields: [{ value: 'Save' }, { value: `${dir}/summary.md` }], text: 'falcon summary\n' })
    expect(read(`${dir}/summary.md`)).toBe('falcon summary\n')
    // its "no" is the room's no too: nothing written, one card
    const no = await ask('alice', roomId, [{ tool: 'read', args: { file_path: 'projects/falcon/plan.md' } }, write(`${dir}/summary-2.md`)], () => 'skip')
    expect(no.cards).toHaveLength(1)
    expect(exists(`${dir}/summary-2.md`)).toBe(false)
    expect(lines(no.turnId).find((l) => l.tool === 'write')!.summary).toContain('not allowed by the user (room)')
  })

  test('a narrower read, then a save a grant covers: only the wider-audience card', async () => {
    const { roomId, dir, grant } = await granted()
    const r = await ask('alice', roomId, [{ tool: 'read', args: { file_path: 'projects/falcon/plan.md' } }, write(`${dir}/granted.md`, 'g\n')])
    expect(r.cards.map(values)).toEqual([['save', 'skip']])
    expect(r.cards[0]!.details).toBeUndefined()
    expect(read(`${dir}/granted.md`)).toBe('g\n')
    expect(audits('room.ai_grant_use', grant.id)).toHaveLength(1)
  })
})

describe('when a grant lapses', () => {
  const env = () => ({ db: h.ctx.db, fx: h.ctx.files.fx, rules: h.ctx.files.rules() })
  const use = (g: GrantRow, file = 'x.md') => { const e = env(); return grantFor(e.db, e.fx, e.rules, { userId: g.user_id, roomId: g.room_id, segs: [...g.folder.split('/'), file], tool: 'write', turnId: null }) }
  const fresh = async (roomId?: string) => {
    roomId ??= await teamRoom()
    const dir = folder()
    return createGrant(h.ctx.db, h.ctx.files.fx, h.ctx.files.rules(), { userId: 'alice', roomId, folder: dir, turnId: null, since: new Date().toISOString() })
  }
  const revoked = (g: GrantRow) => audits('room.ai_grant_revoke', g.id).map((a) => a.detail.reason)

  test('a good grant covers; 30 days on it lapses and is deleted', async () => {
    const g = await fresh()
    expect(use(g)?.id).toBe(g.id)
    h.ctx.db.query('UPDATE room_ai_grants SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), g.id)
    expect(use(g)).toBeNull()
    expect(grantsOf('alice', g.room_id)).toHaveLength(0)
    expect(revoked(g)).toEqual(['expired'])
  })

  test('someone joined after it: it lapses (a member who may not write never gets the option either)', async () => {
    const { roomId, groupId } = await teamRoomOf()
    const g = await fresh(roomId)
    await h.api('dana').call(API.updateGroup, { params: { id: groupId }, body: { memberIds: [...ALL, 'bob'] } })
    expect(use(g)).toBeNull()
    expect(revoked(g)).toEqual(['member_joined'])
  })

  test('a writer who joins while the card is open lapses the grant it makes', async () => {
    const t = await teamRoomOf(['alice', 'erin', 'dana'])
    const dir = folder()
    const r = await ask('alice', t.roomId, [write(`${dir}/joined.md`)], async (c) => {
      // carol (an admin, who may write there) joins the room before the click
      await h.api('dana').call(API.updateGroup, { params: { id: t.groupId }, body: { memberIds: ['alice', 'erin', 'dana', 'carol'] } })
      return values(c)?.includes('always') ? 'always' : 'skip'
    })
    expect(r.roomCards.map(values)).toEqual([['allow', 'always', 'skip']])
    const [g] = grantsOf('alice', t.roomId)
    expect(g).toBeDefined()
    expect(use(g!)).toBeNull()
    expect(revoked(g!)).toEqual(['member_joined'])
  })

  test('a new account that cannot open the folder changes nothing; the same folder name on another folder is not it', async () => {
    const g = await fresh()
    h.ctx.db.query("INSERT INTO users (id, username, name, role) VALUES ('newbie-g', 'newbie-g', 'New Person', 'member')").run()
    try { expect(use(g)?.id).toBe(g.id) } finally { h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'newbie-g'").run() }
    expect(use(g)?.id).toBe(g.id)
    fs.renameSync(path.join(h.team, g.folder), path.join(h.team, g.folder + '-old'))
    fs.mkdirSync(path.join(h.team, g.folder))
    expect(use(g)).toBeNull()
    expect(revoked(g)).toEqual(['folder_changed'])
  })

  test('a member who may only read: no "always" on the card, and a grant does not apply (checked apart from the join)', async () => {
    const roomId = await teamRoom()
    const dir = folder()
    const undo = rule(dir, 'user', 'erin', 'read')
    try {
      const r = await ask('alice', roomId, [write(`${dir}/x.md`)])
      expect(r.roomCards.map(values)).toEqual([['allow', 'skip']])
    } finally { undo() }
    // a grant, then bob (who cannot write there) is in the room since before it: the writers check alone stops it
    const t = await teamRoomOf()
    const g = await fresh(t.roomId)
    await h.api('dana').call(API.updateGroup, { params: { id: t.groupId }, body: { memberIds: [...ALL, 'bob'] } })
    h.ctx.db.query("UPDATE room_members SET joined_at = '2000-01-01T00:00:00.000Z' WHERE room_id = ? AND user_id = 'bob'").run(g.room_id)
    expect(use(g)).toBeNull()
    expect(grantsOf('alice', g.room_id)).toHaveLength(1)
    expect(revoked(g)).toEqual([])
  })

  test("the folder's readers or writers changed, or the person can no longer write there: it lapses", async () => {
    const g = await fresh()
    const undo = rule(g.folder, 'user', 'bob', 'read')
    try { expect(use(g)).toBeNull() } finally { undo() }
    expect(revoked(g)).toEqual(['audience'])
    const g2 = await fresh()
    const undo2 = rule(g2.folder, 'user', 'alice', 'read')
    try { expect(use(g2)).toBeNull() } finally { undo2() }
    expect(grantsOf('alice', g2.room_id)).toHaveLength(0)
    // the folder is gone (renamed away): it names nothing any more
    const g3 = await fresh()
    fs.renameSync(path.join(h.team, g3.folder), path.join(h.team, g3.folder + '-moved'))
    expect(use(g3)).toBeNull()
    expect(revoked(g3)).toEqual(['no_write'])
  })

  test('leaving the room deletes the grants there; an archived room lapses them', async () => {
    const g = await fresh(await groupChat('erin', ['alice', 'carol', 'dana']))
    await h.api('alice').call(API.leaveRoom, { params: { id: g.room_id } })
    expect(grantsOf('alice', g.room_id)).toHaveLength(0)
    expect(revoked(g)).toEqual(['left'])
    const g2 = await fresh()
    h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), g2.room_id)
    expect(use(g2)).toBeNull()
    expect(revoked(g2)).toEqual(['left'])
  })

  test('the admin switch off: no "always" on the card and grants are ignored, not deleted; on again, they work', async () => {
    const { roomId, dir, grant } = await granted()
    await h.api('dana').call(API.updateSettings, { body: { roomAlwaysAllow: false } })
    try {
      const r = await ask('alice', roomId, [write(`${dir}/off.md`)], () => 'skip')
      expect(r.roomCards.map(values)).toEqual([['allow', 'skip']])
      expect(exists(`${dir}/off.md`)).toBe(false)
      expect(grantsOf('alice', roomId)).toHaveLength(1)
      expect(use(grant)).toBeNull()
    } finally { await h.api('dana').call(API.updateSettings, { body: { roomAlwaysAllow: true } }) }
    expect(use(grant)?.id).toBe(grant.id)
  })
})

describe('a team room as a source: owners and admins who would see it are not "more people"', () => {
  /** a team room of alice and erin (not carol the admin nor dana the owner, who may read groups/marketing) with a grant
   * for a folder there, made in its first question (no context yet, so no wider-audience card) */
  const pairRoom = async () => {
    const t = await teamRoomOf(['alice', 'erin'])
    const dir = folder()
    const r = await ask('alice', t.roomId, [write(`${dir}/first.md`)], (c) => (values(c)?.includes('always') ? 'always' : 'skip'))
    expect(r.cards.map(values)).toEqual([['allow', 'always', 'skip']])
    return { ...t, dir }
  }
  /** an AI answer posted in the room that was built on `from` (another room): what an admin's history walk judges */
  const answerBuiltOn = (roomId: string, from: string) => {
    const db = h.ctx.db, id = uuidv7(), now = new Date().toISOString()
    const seq = (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
    db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, body, mentions, created_at) VALUES (?, ?, ?, 'ai', NULL, 'erin', 'room', 'an answer from our DM', '[]', ?)`).run(id, roomId, seq, now)
    db.query(`INSERT INTO room_ai_turns (turn_id, room_id, user_id, chat_id, question_id, status, answer_id, created_at, scope) VALUES (?, ?, 'erin', 'c', 'q', 'posted', ?, ?, ?)`).run(uuidv7(), roomId, id, now, JSON.stringify({ sources: [{ type: 'room', id: from }], outside: false }))
  }

  test('team room to its group folder: no wider-audience card when only owners and admins could not read the room', async () => {
    const { roomId, dir } = await pairRoom()
    // the second question holds the first in its context (the room is a source: alice and erin read it)
    const r = await ask('alice', roomId, [write(`${dir}/second.md`, 's\n')])
    expect(r.cards).toHaveLength(0)
    expect(read(`${dir}/second.md`)).toBe('s\n')
  })

  test('the card stays when the room holds an answer built on a DM (hidden from an admin who joined)', async () => {
    const { roomId, dir } = await pairRoom()
    const dm = (await h.api('alice').call(API.createRoom, { body: { kind: 'dm', userId: 'erin' } })).id
    answerBuiltOn(roomId, dm)
    const r = await ask('alice', roomId, [write(`${dir}/after-dm.md`)])
    expect(r.cards.map(values)).toEqual([['save', 'skip']])
  })

  test('the card stays when someone who is not an owner or admin could read the folder and not the room', async () => {
    const t = await teamRoomOf(['alice', 'erin'])
    const dir = folder()
    const undo = rule(dir, 'user', 'bob', 'read')
    try {
      await ask('alice', t.roomId, [write(`${dir}/first.md`)], (c) => (values(c)?.includes('always') ? 'always' : 'skip'))
      const r = await ask('alice', t.roomId, [write(`${dir}/bob-reads.md`)])
      expect(r.cards.map(values)).toEqual([['save', 'skip']])
    } finally { undo() }
  })

  test("the history walk has a time budget: out of time is no (the card shows)", async () => {
    const { roomId } = await teamRoomOf(['alice', 'erin'])
    // 300 old answers, each built on nothing (visible to anyone who joins): the walk looks at the clock at the 256th
    const db = h.ctx.db, now = new Date().toISOString()
    for (let i = 0; i < 300; i++) {
      const id = uuidv7()
      const seq = (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
      db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, body, mentions, created_at) VALUES (?, ?, ?, 'ai', NULL, 'erin', 'room', 'old answer', '[]', ?)`).run(id, roomId, seq, now)
      db.query(`INSERT INTO room_ai_turns (turn_id, room_id, user_id, chat_id, question_id, status, answer_id, created_at, scope) VALUES (?, ?, 'erin', 'c', 'q', 'posted', ?, ?, ?)`).run(uuidv7(), roomId, id, now, JSON.stringify({ sources: [], outside: false }))
    }
    expect(wouldSeeFrom(h.ctx, roomId, 'carol', 0)).toBe(true)
    // no time left: no, whatever the room holds
    expect(wouldSeeFrom(h.ctx, roomId, 'carol', 0, -1)).toBe(false)
    // and a DM or group chat is never judged this way
    const dm = (await h.api('erin').call(API.createRoom, { body: { kind: 'dm', userId: 'alice' } })).id
    expect(wouldSeeFrom(h.ctx, dm, 'carol', 0)).toBe(false)
  })

  test('a DM and a group chat are unchanged: the card when owners and admins could not read them', async () => {
    const dm = (await h.api('erin').call(API.createRoom, { body: { kind: 'dm', userId: 'alice' } })).id
    const group = await groupChat('erin', ['alice', 'bob'])
    for (const roomId of [dm, group]) {
      const dir = folder()
      // bob is in the group chat and may not write there: give him write on the folder so the room may get a grant
      const undo = rule(dir, 'user', 'bob', 'write')
      try {
        await ask('alice', roomId, [write(`${dir}/first.md`)], (c) => (values(c)?.includes('always') ? 'always' : 'skip'))
        const r = await ask('alice', roomId, [write(`${dir}/second.md`)])
        expect({ roomId, cards: r.cards.map(values) }).toEqual({ roomId, cards: [['save', 'skip']] })
      } finally { undo() }
    }
  })
})

describe('where grants never apply', () => {
  test("the person's own chat after reading the room, and a scheduled run there: the card (or nothing), never a grant", async () => {
    const { roomId, dir } = await granted()
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    await askChat(h, ws.alice!, 'alice', chat, fake({ tool: 'room_read', args: { room: roomId } }, { say: 'read' }), { ms: 30_000 })
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat }, body: { content: fake(write(`${dir}/own.md`), { say: 'ok' }), clientMessageId: cm(), attachmentIds: [] } })
    const c = await ws.alice!.next('turn.request', (f) => f.data.turnId === r.turnId && f.data.request.kind === 'ask_user', 15_000)
    expect(values(c.data.request as Ask)).toEqual(['allow', 'skip'])
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: 'skip' } })
    await ws.alice!.next('message.done', (f) => f.data.message.turnId === r.turnId, 30_000)
    expect(exists(`${dir}/own.md`)).toBe(false)
    const row = h.rt().store.chatRow(chat)!
    const started = h.rt().createTurn({ chat: row, userId: 'alice', locale: 'en', windowId: null, clientKind: 'schedule', engine: row.engine as 'claude-code', model: null,
      user: { parentId: row.active_leaf_id, content: fake(write(`${dir}/scheduled.md`), { say: 'done' }), attachments: [], clientMessageId: cm() } })
    await ws.alice!.next('message.done', (f) => f.data.message.turnId === started.turnId, 30_000)
    expect(exists(`${dir}/scheduled.md`)).toBe(false)
    expect(audits('room.ai_grant_use').some((a) => a.detail.turnId === started.turnId || a.detail.turnId === r.turnId)).toBe(false)
  })
})

describe('audit rows and the settings list', () => {
  test('a DM grant is audited by the room kind only: made, used, revoked', async () => {
    const roomId = (await h.api('alice').call(API.createRoom, { body: { kind: 'dm', userId: 'erin' } })).id
    const dir = folder()
    await ask('alice', roomId, [write(`${dir}/dm-1.md`)], (c) => (values(c)?.includes('always') ? 'always' : 'save'))
    const [g] = grantsOf('alice', roomId)
    expect(g).toBeDefined()
    // the second question holds the first in its context (the DM's two can read less than the folder's four): the
    // wider-audience card alone, and the grant is used
    const r = await ask('alice', roomId, [write(`${dir}/dm-2.md`)])
    expect(r.roomCards).toHaveLength(0)
    await h.api('alice').call(API.deleteAiAllowance, { params: { id: g!.id } })
    const rows = [...audits('room.ai_grant', g!.id), ...audits('room.ai_grant_use', g!.id), ...audits('room.ai_grant_revoke', g!.id)]
    expect(rows.map((x) => x.detail.kind)).toEqual(['dm', 'dm', 'dm'])
    for (const x of rows) {
      expect(x.detail.roomId).toBeUndefined()
      expect(JSON.stringify(x)).not.toContain(roomId)
    }
    expect(rows.map((x) => x.actor_id)).toEqual(['alice', 'alice', 'alice'])
    expect(rows[2]!.detail.reason).toBe('person')
    // a group chat's rows name its kind; a team room's its id
    const group = await groupChat('carol', ['alice', 'erin', 'dana'])
    const gg = createGrant(h.ctx.db, h.ctx.files.fx, h.ctx.files.rules(), { userId: 'alice', roomId: group, folder: folder(), turnId: null, since: new Date().toISOString() })
    expect(audits('room.ai_grant', gg.id)[0]!.detail).toMatchObject({ kind: 'group', folder: gg.folder })
    expect(audits('room.ai_grant', gg.id)[0]!.detail.roomId).toBeUndefined()
    const { grant } = await granted()
    expect(audits('room.ai_grant', grant.id)[0]!.detail).toMatchObject({ roomId: grant.room_id, folder: grant.folder })
  })

  test("the list shows my grants with the room as I see it; nobody else sees or deletes them", async () => {
    const { roomId, dir, grant } = await granted()
    const mine = await h.api('alice').call(API.listAiAllowances)
    const row = mine.items.find((x) => x.id === grant.id)
    expect(row).toMatchObject({ kind: 'room_files', folder: dir, room: { id: roomId, kind: 'team', memberCount: 4 } })
    expect(row!.room.name).toMatch(/^grant-room-/)
    expect(row!.room.peers.map((p) => p.id).sort()).toEqual(['carol', 'dana', 'erin'])
    // erin is in the room too, and the owner: neither sees it, and deleting it answers like an id that is not there
    for (const who of ['erin', 'dana']) {
      expect((await h.api(who).call(API.listAiAllowances)).items.some((x) => x.id === grant.id)).toBe(false)
      expect((await h.req(who, `/api/ai-allowances/${grant.id}`, { method: 'DELETE' })).status).toBe(404)
    }
    expect((await h.req('alice', `/api/ai-allowances/${uuidv7()}`, { method: 'DELETE' })).status).toBe(404)
    expect(grantsOf('alice', roomId)).toHaveLength(1)
    expect((await h.req('alice', `/api/ai-allowances/${grant.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await h.api('alice').call(API.listAiAllowances)).items.some((x) => x.id === grant.id)).toBe(false)
    // deleted: the next new file there asks again
    const r = await ask('alice', roomId, [write(`${dir}/after-delete.md`)])
    expect(r.roomCards.map(values)).toEqual([['allow', 'always', 'skip']])
    // rooms I left or that were archived are not listed
    expect(listGrants(h.ctx.db, 'bob')).toEqual([])
  })
})
