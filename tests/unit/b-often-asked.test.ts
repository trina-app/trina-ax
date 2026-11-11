// What my group often asks (docs/DECISIONS.md "Home: what my group often asks"; server/src/chat/often-asked.ts): the
// privacy rules, without the AI. Which messages may count (never project chats, rooms, side chats, Slack, confidential
// chats, scheduled or server-made turns, skill runs, the app's own prompts, anything before the switch was turned on);
// the masks; the checks on the AI's answer (3+ different people back an item with a real word, every word is a fixed
// generic word or one 3+ people typed, never all from one smaller circle); the floor of 5 askers; join dates; the 3-day
// hold; who gets which list; the switch.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { makeEnv } from '../lib/env'
import { newId } from '../../server/src/db'
import { ChatStore } from '../../server/src/chat/store'
import { setSetting, updateTeamSettings } from '../../server/src/admin/settings'
import {
  buildSnapshot, genericShape, isAppPrompt, LAST_RUN_KEY, masker, oftenAskedFor, oftenAskedSwitched, passing, questionLine, readQuestions, SINCE_KEY,
  storeLists, teamNames, type AiItem,
} from '../../server/src/chat/often-asked'

const e = makeEnv('b-often-asked'), store = new ChatStore(e.db)
const NOW = new Date('2026-11-20T09:00:00.000Z')
const AT = '2026-11-15T09:00:00.000Z'
const PEOPLE = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']
afterAll(() => e.db.close())

beforeEach(() => {
  for (const t of ['often_asked_items', 'slack_threads', 'safe_ops_chats', 'onboarding_file_ranks', 'chat_project_left', 'turns', 'messages', 'chats', 'projects', 'room_members', 'rooms', 'group_count_from']) e.db.query(`DELETE FROM ${t}`).run()
  e.db.query("DELETE FROM group_members WHERE group_id LIKE 'g-%'").run()
  e.db.query("DELETE FROM groups WHERE id LIKE 'g-%'").run()
  e.db.query("DELETE FROM users WHERE id LIKE 'p%'").run()
  for (const id of PEOPLE) e.db.query("INSERT INTO users (id, username, name, role) VALUES (?, ?, ?, 'member')").run(id, `user-${id}`, `Person ${id.toUpperCase()}`)
  e.db.query("UPDATE users SET status = 'active'").run()
  setSetting(e.db, SINCE_KEY, '2026-11-01T00:00:00.000Z')
  updateTeamSettings(e.db, { oftenAsked: true })
})

/** One question in a chat of its own, typed in the app (a web turn), unless `o` says otherwise. */
function ask(user: string, content: string, o: { at?: string; client?: string | null; chat?: Record<string, unknown>; auto?: boolean; schedule?: boolean } = {}) {
  const id = newId(), at = o.at ?? AT
  e.db.query('INSERT INTO chats (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, user, at, at)
  for (const [k, v] of Object.entries(o.chat ?? {})) e.db.query(`UPDATE chats SET ${k} = ? WHERE id = ?`).run(v as string, id)
  const m = store.insertMessage({ chatId: id, content, parentId: null, authorId: user, role: 'user', status: 'done' })
  e.db.query('UPDATE messages SET created_at = ?, auto_sent = ? WHERE id = ?').run(at, o.auto ? 1 : 0, m)
  e.db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(m, id)
  e.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, user_message_id, client_kind, schedule_id) VALUES (?, ?, ?, 'claude-code', 'done', ?, ?, ?)")
    .run(newId(), id, user, m, o.client === undefined ? 'web' : o.client, o.schedule ? 's1' : null)
  return id
}
const texts = () => readQuestions(e.db, NOW).map((q) => q.content)
const snap = () => buildSnapshot(e.db, e.files.rules(), { now: NOW, random: () => 0.5 })
/** the ids of the entries of these people whose line holds `has` */
const idsOf = (s: ReturnType<typeof snap>, has: string, users?: string[]) => s.entries.filter((x) => x.text.includes(has) && (!users || users.includes(x.user))).map((x) => x.id)
const team = (s: ReturnType<typeof snap>) => s.audiences.find((a) => a.key === 'team')!
function group(id: string, name: string, members: string[], since = '2026-11-01T00:00:00.000Z') {
  e.db.query('INSERT INTO groups (id, name) VALUES (?, ?)').run(id, name)
  for (const m of members) e.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(id, m)
  e.db.query('UPDATE group_member_since SET since = ? WHERE group_id = ?').run(since, id)
}

describe('the line of a message, the app\'s own prompts, the masks', () => {
  test('the first line that is not a quote; never a skill run or pasted text', () => {
    expect(questionLine('> Bob · 10:02\n> 내일 회의는 3시\n이거 요약해 줘\n뒤의 줄')).toBe('이거 요약해 줘')
    expect(questionLine('  회의록   정리해 줘  ')).toBe('회의록 정리해 줘')
    expect(questionLine('/humanizer 아래 글을 자연스럽게 다듬어 줘:\n글')).toBeNull()
    expect(questionLine('가'.repeat(201))).toBeNull()
    expect(questionLine('> only a quote')).toBeNull()
  })

  test('the app\'s own prompts in every language, as templates', () => {
    expect(isAppPrompt("Tell me 3 ways you can help with our team's work")).toBe(true)
    expect(isAppPrompt('우리 팀 일을 어떻게 도와줄 수 있는지 3가지만 알려 줘')).toBe(true)
    expect(isAppPrompt('Read the file `groups/x/plan.md` and summarize it')).toBe(true)
    expect(isAppPrompt('마케팅 폴더에서 브랜드 폴더와 스킬 폴더는 빼고, 파일 이름과 종류만 보고 내가 먼저 보면 좋을 것 3개를 골라 줘')).toBe(true)
    expect(isAppPrompt('회의록 요약해 줘')).toBe(false)
  })

  test('links, emails, numbers, secrets, mentions, people, projects and group chats are masked; group names stay', () => {
    e.db.query("INSERT INTO users (id, username, name, role) VALUES ('p9', 'minsu', '김민수', 'member')").run()
    e.db.query("INSERT INTO projects (id, name, folder_path) VALUES ('pr1', 'Phoenix', 'projects/Phoenix')").run()
    e.db.query("INSERT INTO rooms (id, kind, name, created_at, activity_at) VALUES ('r1', 'group', '비밀 TF', ?, ?)").run(AT, AT)
    const mask = masker(teamNames(e.db))
    const out = mask('Alice Kim 에게 https://acme.example/x 보내고 bob@acme.example, 010-1234-5678 에 연락, 김 과장 이랑 김민수 씨, @erin 그리고 Phoenix 일정 비밀 TF 에서 Marketing 보고서 report.pdf groups/finance/a.md sk-ant-api03-' + 'x'.repeat(90))
    for (const gone of ['Alice', 'Kim', 'acme.example', 'bob@', '1234', '김 과장', '김민수', '@erin', 'Phoenix', '비밀 TF', 'report.pdf', 'groups/finance', 'sk-ant']) expect({ gone, out: out.includes(gone) }).toEqual({ gone, out: false })
    expect(out).toContain('Marketing')
    expect(out).toContain('(person)')
    expect(out).toContain('(link)')
    expect(out).toContain('(project)')
    e.db.query("DELETE FROM users WHERE id = 'p9'").run()
  })
})

describe('which messages count (asserted on what would reach the AI)', () => {
  test('only what a person typed in the app in their own AI chat, since the switch, in the window', () => {
    ask('p1', 'OK question')
    e.db.query("INSERT INTO projects (id, name, folder_path) VALUES ('pr1', 'Atlas', 'projects/atlas')").run()
    ask('p1', 'PROJECT chat', { chat: { project_id: 'pr1' } })
    ask('p1', 'SHARED project chat', { chat: { project_id: 'pr1', shared_at: AT } })
    ask('p1', 'ROOM ai session', { chat: { room_id: 'room-1' } })
    ask('p1', 'SIDE chat', { chat: { side_room_id: 'room-1' } })
    const slack = ask('p1', 'SLACK question', { client: 'slack' })
    e.db.query("INSERT INTO slack_threads (team_id, channel_id, thread_ts, user_id, chat_id, created_at) VALUES ('T', 'C', '1', 'p1', ?, ?)").run(slack, AT)
    const slack2 = ask('p1', 'SLACK thread typed', {})
    e.db.query("INSERT INTO slack_threads (team_id, channel_id, thread_ts, user_id, chat_id, created_at) VALUES ('T', 'C', '2', 'p1', ?, ?)").run(slack2, AT)
    const conf = ask('p1', 'CONFIDENTIAL chat')
    e.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(conf)
    ask('p1', 'SCHEDULED run', { client: 'schedule' })
    ask('p1', 'SCHEDULE id', { schedule: true })
    ask('p1', 'SERVER made request', { client: null })
    ask('p1', 'AUTO sent', { auto: true })
    ask('p1', 'DELETED chat', { chat: { deleted_at: AT } })
    ask('p1', 'OLD message', { at: '2026-10-01T00:00:00.000Z' })
    ask('p1', 'BEFORE the switch', { at: '2026-10-31T00:00:00.000Z' })
    const internal = ask('p1', 'INTERNAL chat')
    e.db.query('INSERT INTO onboarding_file_ranks (chat_id, user_id, material, created_at) VALUES (?, ?, ?, ?)').run(internal, 'p1', '{}', AT)
    ask('p2', 'DISABLED account')
    e.db.query("UPDATE users SET status = 'disabled' WHERE id = 'p2'").run()
    expect(texts()).toEqual(['OK question'])
  })

  test('the active branch only; a parent in another chat is never followed', () => {
    const c = ask('p1', 'EDITED away')
    const replaced = store.insertMessage({ chatId: c, content: 'kept', parentId: null, authorId: 'p1', role: 'user', status: 'done' })
    e.db.query('UPDATE messages SET created_at = ? WHERE id = ?').run(AT, replaced)
    e.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, user_message_id, client_kind) VALUES (?, ?, 'p1', 'claude-code', 'done', ?, 'web')").run(newId(), c, replaced)
    e.db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(replaced, c)
    const other = ask('p2', 'OTHER person secret')
    const leaf = store.insertMessage({ chatId: c, content: 'child', parentId: (e.db.query('SELECT active_leaf_id AS id FROM chats WHERE id = ?').get(other) as { id: string }).id, authorId: 'p1', role: 'user', status: 'done' })
    e.db.query('UPDATE messages SET created_at = ? WHERE id = ?').run(AT, leaf)
    e.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, user_message_id, client_kind) VALUES (?, ?, 'p1', 'claude-code', 'done', ?, 'web')").run(newId(), c, leaf)
    e.db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(leaf, c)
    expect(texts().sort()).toEqual(['OTHER person secret', 'child'])
  })

  test('the switch turned off and on again: only what was sent after', () => {
    ask('p1', 'before')
    oftenAskedSwitched(e.db, false, NOW)
    oftenAskedSwitched(e.db, true, new Date('2026-11-16T00:00:00.000Z'))
    ask('p1', 'after', { at: '2026-11-17T00:00:00.000Z' })
    expect(texts()).toEqual(['after'])
  })

  test('the snapshot: masked lines, one per person per line, the app\'s prompts and skill runs out, no person in the material', () => {
    for (let i = 0; i < 3; i++) ask('p1', '회의록 요약해 줘')
    ask('p1', '/weekly 이번 주 보고')
    ask('p1', "Tell me 3 ways you can help with our team's work")
    ask('p2', 'Alice Kim 한테 보낼 메일 써 줘')
    const s = snap()
    expect(s.entries.map((x) => x.text).sort()).toEqual(['(person) 한테 보낼 메일 써 줘', '회의록 요약해 줘'])
    expect(s.entries.every((x) => /^q\d+$/.test(x.id))).toBe(true)
  })
})

describe('the checks on the AI\'s answer', () => {
  /** p1–p5 ask about meeting notes; the team audience has its 5 askers */
  function five() {
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5']) ask(p, '회의록 요약해 줘')
  }

  test('one person asking 20 times, or two people, never make an item; three people do', () => {
    five()
    for (let i = 0; i < 20; i++) ask('p6', `Acme 견적서 ${'다시 '.repeat(i)}써 줘`)
    ask('p7', 'Acme 견적서 써 줘')
    const s = snap()
    const a = team(s)
    expect(passing(s, a, [{ text: 'Acme 견적서 써 줘', ids: idsOf(s, 'Acme', ['p6']) }])).toEqual([])
    expect(passing(s, a, [{ text: 'Acme 견적서 써 줘', ids: idsOf(s, 'Acme') }])).toEqual([])
    expect(passing(s, a, [{ text: '회의록 요약해 줘', ids: idsOf(s, '회의록') }])).toEqual([{ text: '회의록 요약해 줘', people: 5 }])
  })

  test('the server counts people itself: ids of 2 people, or a third who shares only small words, drop the item', () => {
    five()
    ask('p6', '어떻게 해 줘')
    const s = snap()
    const a = team(s)
    const two = idsOf(s, '회의록', ['p1', 'p2'])
    expect(passing(s, a, [{ text: '회의록 요약해 줘', ids: two }])).toEqual([])
    expect(passing(s, a, [{ text: '회의록 요약해 줘', ids: [...two, ...idsOf(s, '어떻게')] }])).toEqual([])
  })

  test('a word only one or two people typed drops the sentence (a customer\'s name), in any spelling', () => {
    five()
    for (const p of ['p1', 'p2']) ask(p, '애크미 회의록 요약해 줘')
    const s = snap()
    const a = team(s)
    const ids = idsOf(s, '회의록')
    expect(passing(s, a, [{ text: '애크미 회의록 요약해 줘', ids }])).toEqual([])
    // a transliteration, a longer form, a translation: nobody typed them, so they never pass as "the AI's own words"
    for (const text of ['Acme 회의록 요약해 줘', '애크미사 회의록 요약해 줘', '현대자동차 회의록 요약해 줘', 'Summarize the Hyundai meeting notes'])
      expect({ text, passed: passing(s, a, [{ text, ids }]).length }).toEqual({ text, passed: 0 })
    // a Japanese sentence without spaces naming one person's client
    expect(passing(s, a, [{ text: '田中商事の議事録をまとめてください', ids }])).toEqual([])
  })

  test('digits, links, file names, placeholders and the team\'s names drop it', () => {
    five()
    const s = snap()
    const a = team(s)
    const ids = idsOf(s, '회의록')
    for (const text of ['회의록 3줄로 요약해 줘', '회의록 요약해서 https://x.example 에', '회의록.pdf 요약해 줘', '(person) 회의록 요약해 줘', 'Alice 회의록 요약해 줘', '김민수 회의록 요약해 줘', '회의록을 요약해 줘 #general'])
      expect({ text, passed: passing(s, a, [{ text, ids }]).length }).toEqual({ text, passed: 0 })
  })

  test('circles: three people all in one group make no item for the whole team, but do for their group', () => {
    group('g-sales', 'Sales', ['p1', 'p2', 'p3', 'p4', 'p5'])
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5']) ask(p, '거래처 견적서 써 줘')
    ask('p6', '회의록 요약해 줘'); ask('p7', '회의록 요약해 줘')
    const s = snap()
    const ids = idsOf(s, '견적서')
    // the team: everyone who typed it is in Sales, which leaves p6, p7 and the seed's people out
    expect(passing(s, team(s), [{ text: '거래처 견적서 써 줘', ids }])).toEqual([])
    expect(passing(s, s.audiences.find((a) => a.key === 'g-sales')!, [{ text: '거래처 견적서 써 줘', ids }])).toEqual([{ text: '거래처 견적서 써 줘', people: 5 }])
  })

  test('circles: a team project\'s people and a group chat\'s people keep their topic too', () => {
    group('g-ops', 'Ops', PEOPLE)
    e.db.query("INSERT INTO projects (id, name, folder_path) VALUES ('pr1', 'Falcon', 'projects/falcon')").run()
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) ask(p, '회의록 요약해 줘')
    // in the fixture, projects/falcon is read by alice and the finance group (bob): two of the team
    for (const p of ['alice', 'bob']) ask(p, '착륙 계획 정리해 줘')
    e.db.query("INSERT INTO rooms (id, kind, name, created_at, activity_at) VALUES ('r1', 'group', 'TF', ?, ?)").run(AT, AT)
    for (const p of ['p1', 'p2', 'p3']) { e.db.query("INSERT INTO room_members (room_id, user_id, joined_at) VALUES ('r1', ?, ?)").run(p, AT); ask(p, '인수 검토 정리해 줘') }
    const s = snap()
    const ops = s.audiences.find((a) => a.key === 'g-ops')!
    expect(passing(s, ops, [{ text: '인수 검토 정리해 줘', ids: idsOf(s, '인수') }])).toEqual([])
    expect(passing(s, team(s), [{ text: '인수 검토 정리해 줘', ids: idsOf(s, '인수') }])).toEqual([])
    // three outside any smaller circle: fine
    ask('p4', '인수 검토 정리해 줘')
    const s2 = snap()
    expect(passing(s2, s2.audiences.find((a) => a.key === 'g-ops')!, [{ text: '인수 검토 정리해 줘', ids: idsOf(s2, '인수') }])).toHaveLength(1)
  })
})

describe('the attacks the security review tried (each one must fail)', () => {
  /** p1–p5 asked something, so the team has its 5 askers */
  function floor() { for (const p of ['p1', 'p2', 'p3', 'p4', 'p5']) ask(p, '회의록 요약해 줘') }

  test('a longer word never passes from a shorter one people typed ("Williams" from "will", "Salesforce" from "sales")', () => {
    floor()
    for (const p of ['p1', 'p2', 'p3']) { ask(p, 'will you write an email about the contract'); ask(p, 'sales contract proposal draft') }
    const s = snap()
    const a = team(s)
    expect(passing(s, a, [{ text: 'Write an email to Williams about the contract', ids: idsOf(s, 'will') }])).toEqual([])
    expect(passing(s, a, [{ text: 'Draft the Salesforce contract proposal', ids: idsOf(s, 'sales') }])).toEqual([])
    // what they did type passes
    expect(passing(s, a, [{ text: 'Write an email about the contract', ids: idsOf(s, 'will') }])).toHaveLength(1)
  })

  test('one person\'s topic never passes with others who only share a verb or another word', () => {
    floor()
    ask('p1', 'Update my resume for the job interview at Samsung'); ask('p2', 'Update the weekly report'); ask('p3', 'Update the price list')
    ask('p1', '삼성 면접 이력서 수정해 줘'); ask('p2', '주간 보고서 수정해 줘'); ask('p3', '가격표 수정해 줘')
    const s = snap()
    const a = team(s)
    expect(passing(s, a, [{ text: 'Update my resume for a job interview', ids: idsOf(s, 'Update') }])).toEqual([])
    expect(passing(s, a, [{ text: '이력서 수정해 줘', ids: idsOf(s, '수정') }])).toEqual([])
    // a sentence of verbs only says nothing: no item
    expect(passing(s, a, [{ text: 'Update it', ids: idsOf(s, 'Update') }])).toEqual([])
  })

  test('given names, names written together, Japanese names and accents are masked and never pass', () => {
    e.db.query("INSERT INTO users (id, username, name, role) VALUES ('p8', 'minsu', '김민수', 'member'), ('p9', 'seoyeon', '이 서연', 'member'), ('q1', 'tanaka', '田中 太郎', 'member'), ('q2', 'li', 'Li Wei', 'member'), ('q3', 'jgarcia', 'José García', 'member')").run()
    const n = teamNames(e.db)
    const mask = masker(n)
    expect(mask('민수한테 메일 써 줘')).toBe('(person)한테 메일 써 줘')
    expect(mask('이서연한테 보고서 보내 줘')).toBe('(person)한테 보고서 보내 줘')
    expect(mask('田中にメールを書いて')).toBe('(person)にメールを書いて')
    expect(mask('田中太郎さんへの返信')).toBe('(person)への返信')
    expect(mask('Ask Li about it, do it now')).toBe('Ask (person) about it, do it now')
    expect(mask('Email Jose Garcia today')).toBe('Email (person) today')
    for (const text of ['민수한테 메일 써 줘', '이서연한테 보고서 보내 줘', '田中へのメールを作成', 'Email Jose about the report', 'Ask Li about the report'])
      expect({ text, ok: genericShape(text, n) }).toEqual({ text, ok: false })
    expect(genericShape('Ask the team about the report', n)).toBe(true)
    e.db.query("DELETE FROM users WHERE id IN ('p8', 'p9', 'q1', 'q2', 'q3')").run()
  })

  test('invisible characters, emoji and symbols are never in a sentence', () => {
    const n = teamNames(e.db)
    for (const text of ['Sales​force 보고서 써 줘', '회의록 요약 😀', '회의록 → 요약', '회의록 요약 ①', '회의록 요약 $'])
      expect({ text, ok: genericShape(text, n) }).toEqual({ text, ok: false })
    expect(genericShape('회의록 요약해 줘', n)).toBe(true)
  })

  // (these two follow the real clock: the triggers stamp the time they run)
  const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString()
  const realNow = () => new Date(Date.now() + 60_000)

  test('a chat that was in a project counts only what came after it left', () => {
    e.db.query("INSERT INTO projects (id, name, folder_path) VALUES ('pr1', 'Atlas', 'projects/atlas')").run()
    const c = ask('p1', 'TYPED in the project', { chat: { project_id: 'pr1' }, at: ago(2) })
    expect(readQuestions(e.db, realNow())).toEqual([])
    // the project deleted (its chats set free) or the chat moved out: the old question still never counts
    e.db.query('UPDATE chats SET project_id = NULL WHERE id = ?').run(c)
    expect(readQuestions(e.db, realNow())).toEqual([])
    const later = store.insertMessage({ chatId: c, content: 'TYPED after it left', parentId: (e.db.query('SELECT active_leaf_id AS id FROM chats WHERE id = ?').get(c) as { id: string }).id, authorId: 'p1', role: 'user', status: 'done' })
    e.db.query('UPDATE messages SET created_at = ? WHERE id = ?').run(new Date(Date.now() + 1000).toISOString(), later)
    e.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, user_message_id, client_kind) VALUES (?, ?, 'p1', 'claude-code', 'done', ?, 'web')").run(newId(), c, later)
    e.db.query('UPDATE chats SET active_leaf_id = ?, updated_at = ? WHERE id = ?').run(later, new Date(Date.now() + 1000).toISOString(), c)
    expect(readQuestions(e.db, realNow()).map((q) => q.content)).toEqual(['TYPED after it left'])
  })

  test('shrinking a group around one person restarts its count: what they asked before never counts there', () => {
    group('g-x', 'X', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], ago(10))
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) ask(p, '연봉 자료 요약해 줘', { at: ago(5) })
    const groupOf = () => buildSnapshot(e.db, e.files.rules(), { now: realNow(), random: () => 0.5 }).audiences.find((a) => a.key === 'g-x')!
    expect(groupOf().entries).toHaveLength(6)
    // one edit of the group (everyone deleted and added back at once) changes nothing
    e.db.query("DELETE FROM group_members WHERE group_id = 'g-x'").run()
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) e.db.query("INSERT INTO group_members (group_id, user_id) VALUES ('g-x', ?)").run(p)
    expect(groupOf().entries).toHaveLength(6)
    // p6 taken out for real (yesterday, not added back within 10 seconds): nothing from before counts for the group
    e.db.query("DELETE FROM group_members WHERE group_id = 'g-x' AND user_id = 'p6'").run()
    e.db.query("UPDATE group_member_since SET left_at = ? WHERE group_id = 'g-x' AND user_id = 'p6'").run(ago(1))
    expect(groupOf().entries).toEqual([])
    // added back later: the group still counts only from that removal
    e.db.query("INSERT INTO group_members (group_id, user_id) VALUES ('g-x', 'p6')").run()
    expect(e.db.query("SELECT COUNT(*) n FROM group_count_from WHERE group_id = 'g-x'").get()).toEqual({ n: 1 })
    expect(groupOf().entries).toEqual([])
  })

  test('turned off and on while the AI wrote: what it was given is from before, nothing is stored', () => {
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5']) ask(p, '회의록 요약해 줘')
    const s = snap()
    oftenAskedSwitched(e.db, false, NOW)
    oftenAskedSwitched(e.db, true, new Date('2026-11-19T00:00:00.000Z'))
    storeLists(e.db, s, [{ text: '회의록 요약해 줘', ids: idsOf(s, '회의록') }], NOW)
    expect(e.db.query('SELECT COUNT(*) n FROM often_asked_items').get()).toEqual({ n: 0 })
  })
})

describe('the lists and who gets which', () => {
  const item = (s: ReturnType<typeof snap>, text: string, has: string): AiItem => ({ text, ids: idsOf(s, has) })
  /** three items every one of p1–p5 asked */
  function base() {
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5']) { ask(p, '회의록 요약해 줘'); ask(p, '주간 보고서 초안 써 줘'); ask(p, '고객 메일 답장 써 줘') }
    const s = snap()
    return { s, items: [item(s, '회의록 요약해 줘', '회의록'), item(s, '주간 보고서 초안 써 줘', '보고서'), item(s, '고객 메일 답장 써 줘', '메일')] }
  }

  test('the floor: fewer than 5 people who asked anything make no list, for the team or a group', () => {
    for (const p of ['p1', 'p2', 'p3', 'p4']) { ask(p, '회의록 요약해 줘'); ask(p, '주간 보고서 초안 써 줘'); ask(p, '고객 메일 답장 써 줘') }
    const s = snap()
    storeLists(e.db, s, [item(s, '회의록 요약해 줘', '회의록'), item(s, '주간 보고서 초안 써 줘', '보고서'), item(s, '고객 메일 답장 써 줘', '메일')], NOW)
    expect(oftenAskedFor(e.db, 'p1', NOW)).toEqual({ scope: 'none', items: [] })
  })

  test('the team list for everyone with no group list; no counts, ids, times or names in the answer', () => {
    const { s, items } = base()
    storeLists(e.db, s, items, NOW)
    const r = oftenAskedFor(e.db, 'p6', NOW)
    expect(r).toEqual({ scope: 'team', items: ['고객 메일 답장 써 줘', '주간 보고서 초안 써 줘', '회의록 요약해 줘'] })
    const json = JSON.stringify(r)
    for (const x of [...PEOPLE, 'Person', '2026', '5']) expect({ x, inIt: json.includes(x) }).toEqual({ x, inIt: false })
    // under 3 items: nothing
    e.db.query("DELETE FROM often_asked_items WHERE text = '회의록 요약해 줘'").run()
    expect(oftenAskedFor(e.db, 'p6', NOW)).toEqual({ scope: 'none', items: [] })
  })

  test('a group\'s list only for its members, from the day they joined; several groups take turns', () => {
    group('g-a', '마케팅', ['p1', 'p2', 'p3', 'p4', 'p5'])
    group('g-b', '영업', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
    // p6 asks too, so 영업's people are not all inside 마케팅 (which leaves p6 out)
    ask('p6', '회의록 요약해 줘'); ask('p6', '주간 보고서 초안 써 줘'); ask('p6', '고객 메일 답장 써 줘')
    const { s, items } = base()
    storeLists(e.db, s, items, NOW)
    expect(oftenAskedFor(e.db, 'p6', NOW)).toMatchObject({ scope: 'group', group: '영업' })
    expect(oftenAskedFor(e.db, 'p1', NOW)).toMatchObject({ scope: 'groups' })
    expect(new Set(oftenAskedFor(e.db, 'p1', NOW).items).size).toBe(3)
    // p7 is in neither; the team's list would need askers outside 영업, which holds all six: nothing
    expect(oftenAskedFor(e.db, 'p7', NOW)).toEqual({ scope: 'none', items: [] })
    // leaving the group stops it at once
    e.db.query("DELETE FROM group_members WHERE group_id = 'g-b' AND user_id = 'p6'").run()
    expect(oftenAskedFor(e.db, 'p6', NOW).scope).not.toBe('group')
  })

  test('a question sent before someone joined a group never counts for it', () => {
    group('g-new', 'New', ['p1', 'p2', 'p3', 'p4', 'p5'], '2026-11-18T00:00:00.000Z')
    const { s } = base()
    expect(s.audiences.find((a) => a.key === 'g-new')!.entries).toEqual([])
    // one edit of the group (all deleted and added back at once) keeps the join date; added back later starts again
    const since = () => (e.db.query("SELECT since FROM group_member_since WHERE group_id = 'g-new' AND user_id = 'p1'").get() as { since: string }).since
    e.db.query("DELETE FROM group_members WHERE group_id = 'g-new' AND user_id = 'p1'").run()
    e.db.query("INSERT INTO group_members (group_id, user_id) VALUES ('g-new', 'p1')").run()
    expect(since()).toBe('2026-11-18T00:00:00.000Z')
    e.db.query("DELETE FROM group_members WHERE group_id = 'g-new' AND user_id = 'p1'").run()
    e.db.query("UPDATE group_member_since SET left_at = '2020-01-01T00:00:00.000Z' WHERE group_id = 'g-new' AND user_id = 'p1'").run()
    e.db.query("INSERT INTO group_members (group_id, user_id) VALUES ('g-new', 'p1')").run()
    expect(since()).not.toBe('2026-11-18T00:00:00.000Z')
  })

  test('an item that stops passing stays 3 days, then goes; so does a list no run renewed', () => {
    const { s, items } = base()
    storeLists(e.db, s, items, NOW)
    storeLists(e.db, s, items.slice(0, 2), new Date('2026-11-22T09:00:00.000Z'))
    expect(oftenAskedFor(e.db, 'p6', new Date('2026-11-22T10:00:00.000Z')).items).toHaveLength(3)
    storeLists(e.db, s, items.slice(0, 2), new Date('2026-11-24T09:00:00.000Z'))
    expect(oftenAskedFor(e.db, 'p6', new Date('2026-11-24T10:00:00.000Z')).items).toEqual([])
    expect(e.db.query('SELECT COUNT(*) n FROM often_asked_items').get()).toEqual({ n: 2 })
  })

  test('the switch off: every list gone, nothing shown, nothing stored; on again: counting starts again', () => {
    const { s, items } = base()
    storeLists(e.db, s, items, NOW)
    updateTeamSettings(e.db, { oftenAsked: false })
    oftenAskedSwitched(e.db, false, NOW)
    expect(e.db.query('SELECT COUNT(*) n FROM often_asked_items').get()).toEqual({ n: 0 })
    expect(oftenAskedFor(e.db, 'p6', NOW)).toEqual({ scope: 'none', items: [] })
    storeLists(e.db, s, items, NOW)
    expect(e.db.query('SELECT COUNT(*) n FROM often_asked_items').get()).toEqual({ n: 0 })
    updateTeamSettings(e.db, { oftenAsked: true })
    oftenAskedSwitched(e.db, true, NOW)
    expect(readQuestions(e.db, new Date('2026-11-21T00:00:00.000Z'))).toEqual([])
    expect(e.db.query('SELECT value FROM settings WHERE key = ?').get(LAST_RUN_KEY)).not.toBeNull()
  })
})
