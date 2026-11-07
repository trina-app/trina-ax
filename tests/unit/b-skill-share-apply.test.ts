// 내 스킬 가져오기 (docs/DECISIONS.md "SK"; server/src/skills/share.ts, routes/skill-shares.ts): share proposals over the
// API. Owners and admins only (members 403 on every endpoint), each share its person's alone (another admin: 404); a
// skill with a secret never written anywhere (the staging folder, the database, the data folder); the kept files staged
// 0700 outside the team files; apply as the person through the file layer (versions, file events, the skills/ change
// log, the audit row without content), the AI's title in the header, a separate name, the team rule without a header,
// connection templates without a key, the welcome steps' shared skills; idempotent; 409 on a folder that appeared
// meanwhile; merge through a restricted merge chat with the skill-write card (nothing changes before it; "W5"); dismiss
// and expiry delete the staged files; no AI (a budget block): nothing pre-ticked.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type SkillShare } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { parseSkill } from '../../server/src/chat/skills'
import { teamRuleFiles } from '../../server/src/chat/prompt'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { WELCOME_SETTING } from '../../server/src/onboarding/welcome'
import { stageDir } from '../../server/src/skills/share-stage'

setDefaultTimeout(60_000)
const json = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```'
const SLACK = ['xoxb', '1234567890', '0987654321', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-')
const RULE_SECRET = ['sk', 'ant', 'api03', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz'].join('-')
const md = (n: string, body = '# x\n1. Read the notes.\n') => `---\nname: ${n}\ndescription: ${n} skill\n---\n${body}`
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201d8a3c1f40000000049454e44ae426082', 'hex')

/** every file under a folder (recursively), with its bytes */
function filesUnder(dir: string): { p: string; b: Buffer; mode: number }[] {
  const out: { p: string; b: Buffer; mode: number }[] = []
  const walk = (d: string) => {
    let names: fs.Dirent[] = []
    try { names = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const n of names) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) walk(p)
      else if (n.isFile()) out.push({ p, b: fs.readFileSync(p), mode: fs.statSync(p).mode & 0o777 })
    }
  }
  walk(dir)
  return out
}

describe('skill shares over the API', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness({ name: 'b-skill-share-apply' })
    setSetting(h.ctx.db, 'defaultLocale', 'ko')
  })
  afterAll(async () => { await h?.close() })

  const post = (user: string, p: string, body: unknown) => h.req(user, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const judgeChat = (shareId: string) => (h.ctx.db.query('SELECT chat_id FROM skill_share_judges WHERE share_id = ?').get(shareId) as { chat_id: string } | null)?.chat_id ?? null
  /** the judge's answer, as if the model had written this; then the share as read */
  const judged = async (s: SkillShare, answer: unknown): Promise<SkillShare> => {
    const chat = judgeChat(s.id)
    if (chat) {
      const leaf = await waitFor(() => {
        const r = h.ctx.db.query("SELECT m.id, m.status FROM chats c JOIN messages m ON m.id = c.active_leaf_id WHERE c.id = ? AND m.role = 'assistant'").get(chat) as { id: string; status: string } | null
        return r && r.status !== 'streaming' ? r.id : null
      }, { timeoutMs: 30_000 }) as string
      h.ctx.db.query("UPDATE messages SET content = ?, status = 'done' WHERE id = ?").run(json(answer), leaf)
    }
    return h.api('dana').call(API.getSkillShare, { params: { id: s.id } })
  }
  const create = (body: Record<string, unknown>, user = 'dana') => h.api(user).call(API.createSkillShare, { body: { source: 'browser', ...body } as never })

  test('members: 403 on making one, none of their own to list, the rest 404 (a share to their group is theirs to review: group-skill-shares.test.ts)', async () => {
    const id = '01900000-0000-7000-8000-000000000000'
    for (const r of [
      await post('alice', '/api/skill-shares', { source: 'browser', skills: [] }),
      await post('bob', '/api/skill-shares', { source: 'browser', skills: [] }),
      await h.req('alice', `/api/skill-shares/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ group: null }) }),
    ]) expect(r.status).toBe(403)
    const list = await h.req('alice', '/api/skill-shares')
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ items: [] })
    for (const r of [
      await h.req('alice', `/api/skill-shares/${id}`),
      await post('alice', `/api/skill-shares/${id}/apply`, { skills: [] }),
      await post('alice', `/api/skill-shares/${id}/dismiss`, {}),
    ]) expect(r.status).toBe(404)
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM skill_shares').get()).toEqual({ n: 0 })
  })

  test('a secret is never written anywhere; the kept files are staged 0700 outside the team files', async () => {
    const s = await create({
      where: '.claude',
      skills: [
        { name: 'slack-notify', origin: 'user', files: [{ path: 'SKILL.md', text: md('slack-notify') }, { path: 'templates/x.md', text: `token ${SLACK}` }] },
        { name: 'weekly', origin: 'user', files: [{ path: 'SKILL.md', text: md('weekly') }, { path: 'logo.png', base64: PNG.toString('base64') }, { path: 'scripts/build.py', text: 'print(1)' }] },
      ],
      excluded: [{ name: 'deploy', reason: 'scripts' }],
      rule: { text: `- 존댓말로 써요\n- ANTHROPIC_API_KEY=${RULE_SECRET}\n` },
    })
    expect(s.candidates.map((c) => [c.name, c.group, c.reason, c.detail])).toEqual([
      ['slack-notify', 'excluded', 'secret', 'slack'], ['weekly', 'other', 'unjudged', null], ['deploy', 'excluded', 'scripts', null],
    ])
    const dir = stageDir(h.ctx, s.id)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    const staged = filesUnder(dir)
    expect(staged.map((f) => path.relative(dir, f.p)).sort()).toEqual(['rule.md', 'skills/weekly/SKILL.md', 'skills/weekly/logo.png'])
    expect(staged.every((f) => f.mode === 0o600)).toBe(true)
    expect(dir.startsWith(h.team)).toBe(false)
    expect(fs.existsSync(path.join(h.team, 'skills/weekly'))).toBe(false)
    // nothing anywhere under the data folder (staging, database and its WAL, sessions) or the team folder holds them
    await waitFor(() => { const c = judgeChat(s.id); return !c || (h.ctx.db.query("SELECT 1 FROM chats c JOIN messages m ON m.id = c.active_leaf_id WHERE c.id = ? AND m.status != 'streaming'").get(c)) }, { timeoutMs: 30_000 })
    h.ctx.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    for (const f of [...filesUnder(h.dataDir), ...filesUnder(h.team)]) {
      expect(f.b.includes(SLACK), f.p).toBe(false)
      expect(f.b.includes(RULE_SECRET), f.p).toBe(false)
      expect(f.b.includes('print(1)'), f.p).toBe(false)
    }
    const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'skills.share_create' AND target = ?").get(s.id) as { detail: string }
    expect(audit.detail).not.toContain('xoxb')
    expect(JSON.parse(audit.detail)).toMatchObject({ source: 'browser', via: 'app', candidates: 3, kept: 1, excluded: 2, rule: true })
  })

  test('a share is its person\'s alone: another admin gets 404 and does not list it', async () => {
    const s = await create({ skills: [{ name: 'mine', origin: 'user', files: [{ path: 'SKILL.md', text: md('mine') }] }] })
    for (const r of [
      await h.req('carol', `/api/skill-shares/${s.id}`),
      await post('carol', `/api/skill-shares/${s.id}/apply`, { skills: [{ name: 'mine', action: 'add' }] }),
      await post('carol', `/api/skill-shares/${s.id}/dismiss`, {}),
    ]) expect(r.status).toBe(404)
    expect((await h.api('carol').call(API.listSkillShares, { query: {} })).items.map((x) => x.id)).not.toContain(s.id)
    expect((await h.api('dana').call(API.listSkillShares, { query: {} })).items.map((x) => x.id)).toContain(s.id)
    expect(fs.existsSync(path.join(h.team, 'skills/mine'))).toBe(false)
  })

  let applied: SkillShare
  test('apply as the owner: add with the AI\'s title, a separate name, the team rule, a template; audited; the welcome steps learn it', async () => {
    const raw = getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING)
    setSetting(h.ctx.db, WELCOME_SETTING, { startedAt: new Date().toISOString(), steps: { profile: 'done', result: 'done', skills: null, files: null, invite: null } })
    try {
      fs.mkdirSync(path.join(h.team, 'skills/general/todo-list'), { recursive: true })
      fs.writeFileSync(path.join(h.team, 'skills/general/todo-list/SKILL.md'), '---\nname: todo-list\ndescription: 할 일을 정리해요\nmetadata:\n  title: 할 일 정리\n---\n# 할 일\n')
      const s = await create({ source: 'claude_code', projects: 1, skills: [
        { name: 'weekly-report', origin: 'user', files: [{ path: 'SKILL.md', text: md('weekly-report') }] },
        { name: 'quote-draft', origin: 'user', files: [{ path: 'SKILL.md', text: md('quote-draft') }, { path: 'templates/quote.md', text: '# 견적서 양식' }] },
        { name: 'meeting-notes', origin: 'project', project: '/Users/alex/work/acme-site', files: [{ path: 'SKILL.md', text: md('meeting-notes') }] },
      ], rule: { text: '- 존댓말로 써요\n- 표는 마크다운으로' }, tools: [{ name: 'Notion', url: 'https://mcp.notion.example/mcp', auth: 'oauth' }] })
      expect(s.candidates[2]).toMatchObject({ project: 'acme-site' })
      const j = await judged(s, {
        skills: [
          { name: 'weekly-report', verdict: 'recommend', reason: 'team_any', title: '주간 업무 보고' },
          { name: 'quote-draft', verdict: 'recommend', reason: 'team_files', title: '견적서 초안' },
          { name: 'meeting-notes', verdict: 'recommend', reason: 'similar', similarTo: 'todo-list', title: '회의록 정리' },
        ],
        rule: { text: '- 존댓말로 써요\n- 표는 마크다운으로 정리해요', kept: 2, dropped: 0 },
      })
      expect(j).toMatchObject({ status: 'ready', ai: 'done', tools: [{ name: 'Notion', templateId: null }] })
      applied = await h.api('dana').call(API.applySkillShare, { params: { id: s.id }, body: {
        skills: [{ name: 'weekly-report', action: 'add' }, { name: 'meeting-notes', action: 'separate' }, { name: 'quote-draft', action: 'separate', as: 'quote' }],
        rule: true, tools: ['Notion'],
      } })
      expect(applied.status).toBe('applied')
      expect(applied.candidates.map((c) => [c.name, c.applied])).toEqual([
        ['weekly-report', { status: 'added', path: 'skills/weekly-report/SKILL.md', chatId: null, error: null }],
        ['quote-draft', { status: 'added', path: 'skills/quote/SKILL.md', chatId: null, error: null }],
        ['meeting-notes', { status: 'added', path: 'skills/meeting-notes/SKILL.md', chatId: null, error: null }],
      ])
      expect(applied.landing).toBe('skills/weekly-report/SKILL.md')
      expect(parseSkill(fs.readFileSync(path.join(h.team, 'skills/weekly-report/SKILL.md'), 'utf8'), 'skills/weekly-report/SKILL.md')).toMatchObject({ name: 'weekly-report', title: '주간 업무 보고' })
      expect(parseSkill(fs.readFileSync(path.join(h.team, 'skills/quote/SKILL.md'), 'utf8'), 'skills/quote/SKILL.md')).toMatchObject({ name: 'quote', title: '견적서 초안' })
      expect(fs.readFileSync(path.join(h.team, 'skills/quote/templates/quote.md'), 'utf8')).toBe('# 견적서 양식')
      // the team rule: a file without a header, which every chat follows
      expect(applied.rule).toMatchObject({ path: 'skills/일하는-방식.md' })
      expect(fs.readFileSync(path.join(h.team, 'skills/일하는-방식.md'), 'utf8')).toBe('- 존댓말로 써요\n- 표는 마크다운으로 정리해요\n')
      expect(teamRuleFiles(h.ctx.files, h.ctx.files.principal('bob')).text).toContain('표는 마크다운으로 정리해요')
      // a template: no key, for the whole team
      const t = h.ctx.db.query('SELECT id, kind, name, url, auth, created_by FROM integration_templates WHERE id = ?').get(applied.tools[0]!.templateId!)
      expect(t).toMatchObject({ kind: 'mcp', name: 'Notion', url: 'https://mcp.notion.example/mcp', auth: 'oauth', created_by: 'dana' })
      // the file layer's own record: made by dana; the skills/ change log; our audit without content
      const ev = h.ctx.db.query("SELECT path, user_id, action FROM file_events WHERE path LIKE 'skills/%' AND user_id = 'dana' ORDER BY id").all() as { path: string; user_id: string; action: string }[]
      expect(ev.map((e) => `${e.action} ${e.path}`)).toEqual(['create skills/weekly-report/SKILL.md', 'create skills/meeting-notes/SKILL.md', 'create skills/quote/templates/quote.md', 'create skills/quote/SKILL.md', 'create skills/일하는-방식.md'])
      expect((h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'skills.change' AND target LIKE 'skills/%'").get() as { n: number }).n).toBeGreaterThanOrEqual(5)
      const a = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'skills.share_apply' AND target = ?").get(s.id) as { actor_id: string; detail: string }
      expect(a.actor_id).toBe('dana')
      expect(JSON.parse(a.detail)).toMatchObject({ added: ['skills/weekly-report/SKILL.md', 'skills/meeting-notes/SKILL.md', 'skills/quote/SKILL.md'], rule: 'skills/일하는-방식.md', tools: 1, status: 'applied' })
      expect(a.detail).not.toContain('1. Read the notes.')
      // the staged files are gone once applied
      expect(fs.existsSync(stageDir(h.ctx, s.id))).toBe(false)
      // the welcome steps: the shared skills in order, the invite opens the first recommended one
      expect(getSetting<{ shared: unknown }>(h.ctx.db, WELCOME_SETTING)!.shared).toMatchObject({
        skills: [{ path: 'skills/weekly-report/SKILL.md', title: '주간 업무 보고' }, { path: 'skills/meeting-notes/SKILL.md', title: '회의록 정리' }, { path: 'skills/quote/SKILL.md', title: '견적서 초안' }],
        landing: 'skills/weekly-report/SKILL.md',
      })
      // a member uses them like any team skill
      expect((await h.api('bob').call(API.listSkills)).items.map((x) => x.path)).toEqual(expect.arrayContaining(['skills/weekly-report/SKILL.md', 'skills/quote/SKILL.md']))
    } finally { setSetting(h.ctx.db, WELCOME_SETTING, raw ?? {}) }
  })

  test('idempotent: the same apply again changes nothing; more on an applied share is refused', async () => {
    const before = (h.ctx.db.query('SELECT COUNT(*) n FROM file_events').get() as { n: number }).n
    const again = await h.api('dana').call(API.applySkillShare, { params: { id: applied.id }, body: { skills: [{ name: 'weekly-report', action: 'add' }], rule: true, tools: ['Notion'] } })
    expect(again).toEqual(applied)
    expect((h.ctx.db.query('SELECT COUNT(*) n FROM file_events').get() as { n: number }).n).toBe(before)
    expect((await post('dana', `/api/skill-shares/${applied.id}/apply`, { skills: [{ name: 'nope', action: 'add' }] })).status).toBe(400)
  })

  test('a folder that appeared meanwhile: 409, nothing replaced; the row says why; separate then works; excluded and unknown: 400', async () => {
    const s = await judged(await create({ skills: [{ name: 'proposal', origin: 'user', files: [{ path: 'SKILL.md', text: md('proposal') }] }], excluded: [{ name: 'p', reason: 'plugin' }] }), { skills: [] })
    fs.mkdirSync(path.join(h.team, 'skills/proposal'), { recursive: true })
    fs.writeFileSync(path.join(h.team, 'skills/proposal/notes.md'), 'theirs')
    const r = await post('dana', `/api/skill-shares/${s.id}/apply`, { skills: [{ name: 'proposal', action: 'add' }] })
    expect(r.status).toBe(409)
    const err = (await r.json() as { error: { message: string; params: { reason: string } } }).error
    expect(err.params.reason).toBe('folder_exists')
    expect(err.message).toContain("'proposal' 폴더가 이미 있어요")
    expect(fs.readdirSync(path.join(h.team, 'skills/proposal'))).toEqual(['notes.md'])
    const after = await h.api('dana').call(API.getSkillShare, { params: { id: s.id } })
    expect(after).toMatchObject({ status: 'ready', candidates: [{ name: 'proposal', applied: { status: 'failed', error: err.message } }, { name: 'p' }] })
    expect(fs.existsSync(stageDir(h.ctx, s.id))).toBe(true)
    expect((await post('dana', `/api/skill-shares/${s.id}/apply`, { skills: [{ name: 'p', action: 'add' }] })).status).toBe(400)
    expect((await post('dana', `/api/skill-shares/${s.id}/apply`, { skills: [{ name: 'proposal', action: 'merge' }] })).status).toBe(400)
    expect((await post('dana', `/api/skill-shares/${s.id}/apply`, { skills: [{ name: 'proposal', action: 'separate', as: 'Bad Name' }] })).status).toBe(400)
    expect((await post('dana', `/api/skill-shares/${s.id}/apply`, { rule: true, skills: [] })).status).toBe(400)
    const ok = await h.api('dana').call(API.applySkillShare, { params: { id: s.id }, body: { skills: [{ name: 'proposal', action: 'separate' }] } })
    expect(ok).toMatchObject({ status: 'applied', landing: 'skills/proposal-2/SKILL.md', candidates: [{ applied: { status: 'added', path: 'skills/proposal-2/SKILL.md' } }, { applied: null }] })
    expect(fs.readFileSync(path.join(h.team, 'skills/proposal/notes.md'), 'utf8')).toBe('theirs')
  })

  test('merge: a restricted merge chat of the person (docs/DECISIONS.md "W5"); the request names the skills, never their text; nothing changes before the card', async () => {
    // outside the welcome steps (finished): the merge starts at once (b-skill-share-v5.test.ts: it waits during them)
    setSetting(h.ctx.db, WELCOME_SETTING, { startedAt: new Date().toISOString(), steps: { profile: 'done', result: 'done', skills: 'done', files: 'done', invite: 'done' }, resultChatId: null, finishedAt: new Date().toISOString() })
    const team = path.join(h.team, 'skills/general/todo-list/SKILL.md')
    const before = fs.readFileSync(team, 'utf8')
    const s = await judged(await create({ skills: [{ name: 'todo-list', origin: 'user', files: [{ path: 'SKILL.md', text: md('todo-list', '# 내 할 일\n```\nkeep ``` fences\n```\n') }] }] }),
      { skills: [{ name: 'todo-list', verdict: 'recommend', reason: 'team_any', title: '할 일' }] })
    expect(s.candidates[0]).toMatchObject({ group: 'recommended', reason: 'same_name', action: 'merge', sameName: { path: 'skills/general/todo-list/SKILL.md', title: '할 일 정리' } })
    // add is refused for a skill of the same name
    expect((await post('dana', `/api/skill-shares/${s.id}/apply`, { skills: [{ name: 'todo-list', action: 'add' }] })).status).toBe(409)
    const out = await h.api('dana').call(API.applySkillShare, { params: { id: s.id }, body: { skills: [{ name: 'todo-list', action: 'merge' }] } })
    const row = out.candidates[0]!.applied!
    expect(row).toMatchObject({ status: 'merge', path: 'skills/general/todo-list/SKILL.md', error: null })
    expect(out.status).toBe('applied')
    expect(out.landing).toBeNull()
    const chat = await h.api('dana').call(API.getChat, { params: { id: row.chatId! } })
    expect(chat.title).toContain('스킬 합치기')
    const msgs = (await h.api('dana').call(API.listMessages, { params: { id: row.chatId! } })).items
    const first = msgs.find((m) => m.role === 'user')!.content
    expect(first).toContain("'할 일' → '할 일 정리'")
    expect(first).not.toContain('keep ``` fences')
    // the candidate's text waits in the merge's own row (the share's staged files are gone)
    expect((h.ctx.db.query('SELECT text FROM skill_share_merges WHERE chat_id = ?').get(row.chatId!) as { text: string }).text).toContain('keep ``` fences')
    expect(fs.existsSync(stageDir(h.ctx, s.id))).toBe(false)
    // the chat is the person's ordinary chat (listed), and the team skill is untouched until a confirmation
    expect((await h.api('dana').call(API.listChats, { query: {} })).items.map((c) => c.id)).toContain(row.chatId!)
    await waitFor(() => (h.ctx.db.query("SELECT 1 FROM messages WHERE chat_id = ? AND role = 'assistant' AND status != 'streaming'").get(row.chatId!) ? true : null), { timeoutMs: 30_000 })
    expect(fs.readFileSync(team, 'utf8')).toBe(before)
  })

  test('dismiss: the staged files go, later applies are refused; expiry the same', async () => {
    const s = await create({ skills: [{ name: 'later', origin: 'user', files: [{ path: 'SKILL.md', text: md('later') }] }] })
    expect(fs.existsSync(stageDir(h.ctx, s.id))).toBe(true)
    expect((await post('dana', `/api/skill-shares/${s.id}/dismiss`, {})).status).toBe(204)
    expect(fs.existsSync(stageDir(h.ctx, s.id))).toBe(false)
    expect(await h.api('dana').call(API.getSkillShare, { params: { id: s.id } })).toMatchObject({ status: 'dismissed' })
    await waitFor(() => (!judgeChat(s.id) ? true : null), { timeoutMs: 30_000 })
    expect((await post('dana', `/api/skill-shares/${s.id}/apply`, { skills: [{ name: 'later', action: 'add' }] })).status).toBe(409)
    const e = await create({ skills: [{ name: 'old', origin: 'user', files: [{ path: 'SKILL.md', text: md('old') }] }] })
    h.ctx.db.query("UPDATE skill_shares SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(e.id)
    expect(await h.api('dana').call(API.getSkillShare, { params: { id: e.id } })).toMatchObject({ status: 'expired' })
    expect(fs.existsSync(stageDir(h.ctx, e.id))).toBe(false)
    // a staging folder without an open share is swept on the next create
    fs.mkdirSync(stageDir(h.ctx, '01900000-0000-7000-8000-00000000abcd'), { recursive: true })
    await create({ skills: [] })
    expect(fs.existsSync(stageDir(h.ctx, '01900000-0000-7000-8000-00000000abcd'))).toBe(false)
    expect((await h.api('dana').call(API.listSkillShares, { query: { status: 'expired' } })).items.map((x) => x.id)).toEqual([e.id])
  })

  test('no AI for the person (a budget block): no judgement, nothing pre-ticked; nothing to judge: done at once', async () => {
    h.ctx.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES ('skill-share-block', 'user', 'carol', 'day', 0, 0, 'block')").run()
    try {
      const s = await create({ skills: [{ name: 'admin-skill', origin: 'user', files: [{ path: 'SKILL.md', text: md('admin-skill') }] }] }, 'carol')
      expect(s).toMatchObject({ status: 'ready', ai: 'none', candidates: [{ group: 'other', reason: 'unjudged' }] })
      expect(judgeChat(s.id)).toBeNull()
    } finally { h.ctx.db.query("DELETE FROM budgets WHERE id = 'skill-share-block'").run() }
    expect(await create({ skills: [], excluded: [{ name: 'x', reason: 'plugin' }] })).toMatchObject({ status: 'ready', ai: 'done' })
  })
})
