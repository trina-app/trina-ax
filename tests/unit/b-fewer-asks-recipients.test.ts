// Fewer asks about who and which folder (docs/decisions/20261123-do-then-undo.md; the owner, 2026-11-23: "7번이나 묻는건
// 좀 그런거 아냐?"): a title that the team's directory resolves to one teammate names them; a title several could mean is
// asked once and the answer kept as the person's alias (Settings › Allowed for Trina, kind person_alias); share_folder
// without a folder takes the one this chat used; "팀원들" is the shared chat's people, the project's, or the one group
// people, never a guest; an add the person's own message asked for goes without the card, and an unnamed recipient
// still asks.
// The fixture team (b-harness): alice and erin in marketing, bob in finance, carol admin, dana owner; tess added.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Step } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { fileSharesOf } from '../../server/src/files/shares'
import { findPeople, resolvedByTitle } from '../../server/src/rooms/reader'
import { aliasOf, isTeamRef, saysTeam, saysTitle, titleKey, titlesIn } from '../../server/src/chat/person-aliases'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const sf = (args: Record<string, unknown>) => fake({ tool: 'share_folder', args, sayResult: true })

let h: Harness
const socks: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-fewer-asks-recipients', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000 })
  h.ctx.db.query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('tess', 'tess', 'Tess Yoon', 'member', 'active', NULL)").run()
  for (const u of ['alice', 'bob', 'carol', 'erin']) { socks[u] = await h.ws(u, { windowId: `win-far-${u}` }); await socks[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })
const put = (rel: string, body = rel) => { const abs = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }
let n = 0
const folder = (owner: string, name: string) => { const d = `users/${owner}/${name}${++n}`; put(`${d}/a.md`); put(`${d}/b.md`); return d }
const peopleOn = (owner: string, dir: string) => fileSharesOf(h.ctx).view(owner, dir).people.map((p) => p.subjectId).sort()
const title = (id: string, t: string) => h.ctx.db.query('INSERT INTO user_profiles (user_id, title) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET title = excluded.title').run(id, t)

type Card = { question: string; options?: { label: string; value: string }[] }
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
const cardsTo = (who: string, turnId: string) => socks[who]!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === turnId).length
const stepOf = async (who: string, chatId: string, answerId: string) => (await h.api(who).call(API.listMessages, { params: { id: chatId }, query: {} })).items.find((x) => x.id === answerId)!.steps!.find((s: Step) => s.tool === 'share_folder')

describe('titles and roles', () => {
  test('the words: a title with its honorific and particles, "my manager", the longest word in a sentence', () => {
    expect(titleKey('팀장님')).toBe('팀장')
    expect(titleKey('my manager')).toBe('manager')
    expect(titleKey('Tess Yoon')).toBeNull()
    expect(titlesIn('이거 팀장님한테 보내줘')).toEqual(['팀장'])
    expect(titlesIn('대표이사님께 올려줘')).toEqual(['대표이사'])
    expect(titlesIn('send it to my manager')).toEqual(['manager'])
    expect(titlesIn('the managerial report')).toEqual([])
    expect(saysTitle('이거 팀장님한테 보내줘', { ref: '팀장' })).toBe(true)
    expect(saysTitle('> 팀장님한테 보내\n고마워', { ref: '팀장' })).toBe(false)
    expect(isTeamRef('팀원들')).toBe(true)
    expect(isTeamRef('my team')).toBe(true)
    expect(saysTeam('이 폴더 팀원들한테 공유해줘')).toBe(true)
    expect(saysTeam('팀장님한테 보내줘')).toBe(false)
  })

  test('one owner or admin with the title in their profile: found, and counted as named; a member\'s own title is asked about', () => {
    title('carol', '재무팀 팀장')
    const r = resolvedByTitle(h.ctx.db, 'bob', '팀장님')
    expect(r && 'one' in r && r.one).toMatchObject({ id: 'carol', exact: true, via: { how: 'title', ref: '팀장' } })
    const p = findPeople(h.ctx.db, 'bob', '팀장님')
    expect(p && 'one' in p && p.one.id).toBe('carol')
    h.ctx.db.query("DELETE FROM user_profiles WHERE user_id = 'carol'").run()
    // (security review: a member sets their own title, so it never names them alone)
    title('tess', '팀장')
    const m = resolvedByTitle(h.ctx.db, 'bob', '팀장님')
    expect(m && 'many' in m && m.many.map((x) => x.id)).toEqual(['tess'])
    h.ctx.db.query("DELETE FROM user_profiles WHERE user_id = 'tess'").run()
    // a rank nobody holds is nobody (never the owner by default); a name before the title is a name ("김팀장님")
    expect(resolvedByTitle(h.ctx.db, 'bob', '과장님')).toBeNull()
    expect(titlesIn('김팀장님한테 보내줘')).toEqual([])
    expect(titlesIn('과장된 표현 고쳐줘')).toEqual([])
    expect(saysTeam('팀 회의록 폴더 민수한테 공유해줘')).toBe(false)
  })

  test('an owner word: the team owner; a word for "the one above me" with no title: the one owner or admin, else several (asked)', () => {
    const owner = resolvedByTitle(h.ctx.db, 'bob', '대표님')
    expect(owner && 'one' in owner && owner.one.id).toBe('dana')
    // carol (admin) and dana (owner): several could be meant
    const lead = resolvedByTitle(h.ctx.db, 'bob', '상사님')
    expect(lead && 'many' in lead && lead.many.map((x) => x.id).sort()).toEqual(['carol', 'dana'])
    // a project chat: the project's creator
    const pid = (h.ctx.db.query("INSERT INTO projects (id, name, folder_path, created_by) VALUES ('p-far', 'Far', 'projects/Far', 'carol') RETURNING id").get() as { id: string }).id
    const inProject = resolvedByTitle(h.ctx.db, 'bob', '상사님', { projectId: pid })
    expect(inProject && 'one' in inProject && inProject.one).toMatchObject({ id: 'carol', via: { how: 'creator' } })
  })
})

describe('share_folder: who, which folder, and no card for what the person asked', () => {
  test('a title that resolves to one teammate: shared with no card, and the result names them as the person called them', async () => {
    title('carol', '팀장')
    const dir = folder('bob', 'Title')
    const r = await turn('bob', `${dir} 폴더 팀장님한테 공유해줘\n${sf({ folder: dir, add: ['팀장님'] })}`)
    expect(cardsTo('bob', r.turnId)).toBe(0)
    expect(peopleOn('bob', dir)).toEqual(['carol'])
    const out = JSON.parse(r.content)
    expect(out.found_by).toContain('"팀장"')
    expect(out.note).toContain('without a confirmation card')
    h.ctx.db.query("DELETE FROM user_profiles WHERE user_id = 'carol'").run()
  })

  test('an ambiguous title asks once; the answer is kept as an alias and the next time nobody is asked; Settings lists and deletes it', async () => {
    const dir = folder('bob', 'Ask')
    const chat = (await h.api('bob').call(API.createChat, { body: {} })).id
    // carol and dana could be meant: nothing is shared, the AI gets who could be meant
    const first = await turn('bob', `${dir} 폴더 상사님한테 공유해줘\n${sf({ folder: dir, add: ['상사님'] })}`, { chat })
    expect(first.content).toContain('several people or groups match')
    expect(peopleOn('bob', dir)).toEqual([])
    // the person's answer: the next call names one of them
    const second = await turn('bob', `Carol Park\n${sf({ folder: dir, add: ['person:carol'] })}`, { chat, answer: 'yes' })
    expect(peopleOn('bob', dir)).toEqual(['carol'])
    expect(JSON.parse(second.content).found_by).toContain('remembered now')
    expect(aliasOf(h.ctx.db, 'bob', '상사님')).toBe('carol')
    // another chat, another folder: the title is carol, with no question and no card
    const dir2 = folder('bob', 'Again')
    const third = await turn('bob', `${dir2} 폴더 상사님한테 공유해줘\n${sf({ folder: dir2, add: ['상사님'] })}`)
    expect(cardsTo('bob', third.turnId)).toBe(0)
    expect(peopleOn('bob', dir2)).toEqual(['carol'])
    expect(JSON.parse(third.content).found_by).toContain('saved name')
    // Settings › Allowed for Trina: the alias is a row, deleted with its button
    const list = await h.api('bob').call(API.listAiAllowances)
    const row = list.items.find((x) => x.kind === 'person_alias')
    expect(row).toMatchObject({ kind: 'person_alias', ref: '상사', person: { id: 'carol' } })
    await h.api('bob').call(API.deleteAiAllowance, { params: { id: row!.id } })
    expect(aliasOf(h.ctx.db, 'bob', '상사님')).toBeNull()
    expect((await h.api('bob').call(API.listAiAllowances)).items.some((x) => x.kind === 'person_alias')).toBe(false)
    // another person's alias is not mine to delete
    expect(await h.api('alice').call(API.deleteAiAllowance, { params: { id: 'alias:상사' } }).then(() => 'ok', () => 'refused')).toBe('refused')
  })

  test('a title found only by a guess (the project\'s creator) asks once on the card; the yes keeps the alias and the next ask is silent (security review of batch 5)', async () => {
    const p = await h.api('dana').call(API.createProject, { body: { name: 'Guess Lead', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
    const chat = (await h.api('bob').call(API.createChat, { body: { projectId: p.id, private: true } })).id
    expect(aliasOf(h.ctx.db, 'bob', '상사님')).toBeNull()
    const dir = folder('bob', 'Guess')
    const first = await turn('bob', `${dir} 폴더 상사님한테 공유해줘\n${sf({ folder: dir, add: ['상사님'] })}`, { chat, answer: 'yes' })
    expect(first.card).not.toBeNull()
    expect(peopleOn('bob', dir)).toEqual(['dana'])
    expect(aliasOf(h.ctx.db, 'bob', '상사님')).toBe('dana')
    // the second ask by that title: no question, no card
    const dir2 = folder('bob', 'Guess2')
    const second = await turn('bob', `${dir2} 폴더 상사님한테 공유해줘\n${sf({ folder: dir2, add: ['상사님'] })}`, { chat })
    expect(cardsTo('bob', second.turnId)).toBe(0)
    expect(peopleOn('bob', dir2)).toEqual(['dana'])
    h.ctx.db.query("DELETE FROM person_aliases WHERE user_id = 'bob'").run()
  })

  test('no folder given: the one this chat used, shared with no card, the result says it was picked; none at all: asked', async () => {
    const dir = folder('bob', 'Used')
    const chat = (await h.api('bob').call(API.createChat, { body: {} })).id
    // an earlier answer of this chat read a file in that folder
    const m = (await h.api('bob').call(API.sendMessage, { params: { id: chat }, body: { content: 'hi', clientMessageId: cm(), attachmentIds: [] } })).assistantMessage.id
    await socks.bob!.next('message.done', (f) => f.data.messageId === m, 30_000)
    h.ctx.db.query("INSERT INTO message_sources (message_id, ord, path, via) VALUES (?, 0, ?, 'read')").run(m, `${dir}/a.md`)
    const r = await turn('bob', `이 폴더 Tess Yoon한테 공유해줘\n${sf({ add: ['Tess Yoon'] })}`, { chat })
    expect(cardsTo('bob', r.turnId)).toBe(0)
    expect(peopleOn('bob', dir)).toEqual(['tess'])
    expect(JSON.parse(r.content).note).toContain('did not name the folder')
    // erin used none of her folders anywhere: the AI asks which one
    const none = await turn('erin', `이 폴더 Tess Yoon한테 공유해줘\n${sf({ add: ['Tess Yoon'] })}`)
    expect(none.content).toContain('Ask the user which folder')
  })

  test('"팀원들" in a project chat: the project\'s people, never a guest; who is listed', async () => {
    const p = await h.api('dana').call(API.createProject, { body: { name: 'Far Team', participants: [{ subjectType: 'user', subjectId: 'alice' }, { subjectType: 'user', subjectId: 'bob' }, { subjectType: 'user', subjectId: 'tess' }], instructions: '' } })
    const chat = (await h.api('bob').call(API.createChat, { body: { projectId: p.id } })).id
    h.ctx.db.query("UPDATE users SET guest = 1 WHERE id = 'tess'").run()
    try {
      const dir = folder('bob', 'Team')
      const r = await turn('bob', `"${dir.split('/').pop()}" 폴더 팀원들한테 공유해줘\n${sf({ folder: dir, add: ['팀원들'] })}`, { chat })
      expect(cardsTo('bob', r.turnId)).toBe(0)
      const on = peopleOn('bob', dir)
      expect(on).toContain('alice')
      expect(on).not.toContain('tess')
      expect(on).not.toContain('bob')
      expect(JSON.parse(r.content).team).toContain('팀원들')
    } finally { h.ctx.db.query("UPDATE users SET guest = 0 WHERE id = 'tess'").run() }
  })

  test('"팀원들" outside a project: the person\'s one group, as the group', async () => {
    const dir = folder('bob', 'Group')
    const r = await turn('bob', `${dir} 폴더 팀원들한테 공유해줘\n${sf({ folder: dir, add: ['팀원들'] })}`)
    expect(cardsTo('bob', r.turnId)).toBe(0)
    const step = (await stepOf('bob', r.chatId, r.answerId))!
    expect(step.shared!.who.map((w) => w.subjectType)).toEqual(['group'])
  })

  // QA b5 F5: "팀원들" in a chat with 준호 (영업) went, with no card, to the asker's own group 마케팅
  async function chatWith(user: string, other: string) {
    const c = (await h.api(user).call(API.createChat, { body: {} })).id
    const first = await turn(user, `hello\n${fake({ say: 'hi' })}`, { chat: c })
    expect(first.content).toBe('hi')
    const subjects = [{ subjectType: 'user' as const, subjectId: other }]
    let r = await h.api(user).call(API.putChatAudience, { params: { id: c }, body: { subjects } }) as { status?: string; confirmKey?: string }
    if (r.status === 'confirm') r = await h.api(user).call(API.putChatAudience, { params: { id: c }, body: { subjects, confirmKey: r.confirmKey! } }) as never
    return c
  }
  test('a word for the whole team in a shared chat: the people of that chat, never the asker\'s group; the card names them', async () => {
    const groups = (h.ctx.db.query('SELECT group_id g FROM group_members WHERE user_id = ?').all('bob') as { g: string }[]).map((x) => x.g)
    expect(groups.length).toBe(1)
    expect((h.ctx.db.query('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groups[0]!, 'tess'))).toBeNull()
    for (const word of ['팀원들', 'my team']) {
      const dir = folder('bob', `Chat ${word}`)
      const chat = await chatWith('bob', 'tess')
      const said = word === 'my team' ? `share "${dir.split('/').pop()}" with my team` : `"${dir.split('/').pop()}" 폴더 ${word}한테 공유해줘`
      const r = await turn('bob', `${said}\n${sf({ folder: dir, add: [word] })}`, { chat })
      expect(cardsTo('bob', r.turnId)).toBe(0)
      expect(peopleOn('bob', dir)).toEqual(['tess'])
      const step = (await stepOf('bob', chat, r.answerId))!
      expect(step.shared!.who.map((w) => [w.subjectType, w.name])).toEqual([['user', 'Tess Yoon']])
    }
  })
  test('outside a chat with people or a project, in several groups: nobody is picked, the AI asks', async () => {
    const other = (h.ctx.db.query("SELECT id FROM groups WHERE id NOT IN (SELECT group_id FROM group_members WHERE user_id = 'bob') LIMIT 1").get() as { id: string }).id
    h.ctx.db.query("INSERT INTO group_members (group_id, user_id) VALUES (?, 'bob')").run(other)
    try {
      const dir = folder('bob', 'Two groups')
      const r = await turn('bob', `"${dir.split('/').pop()}" 폴더 팀원들한테 공유해줘\n${sf({ folder: dir, add: ['팀원들'] })}`)
      expect(r.content).toContain('Ask the user who should get it')
      expect(peopleOn('bob', dir)).toEqual([])
    } finally { h.ctx.db.query("DELETE FROM group_members WHERE group_id = ? AND user_id = 'bob'").run(other) }
  })

  test('the floor: a recipient the person did not name, or no ask to share, still shows the card', async () => {
    const dir = folder('bob', 'Floor')
    const r = await turn('bob', `${dir} 폴더 공유해줘\n${sf({ folder: dir, add: ['Tess Yoon'] })}`, { answer: 'no' })
    expect(r.card).not.toBeNull()
    expect(peopleOn('bob', dir)).toEqual([])
    const dir2 = folder('bob', 'Floor2')
    const r2 = await turn('bob', `${dir2} 폴더는 Tess Yoon 거야\n${sf({ folder: dir2, add: ['Tess Yoon'] })}`, { answer: 'no' })
    expect(r2.card).not.toBeNull()
  })
})
