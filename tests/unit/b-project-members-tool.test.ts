// change_project_members (server/src/chat/project-members.ts, docs/DECISIONS.md "change_project_members: the AI changes
// a project's members"): the AI adds and removes a team project's members after the person's yes on ONE server card,
// through the members panel's own save. Covered, one test per rule of the independent review:
// - the names (M2, M3, N3): exact, compact, look-alike and invisible characters fold together across people and groups,
//   so a look-alike or a same name needs the id; an id must be one of its name's candidates; removal by a part of 2+
//   characters among the members; one message for "not a member"; no group of someone else's;
// - where it runs: refused (refusal()) in a scheduled run, a room, a shared chat, a confidential chat, a chat other
//   people wrote in, a Slack thread's chat, a limited run, and for a sub-agent; never in the room or shared allowlists,
//   FILE_TOOLS or the remote connector; at most two cards, none after a no, one at a time;
// - read rooms (M1): rooms_seen, a side chat and a quoting message lead the ONE card with the room line; a name planted
//   there is marked red "내 메시지에 없는 이름이에요" (M5), and so is a project other than the chat's;
// - the plan (M4): an older folder without the floor rule, or without the creator's rule, is refused and sent to the
//   panel; the creator is never removed; a fixed person is refused;
// - the card (S2, N1, N2, N4): kinds, a group's head count, "같은 이름", the counts, what opens, the future-group line,
//   the removal and notice lines, an admin who removes themself keeps seeing it;
// - the yes: the fingerprint (a rename, a rule change or someone joining a group while the card waits refuses), the
//   save via 'ai', one audit row per call; who may (the creator named only while able, an admin never).
// Fixture (tests/lib/fixtures.ts): alice + erin = marketing, bob = finance, carol = admin, dana = owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type Room, type TurnRequest } from '@mycel/shared/api'
import { FILE_TOOLS } from '@mycel/shared'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { compactName, foldName, groupSubject, matchName, MEMBERS_TEXT, mentioned, nameParts, nameSkeleton, PROJECT_MEMBERS_TOOL, projectMembersRefusal, projectMembersTool, said, sameNames, shownName, type MembersExec, type Subject } from '../../server/src/chat/project-members'
import { DICTS } from '../../web/src/i18n'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { ROOM_TOOLS, ROOMS_SEEN_READ_ONLY_TOOLS, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { ensureFolderRow, replaceRules } from '../../server/src/admin/folders'
import { TurnFiles } from '../../server/src/files/service'
import { tr } from '../../server/src/chat/i18n'
import { PROJECT_MEMBERS_RULE } from '../../server/src/chat/prompt'

setDefaultTimeout(120_000)
const cm = () => 'cm-' + crypto.randomUUID()
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
/** a call with the names written as JSON escapes: in the message, the names themselves never appear (an AI that took them
 * from somewhere else than the person's own words) */
const hidden = (args: Record<string, unknown>, names: string[]) => names.reduce((line, n) => line.split(JSON.stringify(n)).join(`"${[...n].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"`),
  '@fake ' + JSON.stringify({ tool: PROJECT_MEMBERS_TOOL, args, sayResult: true }))
const call = (args: Record<string, unknown>) => fake({ tool: PROJECT_MEMBERS_TOOL, args, sayResult: true })
type Card = { question: string; origin?: string; options?: { label: string; value: string }[]; details?: { label: string; text: string; alerts?: { text: string; note: string }[] }[] }
// alice's app is in English (b-harness people), carol's in Korean
const RED = MEMBERS_TEXT.notSaid.en

let h: Harness
const socks: Record<string, TestSocket> = {}
let marketing = '', finance = ''
beforeAll(async () => {
  h = await startHarness({ name: 'b-project-members-tool', askUserTimeoutMs: 6000, turnTimeoutMs: 60_000 })
  const db = h.ctx.db
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short (as b-post-to-room)
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    if (g === 'marketing') marketing = id
    else finance = id
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  // more people, with names made to collide (each an active member)
  for (const [id, name] of [['minjae', 'Minjae Lee'], ['kang', '김강현'], ['kang2', '김강\u200b현'], ['sora', 'Kim Sora'], ['sora2', 'Кim Sora'], ['jun', 'Jun Park'], ['jun2', 'Jun Park2']] as const)
    db.query("INSERT INTO users (id, username, name, role) VALUES (?, ?, ?, 'member')").run(id, id, name)
  for (const u of ['alice', 'bob', 'carol', 'erin']) { socks[u] = await h.ws(u, { windowId: `win-pm-${u}` }); await socks[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

/** a team project of `who`, made the way the app makes it (a projects/<name> folder the server made, folder_made = 1) */
async function project(who: string, name: string, participants: { subjectType: 'user' | 'group'; subjectId: string }[] = []) {
  const p = await h.api(who).call(API.createProject, { body: { name, scope: 'team', instructions: '', participants } })
  return p
}
const rulesAt = (p: string) => (h.ctx.db.query('SELECT r.subject_type AS t, r.subject_id AS s, r.access AS a FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = ? ORDER BY t, s').all(p) as { t: string; s: string | null; a: string }[])
const members = (p: string) => rulesAt(p).filter((r) => r.a === 'write').map((r) => r.s).sort()
const audits = (turnId: string) => (h.ctx.db.query("SELECT target, detail FROM audit_log WHERE action = 'projects.ai_members' AND json_extract(detail, '$.turnId') = ? ORDER BY id").all(turnId) as { target: string | null; detail: string }[]).map((r) => ({ target: r.target, ...(JSON.parse(r.detail) as Record<string, any>) }) as Record<string, any>)
const user = (id: string) => ({ subjectType: 'user' as const, subjectId: id })

/** One answer in a chat of `who` (a new chat of `projectId`, or `chat`); every card answered with `answer` (null: left to
 * close by itself), `meanwhile` run while the first card waits. */
async function turn(who: string, content: string, o: { projectId?: string; chat?: string; side?: string; answer?: string | null; meanwhile?: () => void | Promise<void> } = {}) {
  const chatId = o.chat ?? (await h.api(who).call(API.createChat, { body: { ...(o.projectId ? { projectId: o.projectId } : {}), ...(o.side ? { sideRoomId: o.side } : {}) } })).id
  const r = await h.api(who).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Card[] = []
  const seen = new Set<string>()
  for (let waited = 0; ; waited += 50) {
    if (waited > 60_000) throw new Error('the answer did not end')
    for (const f of socks[who]!.frames) {
      if (f.type !== 'turn.request' || f.data.turnId !== r.turnId || seen.has(f.data.request.requestId)) continue
      seen.add(f.data.request.requestId)
      cards.push(f.data.request as unknown as Card)
      if (cards.length === 1) await o.meanwhile?.()
      if (o.answer !== null && o.answer !== undefined) await h.api(who).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: f.data.request.requestId, answer: o.answer } })
    }
    const done = socks[who]!.frames.find((f) => f.type === 'message.done' && f.data.messageId === r.assistantMessage.id)
    if (done && done.type === 'message.done') {
      const steps = JSON.parse((h.ctx.db.query('SELECT steps FROM messages WHERE id = ?').get(r.assistantMessage.id) as { steps: string | null }).steps ?? '[]') as { tool?: string; label: string }[]
      return { chatId, turnId: r.turnId as string, content: done.data.message.content as string, cards, steps }
    }
    await Bun.sleep(50)
  }
}

describe('names (M2, M3, N3)', () => {
  const people = (xs: [string, string][]): Subject[] => xs.map(([id, name]) => ({ subjectType: 'user', subjectId: id, name }))
  test('exact, compact, case, width, invisible and look-alike characters fold to one name; a part only for removal, 2+ characters', () => {
    expect(compactName('Minjae Lee')).toBe(compactName('minjaelee'))
    expect(compactName('김 강현')).toBe('김강현')
    expect(compactName('Ｍｉｎｊａｅ　Ｌｅｅ')).toBe('minjaelee')
    expect(nameSkeleton('김강\u200b현')).toBe(nameSkeleton('김강현'))
    expect(nameSkeleton('\u202eKim Sora')).toBe(nameSkeleton('kim sora'))
    expect(nameSkeleton('Кim Sora')).toBe(nameSkeleton('Kim Sora'))
    // the card shows an invisible character instead of hiding it
    expect(shownName('김강\u200b현')).toBe('김강[U+200B]현')
    const pool = people([['minjae', 'Minjae Lee'], ['jun', 'Jun Park']])
    expect(matchName('minjaelee', pool)).toEqual({ one: pool[0]! })
    expect(matchName('Minjae', pool)).toEqual({ none: true })
    expect(matchName('Minjae', pool, { partial: true })).toEqual({ one: pool[0]! })
    expect(matchName('J', pool, { partial: true })).toEqual({ none: true })
    // a person and a group of one name: both are candidates, an exact match does not win over the other
    const mixed: Subject[] = [...pool, { subjectType: 'group', subjectId: 'g1', name: 'jun park' }]
    expect('many' in matchName('Jun Park', mixed)).toBe(true)
  })

  test('more look-alikes (Armenian, Latin IPA, Cherokee, Lisu, Greek capitals, the digits 0 and 1) fold to the Latin name', () => {
    expect(nameSkeleton('Kim S\u0585ra')).toBe(nameSkeleton('Kim Sora'))
    expect(nameSkeleton('Jun P\u0251rk')).toBe(nameSkeleton('Jun Park'))
    expect(nameSkeleton('\u13e6im')).toBe(nameSkeleton('Kim'))
    expect(nameSkeleton('\u13daora')).toBe(nameSkeleton('Sora'))
    expect(nameSkeleton('\ua4e2ora')).toBe(nameSkeleton('Sora'))
    expect(nameSkeleton('M\u026ana')).toBe(nameSkeleton('Mina'))
    expect(nameSkeleton('\u0397ana')).toBe(nameSkeleton('Hana'))
    expect(nameSkeleton('J0hn')).toBe(nameSkeleton('John'))
    expect(nameSkeleton('A1ex')).toBe(nameSkeleton('Alex'))
  })

  test('a group goes by its labels in every language (the web\'s projects.whoGroup); a person who takes one shares its name (review MUST)', () => {
    for (const L of ['ko', 'en', 'id', 'ja', 'es'] as const) expect(MEMBERS_TEXT.groupLabel[L]).toBe(DICTS[L]['projects.whoGroup'])
    const sales = groupSubject({ id: 'g-sales', name: '영업', people: 12 })
    const fake: Subject = { subjectType: 'user', subjectId: 'u-fake', name: '영업 부서' }
    const everyone = [sales, fake]
    // "영업 부서 넣어줘": the group and the person both fit, so nothing is asked without an id
    expect(matchName('영업 부서', everyone)).toEqual({ many: [sales, fake] })
    expect(sameNames(fake, everyone)).toBe(2)
    expect(sameNames(sales, everyone)).toBe(2)
    expect(matchName('Sales group', [groupSubject({ id: 'g2', name: 'Sales' })])).toMatchObject({ one: { subjectId: 'g2' } })
    // a group word or an honorific after a name: the group, or the person, still
    expect(matchName('영업팀', [sales])).toEqual({ one: sales })
    expect(matchName('영업팀', [fake])).toEqual({ none: true })
    const minjae: Subject = { subjectType: 'user', subjectId: 'mj', name: '이민재' }
    expect(matchName('이민재님', [minjae])).toEqual({ one: minjae })
    expect(matchName('민재 씨', [minjae], { partial: true })).toEqual({ one: minjae })
  })

  test('an id counts only among its own name\'s candidates; a same name elsewhere needs the id', () => {
    const pool = people([['kang', '김강현'], ['kang2', '김강\u200b현'], ['bob', 'Bob Lee']])
    expect(matchName('김강현', pool)).toEqual({ many: [pool[0]!, pool[1]!] })
    expect(matchName('김강현', pool, { id: 'kang2' })).toEqual({ one: pool[1]! })
    expect(matchName('김강현', pool, { id: 'bob' })).toEqual({ wrongId: [pool[0]!, pool[1]!] })
    // one in the pool, another account of the same name outside it (not a member, for a removal): the id is needed
    expect('many' in matchName('김강현', [pool[0]!], { partial: true, everyone: pool })).toBe(true)
    expect(matchName('김강현', [pool[0]!], { partial: true, everyone: pool, id: 'kang' })).toEqual({ one: pool[0]! })
  })
})

describe('the red mark\'s test: the whole name in the person\'s own words (M5, review of this tool)', () => {
  test('a whole word, with Korean particles after it and spaces inside as the person liked; never a part of a longer word', () => {
    const w = (t: string) => foldName(t)
    expect(said(w('이민재님 넣어줘'), '이민재')).toBe(true)
    expect(said(w('이민재님 넣어줘'), '민재')).toBe(false)
    expect(said(w('김 강현님을 넣고'), '김강현')).toBe(true)
    expect(said(w('Bob Lee를 넣어줘'), 'Bob Lee')).toBe(true)
    expect(said(w('bob lee, erin'), 'Bob Lee')).toBe(true)
    expect(said(w('please add it'), 'ad')).toBe(false)
    expect(said(w('넣어줘'), '줘')).toBe(false)
    // a look-alike is not what they typed
    expect(said(w('Kim Sora 넣어줘'), 'Кim Sora')).toBe(false)
  })

  test('a mention: a group by a label or a group word; a person by a part of the name only nobody else in the pool has', () => {
    const w = (t: string) => foldName(t)
    const sales = groupSubject({ id: 'g-sales', name: '영업' })
    expect(mentioned(w('영업팀 넣어줘'), sales, [sales])).toBe(true)
    expect(mentioned(w('영업 부서 넣어줘'), sales, [sales])).toBe(true)
    const minjae: Subject = { subjectType: 'user', subjectId: 'mj', name: '이민재' }
    const erin: Subject = { subjectType: 'user', subjectId: 'erin', name: 'Erin Yoo' }
    expect(nameParts('이민재')).toEqual(['민재'])
    expect(nameParts('Erin Yoo')).toEqual(['erin', 'yoo'])
    expect(mentioned(w('민재님 빼줘'), minjae, [minjae, erin])).toBe(true)
    expect(mentioned(w('민재 씨 빼줘'), minjae, [minjae, erin])).toBe(true)
    expect(mentioned(w('erin 빼줘'), erin, [minjae, erin])).toBe(true)
    // another member has that part too: not a mention of this one (fail-safe: red)
    const minjae2: Subject = { subjectType: 'user', subjectId: 'mj2', name: '김민재' }
    expect(mentioned(w('민재님 빼줘'), minjae, [minjae, minjae2])).toBe(false)
    expect(mentioned(w('erin 빼줘'), erin, [erin, { subjectType: 'user', subjectId: 'e2', name: 'Erin Park' }])).toBe(false)
  })
})

describe('where it runs', () => {
  test('never in a room, a shared chat, FILE_TOOLS or the remote connector; the main AI only; no room card after a room read', async () => {
    expect(ROOM_TOOLS.has(PROJECT_MEMBERS_TOOL)).toBe(false)
    expect(SHARED_TOOLS.has(PROJECT_MEMBERS_TOOL)).toBe(false)
    expect(PROJECT_MEMBERS_TOOL in FILE_TOOLS).toBe(false)
    expect(PARENT_ONLY_TOOLS.has(PROJECT_MEMBERS_TOOL)).toBe(true)
    expect(ROOMS_SEEN_READ_ONLY_TOOLS.has(PROJECT_MEMBERS_TOOL)).toBe(true)
    const { RemoteTools } = await import('../../server/src/connectors/remote-mcp/tools')
    const all = new RemoteTools(h.ctx).list({ user_id: 'dana', scopes: JSON.stringify(['mcp:read', 'mcp:write', 'mcp:rooms', 'mcp:rooms.write', 'mcp:admin']) } as never)
    expect(all.map((t: { name: string }) => t.name)).not.toContain(PROJECT_MEMBERS_TOOL)
    // offered in a person's own chat, with its rule in the instructions
    const r = await turn('alice', fake({ echo: 'tools' }))
    expect(r.content.split(',')).toContain(PROJECT_MEMBERS_TOOL)
    const sys = await turn('alice', fake({ echo: 'system' }))
    expect(sys.content).toContain(PROJECT_MEMBERS_RULE)
  })

  test('refused up front everywhere but the person\'s own chat with them there (refusal(): what, why, next)', async () => {
    const p = await project('alice', 'Gate')
    const chat = (await h.api('alice').call(API.createChat, { body: { projectId: p.id } })).id
    const exec = (o: Record<string, unknown> = {}, spec: Record<string, unknown> = {}) => ({
      spec: { userId: 'alice', chatId: chat, turnId: uuidv7(), assistantId: uuidv7(), locale: 'en', clientKind: 'web', ...spec },
      room: null, shared: null, restricted: false, templateRun: false, roomsSeen: false, otherAuthors: false, fromSlack: false,
      files: new TurnFiles(), rt: h.rt(), livePrincipal: () => h.ctx.files.principal('alice'), openRequests: () => [],
      askPerson: async () => { throw new Error('no card may be asked') }, ...o,
    }) as unknown as MembersExec
    const cases: [MembersExec, RegExp][] = [
      [exec({}, { clientKind: 'schedule' }), /nobody could be asked/],
      [exec({ room: { roomId: 'r' } }), /not available in a team chat room/],
      [exec({ shared: { project: {} } }), /not available in a shared project chat/],
      [exec({ otherAuthors: true }), /a chat other people wrote in/],
      [exec({ fromSlack: true }), /Slack/],
      [exec({ restricted: true }), /a run limited to one task/],
      [exec({ templateRun: true }), /a run limited to one task/],
    ]
    for (const [e, why] of cases) {
      const no = projectMembersRefusal(e)!
      expect(no.text).toMatch(why)
      expect(no.text).toStartWith('Nothing was changed in the project\'s members.')
      expect(no.text).toContain('Next step:')
      const t = projectMembersTool(e)
      expect(t.refuse!({ add: [{ name: 'Bob Lee' }] })).toMatchObject({ text: no.text })
      const r = await t.call({ add: [{ name: 'Bob Lee' }] }, e.files)
      expect((r.content[0] as { text: string }).text).toBe(no.text)
    }
    // a sub-agent's own turn state
    const sub = await projectMembersTool(exec()).call({ add: [{ name: 'Bob Lee' }] }, new TurnFiles())
    expect((sub.content[0] as { text: string }).text).toMatch(/only the main assistant changes members/)
    // a confidential chat (and so it is not offered there)
    h.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(chat)
    expect(projectMembersRefusal(exec())!.text).toMatch(/confidential chat/)
    expect(members(p.folderPath)).toEqual(['alice'])
  })

  test('a Slack thread\'s chat and a sub-agent, through a real answer: refused, no card, nothing changed', async () => {
    const p = await project('alice', 'Slacked')
    const chat = (await h.api('alice').call(API.createChat, { body: { projectId: p.id } })).id
    h.ctx.db.query("INSERT INTO slack_threads (team_id, channel_id, thread_ts, user_id, chat_id, created_at) VALUES ('T1', 'C1', '1.1', 'alice', ?, '2026-11-10T00:00:00Z')").run(chat)
    const r = await turn('alice', call({ add: [{ name: 'Bob Lee' }] }), { chat, answer: 'change' })
    expect(r.cards).toEqual([])
    expect(r.content).toContain('a question from Slack')
    const sub = await turn('alice', fake({ agents: [{ id: 'toolu_PM1', type: 'general-purpose', description: 'Add Bob', steps: [{ tool: PROJECT_MEMBERS_TOOL, args: { add: [{ name: 'Bob Lee' }] }, sayChildResult: true }] }] }), { projectId: p.id, answer: 'change' })
    expect(sub.cards).toEqual([])
    expect(members(p.folderPath)).toEqual(['alice'])
  })
})

describe('the card and the change', () => {
  test('one server card: the project, every name with its kind, the counts, what opens and who is told; yes saves via ai', async () => {
    const p = await project('alice', '견적', [user('erin')])
    fs.mkdirSync(path.join(h.team, p.folderPath, 'skills/견적서'), { recursive: true })
    fs.writeFileSync(path.join(h.team, p.folderPath, 'skills/견적서/SKILL.md'), '---\nname: 견적서\ndescription: x\n---\n')
    fs.writeFileSync(path.join(h.team, p.folderPath, '단가표.md'), 'x')
    const r = await turn('alice', `Bob Lee 넣고 Erin Yoo 빼줘\n${call({ add: [{ name: 'Bob Lee' }], remove: [{ name: 'erin' }] })}`, { projectId: p.id, answer: 'change' })
    expect(r.cards).toHaveLength(1)
    const c = r.cards[0]!
    expect(c.origin).toBe('server')
    expect(c.question.split('\n')).toEqual([
      "Change the members of the project '견적'?",
      '1 person starts seeing this project and 1 person stops (4 → 4, owner and admins included).',
      'What opens to the people who start seeing it: 1 file (1 put there by other people), 1 project skill (견적서).',
      MEMBERS_TEXT.removed.en,
      MEMBERS_TEXT.noticeBoth.en,
    ])
    expect(c.details).toEqual([
      { label: 'Project', text: `견적 (${p.folderPath})` },
      { label: 'Add (1)', text: 'Bob Lee · person' },
      { label: 'Remove (1)', text: 'Erin Yoo · person' },
    ])
    expect(c.options).toEqual([{ label: 'Change members', value: 'change' }, { label: MEMBERS_TEXT.no.en, value: 'skip' }])
    expect(members(p.folderPath)).toEqual(['alice', 'bob'])
    expect(r.content).toContain(`/projects/${p.id}?members=1`)
    expect(r.content).toContain('added Bob Lee (person)')
    expect(r.steps.find((s) => s.tool === PROJECT_MEMBERS_TOOL)?.label).toBe('Change project members · 견적')
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'folder.rules' AND target = ? ORDER BY rowid DESC LIMIT 1").get(p.folderPath) as { detail: string }
    expect(JSON.parse(row.detail)).toMatchObject({ via: 'ai', projectId: p.id, turnId: r.turnId, chatId: r.chatId })
    expect(audits(r.turnId).map((a) => [a.outcome, a.target, a.gained, a.lost])).toEqual([['done', p.id, 1, 1]])
  })

  test('a group: its head count and the line that later members see it too; an admin removing themself keeps seeing it', async () => {
    const p = await project('alice', 'Grouped', [user('carol')])
    const r = await turn('carol', `Marketing 부서 넣고 나(Carol Park) 빼줘\n${call({ add: [{ name: 'marketing' }], remove: [{ name: 'Carol Park' }] })}`, { projectId: p.id, answer: 'skip' })
    const c = r.cards[0]!
    expect(c.details![1]).toEqual({ label: '추가 (1)', text: 'Marketing · 부서 · 2명' })
    expect(c.details![2]).toEqual({ label: '빼기 (1)', text: `Carol Park · 사람 · ${MEMBERS_TEXT.keepsAdmin.ko}` })
    expect(c.question).toContain(MEMBERS_TEXT.futureGroup.ko)
    // erin joins through marketing; carol keeps seeing it as an admin: nobody loses it
    expect(c.question).not.toContain(MEMBERS_TEXT.removed.ko)
    expect(c.question).toContain(MEMBERS_TEXT.noticeGain.ko)
    // "no": nothing changed, and no second card in that answer
    expect(members(p.folderPath)).toEqual(['alice', 'carol'])
    expect(r.content).toContain('did not allow it')
    expect(audits(r.turnId).map((a) => a.outcome)).toEqual(['declined'])
  })

  test('at most two cards per answer, none after a no; the creator is never removed; one who is not a member is one message', async () => {
    const p = await project('alice', 'Twice', [user('erin')])
    const two = await turn('alice', `Bob Lee, Erin Yoo\n${call({ add: [{ name: 'Bob Lee' }] })}\n${call({ remove: [{ name: 'Erin Yoo' }] })}\n${call({ add: [{ name: 'Jun Park' }] })}`, { projectId: p.id, answer: 'change' })
    expect(two.cards).toHaveLength(2)
    expect(two.content).toContain('at most 2 members cards in one answer')
    expect(members(p.folderPath)).toEqual(['alice', 'bob'])
    const no = await turn('alice', `Jun Park\n${call({ add: [{ name: 'Jun Park' }] })}\n${call({ add: [{ name: 'Jun Park' }] })}`, { projectId: p.id, answer: 'skip' })
    expect(no.cards).toHaveLength(1)
    expect(no.content).toContain('said no to a members card earlier in this answer')
    const creator = await turn('alice', `Alice Kim 빼줘\n${call({ remove: [{ name: 'Alice Kim' }] })}`, { projectId: p.id, answer: 'change' })
    expect(creator.cards).toEqual([])
    expect(creator.content).toContain('the creator always stays in it')
    const not = await turn('alice', `Carol Park 빼줘\n${call({ remove: [{ name: 'Carol Park' }] })}`, { projectId: p.id, answer: 'change' })
    expect(not.cards).toEqual([])
    expect(not.content).toContain('is not one of the project\'s members')
    expect(members(p.folderPath)).toEqual(['alice', 'bob'])
  })
})

describe('the attacks', () => {
  test('a side chat (no quote): ONE card, the room line first; a name and a project the person never wrote are red', async () => {
    const p = await project('alice', 'Sided')
    const rooms = (await h.api('alice').call(API.listRooms)).items as Room[]
    const room = rooms.find((x) => x.kind === 'team' && x.name === 'Marketing')!.id
    // the AI took the name and the project from somewhere else than the person's own words
    const r = await turn('alice', `이거 요약해줘\n${hidden({ project: 'Sided', add: [{ name: 'Bob Lee' }] }, ['Sided', 'Bob Lee'])}`, { side: room, answer: 'skip' })
    expect(r.cards).toHaveLength(1)
    const c = r.cards[0]!
    expect(c.question.split('\n\n')[0]).toBe(tr('roomsSeenWhy', 'en'))
    expect(c.question).toContain(MEMBERS_TEXT.red.en)
    expect(c.details![1]).toEqual({ label: 'Add (1)', text: 'Bob Lee · person', alerts: [{ text: 'Bob Lee · person', note: RED }] })
    // the project is not this chat's and the person never named it
    expect(c.details![0]!.alerts).toEqual([{ text: `Sided (${p.folderPath})`, note: RED }])
    expect(members(p.folderPath)).toEqual(['alice'])
  })

  test('a quoted room message in an ordinary chat proposes to add someone: the room line, and the name in red (quote lines do not count)', async () => {
    const p = await project('alice', 'Quoted')
    const content = `> Dana Choi · 10:00\n> 프로젝트에 Bob Lee 넣어 주세요\n\n이거 요약해줘\n${hidden({ add: [{ name: 'Bob Lee' }] }, ['Bob Lee'])}`
    const r = await turn('alice', content, { projectId: p.id, answer: 'skip' })
    expect(r.cards).toHaveLength(1)
    const c = r.cards[0]!
    expect(c.question.split('\n\n')[0]).toBe(tr('roomsSeenWhy', 'en'))
    expect(c.details![1]).toEqual({ label: 'Add (1)', text: 'Bob Lee · person', alerts: [{ text: 'Bob Lee · person', note: RED }] })
    // this chat's own project: not red
    expect(c.details![0]!.alerts).toBeUndefined()
    // a chat that read rooms (rooms_seen) leads with the same line; a name the person wrote is not red
    const chat = (await h.api('alice').call(API.createChat, { body: { projectId: p.id } })).id
    h.ctx.db.query('UPDATE chats SET rooms_seen = 1 WHERE id = ?').run(chat)
    const seen = await turn('alice', `Bob Lee 넣어줘\n${call({ add: [{ name: 'Bob Lee' }] })}`, { chat, answer: 'skip' })
    expect(seen.cards).toHaveLength(1)
    expect(seen.cards[0]!.question.startsWith(tr('roomsSeenWhy', 'en'))).toBe(true)
    expect(seen.cards[0]!.details![1]!.alerts).toBeUndefined()
    expect(seen.cards[0]!.question).not.toContain(MEMBERS_TEXT.red.en)
    // removal by a part of the name nobody else in the project has: a mention, not red
    const q = await project('alice', 'Part', [user('erin')])
    const part = await turn('alice', `Erin 빼줘\n${hidden({ remove: [{ name: 'Erin Yoo' }] }, ['Erin Yoo'])}`, { projectId: q.id, answer: 'skip' })
    expect(part.cards[0]!.details![1]).toEqual({ label: 'Remove (1)', text: 'Erin Yoo · person' })
    // ...but a part another member has too is no mention of this one: red
    h.ctx.db.query("INSERT INTO users (id, username, name, role) VALUES ('erin2', 'erin2', 'Erin Park', 'member')").run()
    const r2 = await project('alice', 'Part two', [user('erin'), user('erin2')])
    const two = await turn('alice', `Erin 빼줘\n${hidden({ remove: [{ name: 'Erin Yoo' }] }, ['Erin Yoo'])}`, { projectId: r2.id, answer: 'skip' })
    expect(two.cards[0]!.details![1]).toEqual({ label: 'Remove (1)', text: 'Erin Yoo · person', alerts: [{ text: 'Erin Yoo · person', note: RED }] })
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'erin2'").run()
  })

  test('look-alike and invisible-character names: no card without the id; a member is sent to the panel; an admin\'s card shows the username, red for the look-alike', async () => {
    const p = await project('alice', 'Lookalike')
    const amb = await turn('alice', `김강현, Kim Sora 넣어줘\n${call({ add: [{ name: '김강현' }, { name: 'Kim Sora' }] })}`, { projectId: p.id, answer: 'change' })
    expect(amb.cards).toEqual([])
    expect(amb.content).toMatch(/id kang(?!2)/)
    expect(amb.content).toContain('id kang2')
    expect(amb.content).toContain('김강[U+200B]현')
    expect(amb.content).toContain('id sora2')
    // a member: even with the id, no card can tell the two apart (anyone can set their own name)
    const member = await turn('alice', `김강현 넣어줘\n${call({ add: [{ name: '김강현', id: 'kang2' }] })}`, { projectId: p.id, answer: 'change' })
    expect(member.cards).toEqual([])
    expect(member.content).toContain('another account or a group goes by this name too')
    expect(member.content).toContain(`/projects/${p.id}?members=1`)
    // an admin (Korean app): the username beside the name; the invisible character shown
    const ko = (await turn('carol', `김강현 넣어줘\n${call({ add: [{ name: '김강현', id: 'kang2' }] })}`, { projectId: p.id, answer: 'skip' })).cards[0]!
    expect(ko.details![1]).toEqual({ label: '추가 (1)', text: '김강[U+200B]현 · 사람 · @kang2 · 같은 이름 2명' })
    // the Cyrillic look-alike picked by id: carol typed the Latin name, so it is red
    const cy = (await turn('carol', `Kim Sora 넣어줘\n${call({ add: [{ name: 'Kim Sora', id: 'sora2' }] })}`, { projectId: p.id, answer: 'skip' })).cards[0]!
    expect(cy.details![1]).toEqual({ label: '추가 (1)', text: 'Кim Sora · 사람 · @sora2 · 같은 이름 2명', alerts: [{ text: 'Кim Sora · 사람 · @sora2 · 같은 이름 2명', note: MEMBERS_TEXT.notSaid.ko }] })
    expect(members(p.folderPath)).toEqual(['alice'])
  })

  test('a person named like a group\'s label ("Marketing group", "Marketing 부서"): no silent match; a member is sent to the panel, an admin sees the username', async () => {
    const db = h.ctx.db
    db.query("INSERT INTO users (id, username, name, role) VALUES ('mkt', 'mkt', 'Marketing group', 'member'), ('mkt2', 'mkt2', 'Marketing 부서', 'member')").run()
    try {
      const p = await project('alice', 'Labels')
      // "Marketing group 넣어줘": the group (by its English label) and the person both fit: candidates, no card
      const amb = await turn('alice', `Marketing group 넣어줘\n${call({ add: [{ name: 'Marketing group' }] })}`, { projectId: p.id, answer: 'change' })
      expect(amb.cards).toEqual([])
      expect(amb.content).toContain('id mkt;')
      expect(amb.content).toContain(`id ${marketing}`)
      // the person by id: a member cannot be shown which one it is, so the panel
      const person = await turn('alice', `Marketing group 넣어줘\n${call({ add: [{ name: 'Marketing group', id: 'mkt' }] })}`, { projectId: p.id, answer: 'change' })
      expect(person.cards).toEqual([])
      expect(person.content).toContain('another account or a group goes by this name too')
      expect(person.content).toContain(`/projects/${p.id}?members=1`)
      // the group by id: its line says group and its head count, which no person can take, and that the name is shared
      const group = (await turn('alice', `Marketing group 넣어줘\n${call({ add: [{ name: 'Marketing group', id: marketing }] })}`, { projectId: p.id, answer: 'skip' })).cards[0]!
      expect(group.details![1]).toEqual({ label: 'Add (1)', text: 'Marketing · group · 2 people · 3 share this name' })
      // an admin (Korean app), the person by id: the username beside the name
      const admin = (await turn('carol', `Marketing 부서 넣어줘\n${call({ add: [{ name: 'Marketing 부서', id: 'mkt2' }] })}`, { projectId: p.id, answer: 'skip' })).cards[0]!
      expect(admin.details![1]).toEqual({ label: '추가 (1)', text: 'Marketing 부서 · 사람 · @mkt2 · 같은 이름 2명' })
      expect(members(p.folderPath)).toEqual(['alice'])
    } finally { db.query("UPDATE users SET status = 'disabled' WHERE id IN ('mkt', 'mkt2')").run() }
  })

  test('a room picked with "#" names its title in the message: other people\'s words, so a name in it is still red', async () => {
    const p = await project('alice', 'Room titles')
    const rooms = (await h.api('alice').call(API.listRooms)).items as Room[]
    const room = rooms.find((x) => x.kind === 'team' && x.name === 'Marketing')!.id
    const r = await turn('alice', `#[Bob Lee 합류 요청](room:${room}) 방 요약해줘\n${hidden({ add: [{ name: 'Bob Lee' }] }, ['Bob Lee'])}`, { projectId: p.id, answer: 'skip' })
    expect(r.cards).toHaveLength(1)
    expect(r.cards[0]!.details![1]).toEqual({ label: 'Add (1)', text: 'Bob Lee · person', alerts: [{ text: 'Bob Lee · person', note: RED }] })
  })

  test('an id that is not its name\'s: refused with the name\'s candidates, nothing asked', async () => {
    const p = await project('alice', 'Wrong id')
    const r = await turn('alice', `Bob Lee 넣어줘\n${call({ add: [{ name: 'Bob Lee', id: 'erin' }] })}`, { projectId: p.id, answer: 'change' })
    expect(r.cards).toEqual([])
    expect(r.content).toContain('is not one of this name\'s candidates')
    expect(members(p.folderPath)).toEqual(['alice'])
  })

  test('a member renamed to another member\'s compact name: removal needs the id; a rename while the card waits refuses the yes', async () => {
    const p = await project('alice', 'Renamed', [user('minjae'), user('jun')])
    h.ctx.db.query("UPDATE users SET name = 'minjae.lee' WHERE id = 'jun'").run()
    try {
      const amb = await turn('alice', `Minjae Lee 빼줘\n${call({ remove: [{ name: 'Minjae Lee' }] })}`, { projectId: p.id, answer: 'change' })
      expect(amb.cards).toEqual([])
      expect(amb.content).toContain('id minjae')
      expect(amb.content).toContain('id jun')
    } finally { h.ctx.db.query("UPDATE users SET name = 'Jun Park' WHERE id = 'jun'").run() }
    const r = await turn('alice', `Jun Park 빼줘\n${call({ remove: [{ name: 'Jun Park' }] })}`, {
      projectId: p.id, answer: 'change',
      meanwhile: () => { h.ctx.db.query("UPDATE users SET name = 'Minjae Lee' WHERE id = 'jun'").run() },
    })
    h.ctx.db.query("UPDATE users SET name = 'Jun Park' WHERE id = 'jun'").run()
    expect(r.cards).toHaveLength(1)
    expect(r.content).toContain('changed while the card waited')
    expect(members(p.folderPath)).toEqual(['alice', 'jun', 'minjae'])
    expect(audits(r.turnId).map((a) => a.outcome)).toEqual(['changed'])
  })

  test('an older folder: the save would add the floor or bring the creator back: refused, sent to the panel, nothing changed', async () => {
    // a folder an older build made: the creator's rule only, no floor
    fs.mkdirSync(path.join(h.team, 'projects/old-floor'), { recursive: true })
    const row = ensureFolderRow(h.ctx.db, 'projects/old-floor')
    h.ctx.db.transaction(() => replaceRules(h.ctx.db, row.id, [{ subjectType: 'user', subjectId: 'alice', access: 'write' }], 'alice'))()
    const id = uuidv7()
    h.ctx.db.query("INSERT INTO projects (id, name, folder_path, instructions, created_by, created_at, folder_made) VALUES (?, 'Old floor', 'projects/old-floor', '', 'alice', '2026-01-01T00:00:00Z', 1)").run(id)
    const r = await turn('alice', `Bob Lee 넣어줘\n${call({ add: [{ name: 'Bob Lee' }] })}`, { projectId: id, answer: 'change' })
    expect(r.cards).toEqual([])
    expect(r.content).toContain('"everyone else: no access" rule')
    expect(r.content).toContain(`/projects/${id}?members=1`)
    expect(rulesAt('projects/old-floor')).toEqual([{ t: 'user', s: 'alice', a: 'write' }])
    // the creator's rule taken out by an admin: carol's change would put it back
    const q = await project('alice', 'No creator rule', [user('erin')])
    const qr = ensureFolderRow(h.ctx.db, q.folderPath)
    h.ctx.db.transaction(() => replaceRules(h.ctx.db, qr.id, [{ subjectType: 'user', subjectId: 'erin', access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }], 'carol'))()
    const c = await turn('carol', `Bob Lee 넣어줘\n${call({ add: [{ name: 'Bob Lee' }] })}`, { projectId: q.id, answer: 'change' })
    expect(c.cards).toEqual([])
    expect(c.content).toContain('the creator\'s rule is missing')
    expect(members(q.folderPath)).toEqual(['erin'])
    expect(audits(c.turnId).map((a) => [a.outcome, a.reason])).toEqual([['refused', 'rules_beyond_names']])
  })

  test('the rules or a group change while the card waits: the fingerprint no longer fits, nothing written', async () => {
    const p = await project('alice', 'Raced', [user('erin')])
    const r = await turn('alice', `Bob Lee 넣어줘\n${call({ add: [{ name: 'Bob Lee' }] })}`, {
      projectId: p.id, answer: 'change',
      // an admin adds a read rule in Admin › Folder permissions meanwhile
      meanwhile: () => {
        const row = ensureFolderRow(h.ctx.db, p.folderPath)
        h.ctx.db.transaction(() => replaceRules(h.ctx.db, row.id, [...rulesAt(p.folderPath).map((x) => ({ subjectType: x.t, subjectId: x.s, access: x.a }) as never), { subjectType: 'user', subjectId: 'jun', access: 'read' }], 'carol'))()
      },
    })
    expect(r.content).toContain('changed while the card waited')
    expect(members(p.folderPath)).toEqual(['alice', 'erin'])
    // someone joins the group that would be added: who sees it after the save is not what the card said
    const g = await project('alice', 'Group raced')
    const gr = await turn('alice', `Marketing 넣어줘\n${call({ add: [{ name: 'Marketing' }] })}`, {
      projectId: g.id, answer: 'change',
      meanwhile: () => { h.ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(marketing, 'jun') },
    })
    h.ctx.db.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(marketing, 'jun')
    expect(gr.content).toContain('changed while the card waited')
    expect(members(g.folderPath)).toEqual(['alice'])
    // a project skill appears while the card waits: the people added would use one the card did not name (N5)
    const k = await project('alice', 'Skill raced')
    const kr = await turn('alice', `Bob Lee 넣어줘\n${call({ add: [{ name: 'Bob Lee' }] })}`, {
      projectId: k.id, answer: 'change',
      meanwhile: () => {
        fs.mkdirSync(path.join(h.team, k.folderPath, 'skills/새 스킬'), { recursive: true })
        fs.writeFileSync(path.join(h.team, k.folderPath, 'skills/새 스킬/SKILL.md'), '---\nname: 새 스킬\ndescription: x\n---\n')
      },
    })
    expect(kr.content).toContain('changed while the card waited')
    expect(members(k.folderPath)).toEqual(['alice'])
  })

  test('who may: a participant is told the creator or an admin (no admin by name); a creator who cannot is not named', async () => {
    const p = await project('alice', 'Not mine', [user('erin')])
    const r = await turn('erin', `Bob Lee 넣어줘\n${call({ add: [{ name: 'Bob Lee' }] })}`, { projectId: p.id, answer: 'change' })
    expect(r.cards).toEqual([])
    expect(r.content).toContain('Alice Kim (the project\'s creator)')
    for (const admin of ['Carol', 'Dana']) expect(r.content).not.toContain(admin)
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'alice'").run()
    try {
      const off = await turn('erin', `Bob Lee 넣어줘\n${call({ add: [{ name: 'Bob Lee' }] })}`, { projectId: p.id, answer: 'change' })
      expect(off.content).not.toContain('Alice')
      expect(off.content).toContain('an admin')
    } finally { h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = 'alice'").run() }
    // a member names only their own groups: finance is "not found" for alice (its name is not hers to learn)
    const q = await project('alice', 'Groups of mine')
    const g = await turn('alice', `Finance 넣어줘\n${call({ add: [{ name: 'Finance' }] })}`, { projectId: q.id, answer: 'change' })
    expect(g.cards).toEqual([])
    expect(g.content).toContain('no group of the user\'s')
    expect(members(p.folderPath)).toEqual(['alice', 'erin'])
  })
})

describe('the audit and the busy card', () => {
  test('one audit row per call, also a refused one; a call while another card waits is refused, not queued', async () => {
    const p = await project('alice', 'Audited')
    const r = await turn('alice', `Nobody Here 넣어줘\n${call({ add: [{ name: 'Nobody Here' }] })}`, { projectId: p.id })
    expect(r.content).toContain('no active person on this team')
    expect(audits(r.turnId).map((a) => [a.outcome, a.reason])).toEqual([['refused', 'unclear']])
    // busy: a stand-in turn with another card open
    const chat = (await h.api('alice').call(API.createChat, { body: { projectId: p.id } })).id
    const asked: TurnRequest[] = []
    const exec = {
      spec: { userId: 'alice', chatId: chat, turnId: uuidv7(), assistantId: uuidv7(), locale: 'en', clientKind: 'web' },
      room: null, shared: null, restricted: false, templateRun: false, roomsSeen: false, otherAuthors: false, fromSlack: false,
      files: new TurnFiles(), rt: h.rt(), livePrincipal: () => h.ctx.files.principal('alice'), openRequests: () => [{ request: { kind: 'ask_user' } }],
      askPerson: async (req: TurnRequest) => { asked.push(req); return { value: null, missing: null } },
    } as unknown as MembersExec
    const out = await projectMembersTool(exec).call({ add: [{ name: 'Bob Lee' }] }, exec.files)
    expect((out.content[0] as { text: string }).text).toContain('another card is waiting')
    expect(asked).toEqual([])

  })
})
