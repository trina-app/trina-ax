// Members contribute their own skills and files (docs/DECISIONS.md "MC"; server/src/skills/suggestions.ts
// contributeSkills / approveFolder, server/src/onboarding/suggestions.ts, migration 257):
//   - the `contribute` line comes under a member's FIRST successful run of the landing skill only (not a failed or a
//     scheduled one, not a later one, never for an owner or admin, never under another skill), ranks above [PPT로
//     만들기], closes for good; it names the team folder only when the member can write it, and on a phone without one
//     the next suggestion takes the slot;
//   - a batch of skill folders: each checked again with the owner's import checks; what the owner's import refuses is
//     refused here (a key or key file, scripts, a plugin's skill, too big, not a skill) and nothing of it is stored; at
//     most 10 in one send, 20 waiting per member; members only;
//   - one Inbox line per batch for the owners and admins ("Bob Lee", 2), never a skill's name; a skills manager who is
//     not an owner or admin neither sees nor approves a member's folder; the suggester cannot approve it;
//   - approving writes skills/<name>/ with its files as the approver, keeps the member's name on the skill, tells the
//     member, and never moves the invite's or the goal's skill; turning it down drops its files;
//   - a member writes neither skills/ nor someone else's users/<id>/ directly.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, CONTRIBUTE_LIMITS, GENERAL_TASKS_SKILL, PPT_SUGGEST_CHARS, SKILL_SHARE_LIMITS, type ContributedSkills, type ShareSkillIn, type SkillSuggestion } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { notificationsOf } from '../../server/src/notifications/service'
import { landingSkill, readWelcome } from '../../server/src/onboarding/welcome'
import { focusSkill, goalProgress } from '../../server/src/onboarding/goal'
import { skillMakerName } from '../../server/src/skills/author'
import { MIGRATIONS_DIR } from '../../server/src/db'

setDefaultTimeout(90_000)

let h: Harness
let teamFolder = ''
const socks: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-member-contribute' })
  // the owner's start: the general pack (할 일 정리 is the landing skill) and the team's group with its folder
  await h.api('dana').call(API.updateWelcome, { body: {} })
  await h.api('dana').call(API.setupWelcomeTeam)
  const g = readWelcome(h.ctx)!.teamGroup!
  teamFolder = g.folder.replace(/\/+$/, '')
  // bob joined through the team link (its group); alice another way (no group)
  h.ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(g.id, 'bob')
  for (const u of ['dana', 'carol', 'bob']) { socks[u] = await h.ws(u, { windowId: `win-mc-${u}` }); await socks[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

const post = (user: string, p: string, body: unknown) => h.req(user, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const put = (user: string, p: string, body: unknown) => h.req(user, p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** One answer of a person in a new chat of theirs: the turn, its answer and the skill it ran. */
function answer(userId: string, o: { skill?: string; status?: string; scheduleId?: string; content?: string } = {}) {
  const chatId = crypto.randomUUID(), messageId = crypto.randomUUID(), turnId = crypto.randomUUID()
  const db = h.ctx.db
  db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(chatId, userId)
  db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'assistant', ?, 'done')").run(messageId, chatId, o.content ?? 'Done.')
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, message_id, schedule_id) VALUES (?, ?, ?, 'claude', ?, ?, ?)").run(turnId, chatId, userId, o.status ?? 'done', messageId, o.scheduleId ?? null)
  if (o.skill) db.query("INSERT INTO turn_skill_runs (turn_id, skill_path, skill_name, source) VALUES (?, ?, ?, 'command')").run(turnId, o.skill, o.skill.split('/').at(-2)!)
  return { chatId, messageId }
}
const suggestionFor = async (user: string, a: { chatId: string; messageId: string }, phone = false) =>
  (await h.api(user).call(API.getResultSuggestion, { query: { chatId: a.chatId, messageId: a.messageId, ...(phone ? { phone: '1' as const } : {}) } })).suggestion

// fake keys, obviously not real, that still match shared/src/secrets.ts
const SLACK = 'xoxb-0000000000-FAKE-NOT-REAL'
const OPENAI = 'sk-FAKE0000notreal0000KEY1234'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')
const md = (name: string, body = '# Quote\n1. Read the price list.\n2. Write the quote.\n', meta = '') => `---\nname: ${name}\ndescription: ${name} — writes a quote from the price list\n${meta}---\n${body}`
const skill = (name: string, o: Partial<ShareSkillIn> & { body?: string; meta?: string; extra?: ShareSkillIn['files'] } = {}): ShareSkillIn =>
  ({ name, origin: o.origin ?? 'user', files: o.files ?? [{ path: 'SKILL.md', text: md(name, o.body, o.meta) }, ...(o.extra ?? [])] })
const contribute = (user: string, skills: ShareSkillIn[], app?: 'claude' | 'codex') => post(user, '/api/skills/suggestions/batch', { ...(app ? { app } : {}), skills })
const pendingOf = (user: string) => (h.ctx.db.query("SELECT COUNT(*) AS n FROM skill_suggestions WHERE suggester_id = ? AND status = 'pending'").get(user) as { n: number }).n
const clearSuggestions = () => { h.ctx.db.query('DELETE FROM skill_suggestions').run(); h.ctx.db.query('DELETE FROM skill_notices').run() }
/** Everything the database holds as text, for "the key is nowhere". */
const dbText = () => {
  const out: string[] = []
  for (const t of h.ctx.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    try { out.push(JSON.stringify(h.ctx.db.query(`SELECT * FROM "${t.name}"`).all(), (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : v))) } catch { /* virtual */ }
  }
  return out.join('\n')
}

describe('the contribute line under a member\'s first good run of the landing skill', () => {
  test('the landing skill is 할 일 정리 (nothing shared); bob writes the team folder, alice does not', () => {
    expect(landingSkill(h.ctx)).toBe(GENERAL_TASKS_SKILL)
    expect(teamFolder).toMatch(/^groups\//)
  })

  test('first done run only (not a failed or scheduled one, not a later one); above the PPT; with the team folder bob can write', async () => {
    const long = '## 이번 주\n' + '가'.repeat(PPT_SUGGEST_CHARS)
    // a failed run and a scheduled run come first: not good runs
    expect(await suggestionFor('bob', answer('bob', { skill: GENERAL_TASKS_SKILL, status: 'error', content: long }))).toBeNull()
    answer('bob', { skill: GENERAL_TASKS_SKILL, scheduleId: 'sched-mc' })
    const first = answer('bob', { skill: GENERAL_TASKS_SKILL, content: long })
    // the contribute line, not the PPT that a long answer gets
    expect(await suggestionFor('bob', first)).toEqual({ kind: 'contribute', key: 'contribute', folder: teamFolder })
    // the same answer on a phone: the folder link only (it has one)
    expect(await suggestionFor('bob', first, true)).toEqual({ kind: 'contribute', key: 'contribute', folder: teamFolder })
    // a later run: the usual suggestion (PPT here), never the line again
    expect(await suggestionFor('bob', answer('bob', { skill: GENERAL_TASKS_SKILL, content: long }))).toEqual({ kind: 'ppt', key: 'ppt' })
    // the first answer stays the first: asked again, it still shows (until ✕)
    expect((await suggestionFor('bob', first))?.kind).toBe('contribute')
  })

  test('alice cannot write a team folder: no files part; on a phone the next suggestion instead', async () => {
    const long = '가'.repeat(PPT_SUGGEST_CHARS)
    const first = answer('alice', { skill: GENERAL_TASKS_SKILL, content: long })
    expect(await suggestionFor('alice', first)).toEqual({ kind: 'contribute', key: 'contribute', folder: null })
    expect(await suggestionFor('alice', first, true)).toEqual({ kind: 'ppt', key: 'ppt' })
  })

  test('never for an owner or admin, never under another skill or no skill', async () => {
    expect(await suggestionFor('dana', answer('dana', { skill: GENERAL_TASKS_SKILL }))).toBeNull()
    expect(await suggestionFor('carol', answer('carol', { skill: GENERAL_TASKS_SKILL }))).toBeNull()
    expect(await suggestionFor('erin', answer('erin', { skill: 'skills/general/other/SKILL.md' }))).toBeNull()
    expect(await suggestionFor('erin', answer('erin', {}))).toBeNull()
  })

  test('✕ closes it for good', async () => {
    const first = answer('erin', { skill: GENERAL_TASKS_SKILL })
    expect((await suggestionFor('erin', first))?.kind).toBe('contribute')
    expect((await post('erin', '/api/onboarding/suggestion/dismiss', { key: 'contribute' })).status).toBe(204)
    expect(await suggestionFor('erin', first)).toBeNull()
    expect(await suggestionFor('erin', first, true)).toBeNull()
  })
})

describe('a batch of skill folders', () => {
  test('two skills: two suggestions with their files, outside the team files; one Inbox line for each owner and admin, no skill name', async () => {
    clearSuggestions()
    const r = await contribute('bob', [
      skill('quote-maker', { meta: 'metadata:\n  title: 견적 만들기\n', extra: [{ path: 'templates/quote.md', text: '| item | price |\n' }, { path: 'logo.png', base64: PNG }] }),
      skill('Weekly Report!'),
    ])
    expect(r.status).toBe(201)
    const out = await r.json() as ContributedSkills
    expect(out.refused).toEqual([])
    expect(out.items.map((s) => [s.name, s.source.kind, s.status, s.canReview])).toEqual([['quote-maker', 'folder', 'pending', false], ['weekly-report', 'folder', 'pending', false]])
    expect(out.items[0]!.folder).toMatchObject({ app: 'claude', title: '견적 만들기', personalPath: false, sameName: null })
    expect(out.items[0]!.folder!.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'logo.png', 'templates/quote.md'])
    expect(out.items[0]!.content).toContain('Write the quote.')
    expect(out.items.every((s) => s.batchId === out.batchId)).toBe(true)
    // kept outside the team files
    expect(fs.existsSync(path.join(h.team, 'skills', 'quote-maker'))).toBe(false)
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM skill_suggestion_files').get() as { n: number }).n).toBe(4)
    // one line per batch for the owner and the admin; nothing for the members
    const n = notificationsOf(h.ctx)
    for (const u of ['dana', 'carol']) {
      const items = n.list(u, {}).items.filter((i) => i.code === 'skill.suggested')
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ sourceId: out.batchId, link: 'skills', contribution: { name: 'Bob Lee', n: 2 } })
      expect(JSON.stringify(items)).not.toMatch(/quote|weekly|견적/i)
    }
    for (const u of ['alice', 'bob', 'erin']) expect(n.list(u, {}).items.filter((i) => i.code === 'skill.suggested')).toHaveLength(0)
    // and one live notice, which opens Skills › 검토 at that batch
    const live = await socks.dana!.next('notice', (f) => (f.data as { link?: string }).link === `/skills?batch=${out.batchId}`)
    expect((live.data as { message: string }).message).toContain('Bob Lee')
  })

  test('what the owner\'s import refuses is refused, and nothing of it is stored (the key nowhere)', async () => {
    clearSuggestions()
    const many = Array.from({ length: 9 }, (_, i) => ({ path: `ref/part-${i}.md`, text: 'x'.repeat(120 * 1024) }))
    const r = await contribute('bob', [
      skill('slack-poster', { body: `# Post\nUse the token ${SLACK} to post.\n` }),
      skill('env-file', { extra: [{ path: '.env', text: 'HELLO=1\n' }] }),
      skill('nested-key', { extra: [{ path: 'notes/config.md', text: `OPENAI_API_KEY=${OPENAI}\n` }] }),
      skill('runs-python', { body: '# Run\n1. Run `python3 scripts/make.py` with the data.\n', extra: [{ path: 'scripts/make.py', text: '' }] }),
      skill('from-plugin', { origin: 'plugin' }),
      skill('too-big', { extra: many }),
      skill('no-manifest', { files: [{ path: 'README.md', text: '# not a skill\n' }] }),
    ])
    expect(r.status).toBe(201)
    const out = await r.json() as ContributedSkills
    expect(out.batchId).toBeNull()
    expect(out.items).toEqual([])
    expect(Object.fromEntries(out.refused.map((x) => [x.name, x.reason]))).toEqual({
      'slack-poster': 'secret', 'env-file': 'secret', 'nested-key': 'secret', 'runs-python': 'scripts', 'from-plugin': 'plugin', 'too-big': 'too_big', 'no-manifest': 'not_skill',
    })
    expect(pendingOf('bob')).toBe(0)
    const all = dbText()
    for (const k of [SLACK, OPENAI, 'HELLO=1']) expect(all).not.toContain(k)
    // nothing to tell anyone
    expect(notificationsOf(h.ctx).list('dana', {}).items.filter((i) => i.code === 'skill.suggested')).toHaveLength(0)
    // a file over a skill file's size: the body itself is refused
    expect((await contribute('bob', [skill('huge', { extra: [{ path: 'big.md', text: 'x'.repeat(SKILL_SHARE_LIMITS.fileBytes + 1) }] })])).status).toBe(400)
  })

  test('a script the skill does not need is left out (never stored); a path on the member\'s computer is marked', async () => {
    clearSuggestions()
    const out = await (await contribute('bob', [skill('local-notes', { body: '# Notes\nRead /Users/someone/Documents/notes.md first.\n', extra: [{ path: 'tool.sh', text: 'echo hi' }] })])).json() as ContributedSkills
    expect(out.items[0]!.folder).toMatchObject({ personalPath: true, scriptsDropped: 1 })
    expect(out.items[0]!.folder!.files.map((f) => f.path)).toEqual(['SKILL.md'])
    expect(dbText()).not.toContain('echo hi')
  })

  test('limits: at most 10 in one send; at most 20 waiting per member (nothing stored past it); a name already waiting', async () => {
    clearSuggestions()
    expect(CONTRIBUTE_LIMITS).toEqual({ batch: 10, open: 20 })
    const eleven = Array.from({ length: 11 }, (_, i) => skill(`s-${i}`))
    expect((await contribute('bob', eleven)).status).toBe(400)
    expect(pendingOf('bob')).toBe(0)
    expect((await contribute('bob', eleven.slice(0, 10))).status).toBe(201)
    expect((await contribute('bob', Array.from({ length: 8 }, (_, i) => skill(`t-${i}`)))).status).toBe(201)
    expect(pendingOf('bob')).toBe(18)
    // a folder of a name still waiting: refused as such, the others go
    const again = await (await contribute('bob', [skill('s-0'), skill('u-0')])).json() as ContributedSkills
    expect(again.refused).toEqual([{ name: 's-0', reason: 'pending', detail: null }])
    expect(again.items.map((s) => s.name)).toEqual(['u-0'])
    expect(pendingOf('bob')).toBe(19)
    // two more would make 21: 409 with the reason, nothing stored
    const over = await contribute('bob', [skill('v-0'), skill('v-1')])
    expect(over.status).toBe(409)
    expect(((await over.json()) as { error: { params: { reason: string } } }).error.params.reason).toBe('open_limit')
    expect(pendingOf('bob')).toBe(19)
    // the old one-file suggestion counts too: the 20th goes, the 21st is refused
    fs.mkdirSync(path.join(h.team, 'users', 'bob'), { recursive: true })
    fs.writeFileSync(path.join(h.team, 'users', 'bob', 'way.md'), 'my way\n')
    const one = { source: { kind: 'file', path: 'users/bob/way.md' }, targetFolder: 'skills', name: 'my way', content: 'my way' }
    expect((await post('bob', '/api/skills/suggestions', one)).status).toBe(201)
    expect((await post('bob', '/api/skills/suggestions', { ...one, name: 'my way 2' })).status).toBe(409)
    // another member has their own count
    expect((await contribute('alice', [skill('v-0')])).status).toBe(201)
  })

  test('members only: the owner and admins bring theirs with 내 스킬 가져오기', async () => {
    for (const u of ['dana', 'carol']) expect((await contribute(u, [skill('x')])).status).toBe(403)
  })
})

describe('the review: owners and admins only, grouped by person on the web', () => {
  let quote: SkillSuggestion
  let report: SkillSuggestion
  beforeAll(async () => {
    clearSuggestions()
    const out = await (await contribute('bob', [
      skill('quote-maker', { meta: 'metadata:\n  title: 견적 만들기\n', extra: [{ path: 'templates/quote.md', text: '| item | price |\n' }, { path: 'logo.png', base64: PNG }] }),
      skill('weekly-report'),
    ], 'codex')).json() as ContributedSkills
    ;[quote, report] = out.items as [SkillSuggestion, SkillSuggestion]
    expect(quote.folder!.app).toBe('codex')
    // erin manages skills/ (a folder rule) without being an owner or admin
    await h.api('dana').call(API.setSkillManager, { body: { subjectType: 'user', subjectId: 'erin', path: 'skills', enabled: true } })
  })

  test('who sees it: bob (his own, cannot review), the owner and the admin; not alice, not a skills manager who is a member', async () => {
    expect((await h.api('bob').call(API.getSkillSuggestion, { params: { id: quote.id } })).canReview).toBe(false)
    for (const u of ['dana', 'carol']) expect((await h.api(u).call(API.getSkillSuggestion, { params: { id: quote.id } })).canReview).toBe(true)
    for (const u of ['alice', 'erin']) expect((await h.req(u, `/api/skills/suggestions/${quote.id}`)).status).toBe(404)
    const erinReview = await h.api('erin').call(API.listSkillSuggestions, { query: { scope: 'review' } })
    expect(erinReview.items.map((s) => s.id)).not.toContain(quote.id)
    expect((await h.api('erin').call(API.skillsOverview)).pendingReview).toBe(0)
    expect((await h.api('dana').call(API.skillsOverview)).pendingReview).toBe(2)
  })

  test('only owners and admins approve: bob 403, alice and erin 404', async () => {
    const body = { targetFolder: 'skills', name: 'quote-maker', description: 'x', content: quote.content }
    expect((await post('bob', `/api/skills/suggestions/${quote.id}/approve`, body)).status).toBe(403)
    for (const u of ['alice', 'erin']) expect((await post(u, `/api/skills/suggestions/${quote.id}/approve`, body)).status).toBe(404)
    for (const u of ['bob', 'alice', 'erin']) expect((await post(u, `/api/skills/suggestions/${quote.id}/reject`, {})).status).not.toBeLessThan(400)
    expect(fs.existsSync(path.join(h.team, 'skills', 'quote-maker'))).toBe(false)
  })

  test('a name that is no folder name, a place inside another skill, or a folder that is there: refused, nothing written', async () => {
    expect((await post('carol', `/api/skills/suggestions/${quote.id}/approve`, { targetFolder: 'skills', name: 'Quote Maker', description: 'x', content: quote.content })).status).toBe(400)
    // never inside another skill's folder
    const inSkill = await post('carol', `/api/skills/suggestions/${quote.id}/approve`, { targetFolder: 'skills/general/meeting-tasks', name: 'quote-maker', description: 'x', content: quote.content })
    expect(inSkill.status).toBe(400)
    expect(fs.existsSync(path.join(h.team, 'skills', 'general', 'meeting-tasks', 'quote-maker'))).toBe(false)
    fs.mkdirSync(path.join(h.team, 'skills', 'taken'), { recursive: true })
    expect((await post('carol', `/api/skills/suggestions/${quote.id}/approve`, { targetFolder: 'skills', name: 'taken', description: 'x', content: quote.content })).status).toBe(409)
    expect(fs.readdirSync(path.join(h.team, 'skills', 'taken'))).toEqual([])
  })

  test('the admin approves: skills/<name>/ with its files as the admin; bob is told and keeps his name on it; the invite\'s and the goal\'s skill stay', async () => {
    const landing = landingSkill(h.ctx)
    const shared = readWelcome(h.ctx)!.shared ?? null
    const focus = focusSkill(h.ctx, goalProgress(h.ctx.db)!)?.path ?? null
    const done = await h.api('carol').call(API.approveSkillSuggestion, { params: { id: quote.id }, body: { targetFolder: 'skills', name: 'quote-maker', description: '견적서를 가격표로 써요', content: `${quote.content}3. Check the total.\n` } })
    expect(done).toMatchObject({ status: 'approved', resultPath: 'skills/quote-maker/SKILL.md', reviewer: { id: 'carol' } })
    const dir = path.join(h.team, 'skills', 'quote-maker')
    expect(fs.readdirSync(dir).sort()).toEqual(['SKILL.md', 'logo.png', 'templates'])
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
    expect(text).toMatch(/^---\nname: quote-maker\ndescription: "견적서를 가격표로 써요"\n/)
    expect(text).toContain('title: "견적 만들기"')
    expect(text).toContain('3. Check the total.')
    expect(fs.readFileSync(path.join(dir, 'logo.png')).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    // its kept copy is gone; the other suggestion keeps its own
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM skill_suggestion_files WHERE suggestion_id = ?').get(quote.id) as { n: number }).n).toBe(0)
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM skill_suggestion_files WHERE suggestion_id = ?').get(report.id) as { n: number }).n).toBe(1)
    // bob hears it: a live notice and the Inbox
    await socks.bob!.next('notice', (f) => (f.data as { code?: string }).code === 'skill_suggestion_reviewed')
    expect(notificationsOf(h.ctx).list('bob', {}).items.filter((i) => i.code === 'skill.reviewed').map((i) => i.sourceId)).toEqual([quote.id])
    // "Bob Lee 님이 제안" stays on the saved skill: the skills list and its maker
    const listed = (await h.api('alice').call(API.listSkills)).items.find((s) => s.path === 'skills/quote-maker/SKILL.md')
    expect(listed).toMatchObject({ title: '견적 만들기', suggestedBy: 'Bob Lee' })
    expect(skillMakerName(h.ctx.db, 'skills/quote-maker/SKILL.md')).toEqual({ id: 'bob', name: 'Bob Lee' })
    expect((await h.api('alice').call(API.listSkills)).items.find((s) => s.path === GENERAL_TASKS_SKILL)?.suggestedBy).toBeUndefined()
    // never the invite's or the goal's skill
    expect(landingSkill(h.ctx)).toBe(landing)
    expect(readWelcome(h.ctx)!.shared ?? null).toEqual(shared)
    expect(focusSkill(h.ctx, goalProgress(h.ctx.db)!)?.path ?? null).toBe(focus)
  })

  test('the owner turns the other down: its files go, nothing reaches skills/', async () => {
    await h.api('dana').call(API.rejectSkillSuggestion, { params: { id: report.id }, body: { note: 'not now' } })
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM skill_suggestion_files WHERE suggestion_id = ?').get(report.id) as { n: number }).n).toBe(0)
    expect(fs.existsSync(path.join(h.team, 'skills', 'weekly-report'))).toBe(false)
    // the Inbox line keeps saying who and how many, after the review too
    expect(notificationsOf(h.ctx).list('dana', {}).items.find((i) => i.code === 'skill.suggested')?.contribution).toEqual({ name: 'Bob Lee', n: 2 })
  })
})

describe('a member writes neither skills/ nor someone else\'s folder directly', () => {
  test('the file API refuses both; their own folder works', async () => {
    fs.mkdirSync(path.join(h.team, 'users', 'alice'), { recursive: true })
    for (const p of ['skills/sneaky/SKILL.md', 'skills/sneaky.md', 'users/alice/sneaky.md']) {
      const r = await put('bob', '/api/files/content', { path: p, content: md('sneaky'), baseSha256: null })
      expect([403, 404], p).toContain(r.status)
    }
    expect((await post('bob', '/api/files/mkdir', { path: 'skills/sneaky' })).status).not.toBeLessThan(400)
    expect(fs.existsSync(path.join(h.team, 'skills', 'sneaky'))).toBe(false)
    expect(fs.existsSync(path.join(h.team, 'skills', 'sneaky.md'))).toBe(false)
    expect(fs.existsSync(path.join(h.team, 'users', 'alice', 'sneaky.md'))).toBe(false)
    expect((await put('bob', '/api/files/content', { path: 'users/bob/mine.md', content: 'ok', baseSha256: null })).status).toBe(200)
  })
})

test('migration 257 is additive (reader 1)', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '257_b_member_skill_contributions.sql'), 'utf8')
  expect(sql.split('\n')[0]).toBe('-- min_compatible_reader: 1')
  expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|RENAME/i)
})
