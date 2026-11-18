// Security: a shared project chat's sub-folder that not everyone in it may open does not exist for the chat (QA
// TC-4945, docs/decisions/20261118-shared-hide-subfolder-names.md). projects/falcon is shared by alice (writes) and
// bob (finance, reads); projects/falcon/hr-PAYROLL is alice's alone. Its name and files must not reach the chat through
// a listing, glob or grep, an error or a step, and no read card is about it: a path there answers exactly as a path
// that is not there. Before, a listing of the project folder or a search in it brought the read card (and after a yes
// the name), a path there brought the card too, and a command's ls showed the folder empty
// (tests/unit/dev-env-shared-chat.test.ts, tests/linux/srt-attack.ts S16).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Message } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const F = 'projects/falcon'
const HIDDEN = `${F}/hr-PAYROLL`
const SECRET_FILE = 'layoff-PLAN-2027.md'

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-hidden-subfolders', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: F, instructions: '' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  const db = h.ctx.db
  db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run('f_falcon_hr', HIDDEN)
  db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, 'f_falcon_hr', 'everyone', NULL, 'none')").run(crypto.randomUUID())
  db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, 'f_falcon_hr', 'user', 'alice', 'write')").run(crypto.randomUUID())
  fs.mkdirSync(path.join(h.team, HIDDEN), { recursive: true })
  fs.writeFileSync(path.join(h.team, HIDDEN, SECRET_FILE), 'CANARY-HR salary cuts')
  fs.writeFileSync(path.join(h.team, F, 'open-notes.md'), 'Falcon open notes')
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const cards = (chatId: string) => (h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'chat.shared_read' AND target = ?").get(chatId) as { n: number }).n
const newChat = async () => (await h.api('alice').call(API.createChat, { body: { projectId } })).id
/** alice's turn; no card may come (a card would time out and fail the checks below) */
async function ask(chatId: string, content: string) {
  const started = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const done = await ws.alice!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  const asked = ws.alice!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === started.turnId)
  return { content: done.data.message.content as string, asked, id: started.assistantMessage.id }
}
const leaks = (s: string) => /hr-PAYROLL|layoff|CANARY-HR/i.test(s)

describe('a sub-folder not everyone in the shared project chat may open', () => {
  test('a listing of the project folder: no card, every other entry, not its name', async () => {
    const chat = await newChat()
    const r = await ask(chat, fake({ tool: 'list', args: { path: F }, sayResult: true }))
    expect(r.asked).toBe(false)
    expect(cards(chat)).toBe(0)
    expect(r.content).toContain('open-notes.md')
    expect(leaks(r.content)).toBe(false)
  })

  test('glob and grep in the project folder (no path, and the folder named): no card, nothing from it', async () => {
    const chat = await newChat()
    const r = await ask(chat, fake(
      { tool: 'glob', args: { pattern: '**/*' }, sayResult: true },
      { tool: 'glob', args: { pattern: '**/*.md', path: F }, sayResult: true },
      { tool: 'grep', args: { pattern: 'CANARY-HR|Falcon open', path: F, output_mode: 'content' }, sayResult: true },
      { tool: 'grep', args: { pattern: 'salary' }, sayResult: true },
    ))
    expect(r.asked).toBe(false)
    expect(cards(chat)).toBe(0)
    expect(r.content).toContain('open-notes.md')
    expect(r.content).toContain('Falcon open notes')
    expect(leaks(r.content)).toBe(false)
  })

  test('a path there answers exactly as a path that is not there, with no card (read, list, glob, grep)', async () => {
    const chat = await newChat()
    const calls = (dir: string) => [
      { tool: 'read', args: { file_path: `${dir}/${SECRET_FILE}` }, sayResult: true },
      { tool: 'list', args: { path: dir }, sayResult: true },
      { tool: 'glob', args: { pattern: '*', path: dir }, sayResult: true },
      { tool: 'grep', args: { pattern: 'salary', path: dir }, sayResult: true },
    ]
    const hidden = await ask(chat, fake(...calls(HIDDEN)))
    const missing = await ask(chat, fake(...calls(`${F}/no-such-folder`)))
    expect(hidden.asked).toBe(false)
    expect(cards(chat)).toBe(0)
    // the AI's own path is in both answers; past it, the words are the same
    expect(hidden.content.replaceAll(HIDDEN, '<p>')).toBe(missing.content.replaceAll(`${F}/no-such-folder`, '<p>'))
    expect(hidden.content).not.toContain('CANARY-HR')
    // and in another letter case
    const upper = await ask(chat, fake({ tool: 'read', args: { file_path: `${F}/HR-payroll/${SECRET_FILE}` }, sayResult: true }))
    expect(upper.asked).toBe(false)
    expect(upper.content).not.toContain('CANARY-HR')
  })

  test('a write there and a new name beside it get one refusal; a sub-folder everyone opens still takes a new file', async () => {
    const chat = await newChat()
    const w = (p: string) => ({ tool: 'write', args: { file_path: p, content: 'x' }, sayResult: true })
    const hidden = await ask(chat, fake(w(`${HIDDEN}/new.md`)))
    const free = await ask(chat, fake(w(`${F}/brand-new.md`)))
    expect(hidden.asked).toBe(false)
    expect(hidden.content).toBe(free.content)
    expect(leaks(hidden.content)).toBe(false)
    expect(fs.existsSync(path.join(h.team, F, 'brand-new.md'))).toBe(false)
    expect(fs.existsSync(path.join(h.team, HIDDEN, 'new.md'))).toBe(false)
    fs.mkdirSync(path.join(h.team, F, 'drafts'), { recursive: true })
    const sub = await ask(chat, fake(w(`${F}/drafts/ok.md`)))
    expect(fs.existsSync(path.join(h.team, F, 'drafts/ok.md'))).toBe(true)
    expect(leaks(sub.content)).toBe(false)
  })

  test('bob sees no step, label or text that names it', async () => {
    const chat = await newChat()
    const r = await ask(chat, fake({ tool: 'list', args: { path: F } }, { tool: 'glob', args: { pattern: '**/*', path: F } }, { say: 'done' }))
    expect(r.content).toBe('done')
    const forBob = (await h.api('bob').call(API.listMessages, { params: { id: chat }, query: {} })).items as Message[]
    expect(leaks(JSON.stringify(forBob))).toBe(false)
  })

  test('alone in the chat, alice sees it again (nothing is hidden from a chat whose people may all open it)', async () => {
    // bob leaves the project for this test: its chats are then alice's alone
    const db = h.ctx.db
    const rule = db.query("SELECT r.* FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = ? AND r.subject_type = 'group'").get(F) as { id: string; folder_id: string; subject_id: string; access: string } | null
    if (!rule) throw new Error('the finance rule on the project is missing')
    db.query('DELETE FROM folder_rules WHERE id = ?').run(rule.id)
    try {
      const chat = await newChat()
      const r = await ask(chat, fake({ tool: 'list', args: { path: F }, sayResult: true }))
      expect(r.content).toContain('hr-PAYROLL/')
    } finally { db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'group', ?, ?)").run(rule.id, rule.folder_id, rule.subject_id, rule.access) }
  })
})
