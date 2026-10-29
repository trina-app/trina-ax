// Team skills (docs/DECISIONS.md "팀 스킬 관리"): who may change skills/ (the "팀 스킬 관리" toggle = a write rule on
// skills/ or a subfolder, through the folder-rule machinery), change tracking (audit + notice to the owner and admins
// with a link to the version history), the AI's saves under skills/ (a server card for everyone, fail closed), and
// "스킬로 제안" → [등록] / [거절] (only the suggester and the managers of the target folder ever see a suggestion).
//
// Fixture (tests/lib/fixtures.ts): alice + erin = marketing, bob = finance, carol = admin, dana = owner;
// skills/ everyone read (no member writes it).
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, type SkillSuggestion } from '@mycel/shared/api'
import { TurnFiles } from '../../server/src/files/service'
import { sha256 } from '../../server/src/files/store'
import { lineDiff } from '../../server/src/skills/diff'
import { replaceRules } from '../../server/src/admin/folders'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const CANARY_ROOT = 'SKILL-SUGGESTION-CANARY-ROOT-41f'
const CANARY_FIN = 'SKILL-SUGGESTION-CANARY-FIN-9b2'

let h: Harness
const socks: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'skill-managers', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'carol', 'dana', 'erin']) {
    socks[u] = await h.ws(u, { windowId: `win-sm-${u}` })
    await socks[u]!.next('hello')
  }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

const status = async (p: Promise<unknown>) => { try { await p; return 200 } catch (e) { if (e instanceof ApiError) return e.status; throw e } }
const save = (user: string, p: string, content: string) => h.api(user).call(API.saveContent, { body: { path: p, content, baseSha256: null } })
const exists = (rel: string) => fs.existsSync(path.join(h.team, rel))
const aiCtx = (user: string) => {
  const chat = h.ctx.db.query('SELECT id FROM chats WHERE user_id = ? LIMIT 1').get(user) as { id: string } | null
  const chatId = chat?.id ?? (() => { const id = crypto.randomUUID(); h.ctx.db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(id, user); return id })()
  const turnId = crypto.randomUUID()
  h.ctx.db.query('INSERT INTO turns (id, chat_id, user_id, engine) VALUES (?,?,?,?)').run(turnId, chatId, user, 'claude-code')
  return { user: h.ctx.files.principal(user), turnId, files: new TurnFiles() }
}
const setManager = (by: string, body: { subjectType: 'user' | 'group'; subjectId: string; path?: string; enabled: boolean }) => h.api(by).call(API.setSkillManager, { body })
type Card = { question: string; origin?: string; preview?: { kind: string; path: string; diff: string; isNew: boolean; skillName: string | null; added: number; removed: number } }
const notices = (user: string, code: string) => socks[user]!.frames.flatMap((f) => (f.type === 'notice' && f.data.code === code ? [f.data as { message: string; link?: string }] : []))

describe('"팀 스킬 관리": a write rule on skills/, nothing else', () => {
  test('a member without it cannot change skills/ over HTTP or through AI tools (even with an approval)', async () => {
    expect(await status(save('bob', 'skills/bob.md', '# x\n'))).toBe(403)
    expect(await status(h.api('bob').call(API.mkdir, { body: { path: 'skills/bob-folder' } }))).toBe(403)
    expect(await status(h.api('bob').call(API.remove, { query: { path: 'skills/team-rules.md' } }))).toBe(403)
    const c = aiCtx('bob')
    c.files.skillApprovals.set('skills/bob.md', sha256('# x\n'))
    expect((await h.ctx.files.call('write', { file_path: 'skills/bob.md', content: '# x\n' }, c)).text).toContain('read-only')
    expect(exists('skills/bob.md')).toBe(false)
  })

  test('only admins switch it, never for the owner or an admin, and only on skills/ folders', async () => {
    expect(await status(setManager('alice', { subjectType: 'user', subjectId: 'bob', enabled: true }))).toBe(403)
    expect(await status(setManager('carol', { subjectType: 'user', subjectId: 'dana', enabled: true }))).toBe(400)
    expect(await status(setManager('carol', { subjectType: 'user', subjectId: 'bob', path: 'shared', enabled: true }))).toBe(400)
    expect(await status(setManager('carol', { subjectType: 'user', subjectId: 'nobody', enabled: true }))).toBe(400)
  })

  test('on for a person: their write rule on skills/ (also in Admin > 폴더 권한), audited; off removes it', async () => {
    const r = await setManager('carol', { subjectType: 'user', subjectId: 'bob', enabled: true })
    expect(r.items).toContainEqual({ subjectType: 'user', subjectId: 'bob', path: 'skills' })
    // the fixture's folder ids are not UUIDv7, so Admin > 폴더 권한's own list is read from the same rows directly
    const folderRules = () => h.ctx.db.query("SELECT r.subject_type AS t, r.subject_id AS s, r.access AS a FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = 'skills' ORDER BY t, s").all()
    expect(folderRules()).toEqual([{ t: 'everyone', s: null, a: 'read' }, { t: 'user', s: 'bob', a: 'write' }])
    expect(h.ctx.db.query("SELECT actor_id, target FROM audit_log WHERE action = 'skills.manager' ORDER BY id DESC LIMIT 1").get()).toEqual({ actor_id: 'carol', target: 'skills' })
    await save('bob', 'skills/bob.md', '# bob rule\n')
    expect(exists('skills/bob.md')).toBe(true)
    const off = await setManager('carol', { subjectType: 'user', subjectId: 'bob', enabled: false })
    expect(off.items.some((x) => x.subjectId === 'bob')).toBe(false)
    expect(await status(save('bob', 'skills/bob-2.md', '# x\n'))).toBe(403)
    expect(folderRules()).toEqual([{ t: 'everyone', s: null, a: 'read' }])
    // Admin > 폴더 권한 and the toggle are the same rows: a rule set there shows here
    const fid = (h.ctx.db.query("SELECT id FROM folders WHERE path = 'skills'").get() as { id: string }).id
    replaceRules(h.ctx.db, fid, [{ subjectType: 'everyone', subjectId: null, access: 'read' }, { subjectType: 'user', subjectId: 'erin', access: 'write' }], 'carol')
    expect((await h.api('carol').call(API.listSkillManagers)).items).toContainEqual({ subjectType: 'user', subjectId: 'erin', path: 'skills' })
    await setManager('carol', { subjectType: 'user', subjectId: 'erin', enabled: false })
    expect(folderRules()).toEqual([{ t: 'everyone', s: null, a: 'read' }])
  })

  test('limited to a subfolder for a group: only that folder (created on disk), nobody else gains anything', async () => {
    const r = await setManager('dana', { subjectType: 'group', subjectId: 'finance', path: 'skills/재무', enabled: true })
    expect(r.folders).toContain('skills/재무')
    expect(r.items).toContainEqual({ subjectType: 'group', subjectId: 'finance', path: 'skills/재무' })
    expect(fs.statSync(path.join(h.team, 'skills/재무')).isDirectory()).toBe(true)
    await save('bob', 'skills/재무/결산.md', '---\nname: 월말 결산\ndescription: 재무 전용\n---\n1. 확인\n')
    expect(await status(save('bob', 'skills/elsewhere.md', '# x\n'))).toBe(403)
    expect(await status(save('alice', 'skills/재무/alice.md', '# x\n'))).toBe(403)
    // everyone still reads it (inherited from skills/)
    expect((await h.api('alice').call(API.listSkills)).items.map((s) => s.path)).toContain('skills/재무/결산.md')
    // through AI tools: bob's AI may save there after the card, never next to it
    const c = aiCtx('bob')
    c.files.skillApprovals.set('skills/재무/ai.md', sha256('# ai\n'))
    expect((await h.ctx.files.call('write', { file_path: 'skills/재무/ai.md', content: '# ai\n' }, c)).isError).toBeFalsy()
    c.files.skillApprovals.set('skills/ai.md', sha256('# ai\n'))
    expect((await h.ctx.files.call('write', { file_path: 'skills/ai.md', content: '# ai\n' }, c)).text).toContain('read-only')
  })
})

describe('the AI never saves under skills/ without the person confirming (fail closed)', () => {
  test('no approval: refused for everyone, the owner included; an approval is for exactly those bytes', async () => {
    const c = aiCtx('dana')
    expect((await h.ctx.files.call('write', { file_path: 'skills/owner.md', content: '# a\n' }, c)).text).toContain("needs the user's confirmation")
    c.files.skillApprovals.set('skills/owner.md', sha256('# other content\n'))
    expect((await h.ctx.files.call('write', { file_path: 'skills/owner.md', content: '# a\n' }, c)).text).toContain("needs the user's confirmation")
    // case / Unicode form of the folder name does not get around it
    expect((await h.ctx.files.call('write', { file_path: 'SKILLS/owner.md', content: '# a\n' }, c)).isError).toBe(true)
    expect(exists('skills/owner.md')).toBe(false)
    // the person's own save on the file screen needs no card
    await save('dana', 'skills/owner.md', '# by hand\n')
    expect(exists('skills/owner.md')).toBe(true)
  })

  async function aiTurn(user: string, content: string, answer?: 'save' | 'skip' | null) {
    const chat = await h.api(user).call(API.createChat, { body: {} })
    const r = await h.api(user).call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
    let card: Card | null = null
    if (answer !== undefined) {
      const c = await socks[user]!.next('turn.request', (f) => f.data.turnId === r.turnId)
      card = c.data.request as Card
      if (answer !== null) await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer } })
    }
    const done = await socks[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    return { turnId: r.turnId as string, chatId: chat.id as string, content: done.data.message.content as string, card }
  }

  test('write: the server card (not the AI\'s), with the new file; declining writes nothing and is audited', async () => {
    const r = await aiTurn('carol', fake({ tool: 'write', args: { file_path: 'skills/답변-형식.md', content: '# 답변 형식\n- 표로 정리한다\n' }, sayResult: true }), 'skip')
    expect(r.card!.origin).toBe('server')
    expect(r.card!.question).toContain('팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따릅니다')
    expect(r.card!.preview).toMatchObject({ kind: 'skill_write', path: 'skills/답변-형식.md', isNew: true, skillName: null, added: 2, removed: 0 })
    expect(r.card!.preview!.diff).toContain('+- 표로 정리한다')
    expect(r.content).toContain('did not allow saving')
    expect(exists('skills/답변-형식.md')).toBe(false)
    expect(h.ctx.db.query("SELECT actor_id, target FROM audit_log WHERE action = 'skills.ai_write_refused' ORDER BY id DESC LIMIT 1").get()).toEqual({ actor_id: 'carol', target: 'skills/답변-형식.md' })
    expect(h.ctx.db.query("SELECT summary, ok FROM tool_events WHERE turn_id = ? AND tool = 'write'").get(r.turnId)).toEqual({ summary: 'write -> not allowed by the user (team skills)', ok: 0 })
  })

  test('no answer (the card times out) = nothing written', async () => {
    const r = await aiTurn('carol', fake({ tool: 'write', args: { file_path: 'skills/timeout.md', content: '# t\n' }, sayResult: true }), null)
    expect(r.card!.origin).toBe('server')
    expect(r.content).toContain('did not allow saving')
    expect(exists('skills/timeout.md')).toBe(false)
  })

  test('save: written, with an audit entry (by AI) and a banner for the other admins and the owner', async () => {
    const before = notices('dana', 'skill_changed').length
    const r = await aiTurn('carol', fake({ tool: 'write', args: { file_path: 'skills/weekly.md', content: '---\nname: 주간 보고서\ndescription: 이번 주 보고서\n---\n1. 회의록을 읽는다\n' }, sayResult: true }), 'save')
    expect(r.card!.preview!.skillName).toBe('주간 보고서')
    expect(r.card!.question).toContain('새 팀 스킬 "주간 보고서"')
    expect(r.content).toContain('Created skills/weekly.md')
    const a = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'skills.change' AND target = 'skills/weekly.md' ORDER BY id DESC LIMIT 1").get() as { actor_id: string; detail: string }
    expect(a.actor_id).toBe('carol')
    expect(JSON.parse(a.detail)).toMatchObject({ change: 'create', byAi: true, kind: 'skill', turnId: r.turnId })
    await socks.dana!.next('notice', (f) => f.data.code === 'skill_changed' && f.data.message.includes('skills/weekly.md'))
    const n = notices('dana', 'skill_changed').slice(before).find((x) => x.message.includes('skills/weekly.md'))!
    expect(n.message).toContain('AI가 저장')
    expect(n.link).toBe('/files?path=skills&select=skills%2Fweekly.md&history=skills%2Fweekly.md')
    // the person who made the change is not told about their own change
    expect(notices('carol', 'skill_changed').some((x) => x.message.includes('skills/weekly.md'))).toBe(false)
  })

  test('edit: the card shows the diff; saving it keeps the old version in the history', async () => {
    const r = await aiTurn('dana', fake(
      { tool: 'read', args: { file_path: 'skills/weekly.md' } },
      { tool: 'edit', args: { file_path: 'skills/weekly.md', old_string: '1. 회의록을 읽는다', new_string: '1. 회의록을 읽는다\n2. 표로 정리한다' }, sayResult: true },
    ), 'save')
    expect(r.card!.preview).toMatchObject({ isNew: false, added: 1, removed: 0 })
    expect(r.card!.preview!.diff).toContain('+2. 표로 정리한다')
    expect(r.card!.question).toContain('팀 스킬 "주간 보고서" 수정')
    expect(fs.readFileSync(path.join(h.team, 'skills/weekly.md'), 'utf8')).toContain('2. 표로 정리한다')
    const hist = await h.api('dana').call(API.history, { query: { path: 'skills/weekly.md' } })
    expect(hist.items.length).toBeGreaterThan(0)
  })

  test('a member\'s AI cannot write skills/ at all (the folder rule refuses before any card)', async () => {
    const r = await aiTurn('alice', fake({ tool: 'write', args: { file_path: 'skills/alice.md', content: '# x\n' }, sayResult: true }))
    expect(r.content).toContain('read-only')
    expect(exists('skills/alice.md')).toBe(false)
    expect(socks.alice!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === r.turnId)).toBe(false)
  })

  test('make_file into skills/ asks first; declining converts and writes nothing', async () => {
    const r = await aiTurn('carol', fake({ tool: 'make_file', args: { format: 'docx', content: '# 양식', output: 'skills/양식.docx' }, sayResult: true }), 'skip')
    expect(r.card!.preview).toMatchObject({ kind: 'skill_write', path: 'skills/양식.docx', isNew: true })
    expect(exists('skills/양식.docx')).toBe(false)
  })
})

describe('change tracking of people\'s changes', () => {
  test('save, move and delete under skills/ are audited with who and which file, with a history / trash link', async () => {
    await save('carol', 'skills/tracked.md', '# v1\n')
    await h.api('carol').call(API.move, { body: { from: 'skills/tracked.md', to: 'skills/moved.md' } })
    await h.api('carol').call(API.remove, { query: { path: 'skills/moved.md' } })
    await socks.dana!.next('notice', (f) => f.data.code === 'skill_changed' && f.data.link === '/trash')
    const page = await h.api('dana').call(API.listSkillChanges, { query: { limit: 10 } })
    const mine = page.items.filter((x) => x.actor?.id === 'carol' && ['skills/tracked.md', 'skills/moved.md'].includes(x.path))
    expect(mine.map((x) => [x.change, x.path, x.from])).toEqual([['delete', 'skills/moved.md', null], ['move', 'skills/moved.md', 'skills/tracked.md'], ['create', 'skills/tracked.md', null]])
    expect(mine.every((x) => !x.byAi)).toBe(true)
    expect(await status(h.api('bob').call(API.listSkillChanges, { query: {} }))).toBe(403)
  })
  test('changes outside skills/ are not', async () => {
    const n = (h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'skills.change'").get() as { n: number }).n
    await save('alice', 'shared/not-a-skill.md', '# x\n')
    expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'skills.change'").get() as { n: number }).n).toBe(n)
  })
  test('the diff of the card', () => {
    const d = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')
    expect(d.text).toBe('@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d')
    expect([d.added, d.removed]).toEqual([2, 1])
    expect(lineDiff('', 'x'.repeat(10) + '\n').text).toBe('@@ -0,0 +1,1 @@\n+xxxxxxxxxx')
  })
})

describe('"스킬로 제안" → [등록] / [거절]', () => {
  let rootSug: SkillSuggestion
  let finSug: SkillSuggestion
  let answerId: string
  let chatId: string

  beforeAll(async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    chatId = chat.id
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ say: '1. 회의록을 모은다\n2. 요약한다' }), clientMessageId: cm(), attachmentIds: [] } })
    await socks.alice!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    answerId = r.assistantMessage.id
  })

  test('from my own answer: pending on the server (not in skills/), the managers of the folder are told', async () => {
    rootSug = await h.api('alice').call(API.createSkillSuggestion, { body: { source: { kind: 'message', chatId, messageId: answerId }, targetFolder: 'skills', name: '회의 요약', description: '회의록 요약', content: `1. 회의록을 모은다\n${CANARY_ROOT}\n` } })
    expect(rootSug).toMatchObject({ status: 'pending', targetFolder: 'skills', canReview: false, suggester: { id: 'alice' } })
    expect(fs.readdirSync(path.join(h.team, 'skills')).some((n) => n.includes('회의'))).toBe(false)
    await socks.carol!.next('notice', (f) => f.data.code === 'skill_suggested' && f.data.message.includes('회의 요약'))
    await socks.dana!.next('notice', (f) => f.data.code === 'skill_suggested')
    expect(notices('bob', 'skill_suggested')).toEqual([]) // bob manages only skills/재무
    expect(notices('erin', 'skill_suggested')).toEqual([])
    finSug = await h.api('alice').call(API.createSkillSuggestion, { body: { source: { kind: 'message', chatId, messageId: answerId }, targetFolder: 'skills/재무', name: '결산 체크', content: `${CANARY_FIN}\n` } })
    await socks.bob!.next('notice', (f) => f.data.code === 'skill_suggested' && f.data.message.includes('결산 체크') && f.data.link === `/skills?review=${finSug.id}`)
  })

  test('only from my own chat or my own folder', async () => {
    const body = (source: object) => ({ body: { source, targetFolder: 'skills', name: 'x', content: 'x' } }) as never
    expect(await status(h.api('bob').call(API.createSkillSuggestion, body({ kind: 'message', chatId, messageId: answerId })))).toBe(404)
    expect(await status(h.api('bob').call(API.createSkillSuggestion, body({ kind: 'file', path: 'users/alice/todo.md' })))).toBe(404)
    expect(await status(h.api('bob').call(API.createSkillSuggestion, body({ kind: 'file', path: 'groups/finance/budget.md' })))).toBe(404)
    expect(await status(h.api('bob').call(API.createSkillSuggestion, body({ kind: 'file', path: 'users/bob/notes.md' })))).toBe(200)
    expect(await status(h.api('bob').call(API.createSkillSuggestion, { body: { source: { kind: 'file', path: 'users/bob/notes.md' }, targetFolder: 'shared' as never, name: 'x', content: 'x' } }))).toBe(400)
  })

  test('nobody else sees a suggestion or its content', async () => {
    // bob manages skills/재무 only: he sees the finance one, never the root one
    const bobReview = await h.api('bob').call(API.listSkillSuggestions, { query: { scope: 'review' } })
    expect(bobReview.items.map((s) => s.id)).toContain(finSug.id)
    expect(JSON.stringify(bobReview)).not.toContain(CANARY_ROOT)
    expect(await status(h.api('bob').call(API.getSkillSuggestion, { params: { id: rootSug.id } }))).toBe(404)
    // erin manages nothing
    const erin = await h.api('erin').call(API.listSkillSuggestions, { query: { scope: 'review' } })
    expect(erin.items).toEqual([])
    for (const s of [rootSug, finSug]) expect(await status(h.api('erin').call(API.getSkillSuggestion, { params: { id: s.id } }))).toBe(404)
    expect(await status(h.api('erin').call(API.approveSkillSuggestion, { params: { id: rootSug.id }, body: { targetFolder: 'skills', name: 'x', description: '', content: 'x' } }))).toBe(404)
    expect(await status(h.api('erin').call(API.rejectSkillSuggestion, { params: { id: rootSug.id }, body: {} }))).toBe(404)
    expect((await h.api('erin').call(API.skillsOverview)).pendingReview).toBe(0)
    // the admin sees both; the suggester sees hers (and cannot review)
    const carol = await h.api('carol').call(API.listSkillSuggestions, { query: { scope: 'review', status: 'pending' } })
    expect(carol.items.map((s) => s.id)).toEqual(expect.arrayContaining([rootSug.id, finSug.id]))
    expect((await h.api('alice').call(API.getSkillSuggestion, { params: { id: rootSug.id } })).content).toContain(CANARY_ROOT)
    expect(await status(h.api('alice').call(API.approveSkillSuggestion, { params: { id: rootSug.id }, body: { targetFolder: 'skills', name: 'x', description: '', content: 'x' } }))).toBe(403)
    const ov = await h.api('bob').call(API.skillsOverview)
    expect(ov.managedFolders).toEqual(['skills/재무'])
  })

  test('[등록] by a manager of the folder (edited): written under skills/ with a header, audited; the suggester is told', async () => {
    // bob may not register into skills/ itself
    expect(await status(h.api('bob').call(API.approveSkillSuggestion, { params: { id: finSug.id }, body: { targetFolder: 'skills', name: '결산 체크', description: '', content: 'x' } }))).toBe(403)
    const done = await h.api('bob').call(API.approveSkillSuggestion, { params: { id: finSug.id }, body: { targetFolder: 'skills/재무', name: '월말 결산 체크', description: '월말에 쓴다', content: '1. 잔액 확인\n' } })
    expect(done).toMatchObject({ status: 'approved', resultPath: 'skills/재무/월말-결산-체크.md', reviewer: { id: 'bob' } })
    expect(fs.readFileSync(path.join(h.team, 'skills/재무/월말-결산-체크.md'), 'utf8')).toBe('---\nname: "월말 결산 체크"\ndescription: "월말에 쓴다"\n---\n1. 잔액 확인\n')
    expect((await h.api('alice').call(API.listSkills)).items.map((s) => s.name)).toContain('월말 결산 체크')
    expect(h.ctx.db.query("SELECT actor_id FROM audit_log WHERE action = 'skills.change' AND target = 'skills/재무/월말-결산-체크.md'").get()).toEqual({ actor_id: 'bob' })
    expect(h.ctx.db.query("SELECT actor_id FROM audit_log WHERE action = 'skills.suggestion_approved' AND target = 'skills/재무/월말-결산-체크.md'").get()).toEqual({ actor_id: 'bob' })
    await socks.alice!.next('notice', (f) => f.data.code === 'skill_suggestion_reviewed' && f.data.message.includes('월말 결산 체크'))
    expect(await status(h.api('bob').call(API.approveSkillSuggestion, { params: { id: finSug.id }, body: { targetFolder: 'skills/재무', name: 'again', description: '', content: 'x' } }))).toBe(409)
  })

  test('[거절]: nothing written, the suggester sees the status and the note', async () => {
    const r = await h.api('carol').call(API.rejectSkillSuggestion, { params: { id: rootSug.id }, body: { note: '이미 비슷한 스킬이 있어요' } })
    expect(r.status).toBe('rejected')
    const mine = await h.api('alice').call(API.listSkillSuggestions, { query: { scope: 'mine' } })
    expect(mine.items.find((s) => s.id === rootSug.id)).toMatchObject({ status: 'rejected', reviewNote: '이미 비슷한 스킬이 있어요', reviewer: { id: 'carol' } })
    expect(mine.items.find((s) => s.id === finSug.id)).toMatchObject({ status: 'approved' })
    await socks.alice!.next('notice', (f) => f.data.code === 'skill_suggestion_reviewed' && f.data.message.includes('이미 비슷한'))
  })

  test('a group losing the toggle loses the review too', async () => {
    const s = await h.api('alice').call(API.createSkillSuggestion, { body: { source: { kind: 'message', chatId, messageId: answerId }, targetFolder: 'skills/재무', name: '또 하나', content: 'y' } })
    expect(await status(h.api('bob').call(API.getSkillSuggestion, { params: { id: s.id } }))).toBe(200)
    await setManager('carol', { subjectType: 'group', subjectId: 'finance', path: 'skills/재무', enabled: false })
    expect(await status(h.api('bob').call(API.getSkillSuggestion, { params: { id: s.id } }))).toBe(404)
    expect(await status(save('bob', 'skills/재무/after.md', '# x\n'))).toBe(403)
  })
})
