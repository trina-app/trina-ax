// make_zip in a shared project chat (QA TC-4920, security review of #1302; TC-4945): a zip of a folder shows the names
// of everything under it. A sub-folder with its own rules that not everyone in the chat may open is not there for the
// chat (docs/decisions/20261118-shared-hide-subfolder-names.md): the zip leaves it out and no read card is about it.
// projects/falcon is shared with alice and bob (finance).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { zipEntries } from '../../server/src/file-list/sniff'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-make-zip', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  ws.alice = await h.ws('alice'); await ws.alice.next('hello')
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { ws.alice?.close(); await h.close() })

const send = (chatId: string, content: string) => h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
const cards = (chatId: string) => (h.ctx.db.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'chat.shared_read' AND target = ?").get(chatId) as { n: number }).n

describe('make_zip in a shared chat', () => {
  test('a zip of a folder with a sub-folder some of the chat cannot open: no card, the zip is made without it (TC-4945)', async () => {
    // projects/falcon/hr: alice's only (a rule of its own), with a file whose name must not reach bob. Since the
    // hidden sub-folder rule (docs/decisions/20261118-shared-hide-subfolder-names.md) the folder is not there for the
    // chat: no read card is about it, and the zip holds everything else
    const db = h.ctx.db
    db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run('f_falcon_hr', 'projects/falcon/hr')
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, 'f_falcon_hr', 'everyone', NULL, 'none')").run(crypto.randomUUID())
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, 'f_falcon_hr', 'user', 'alice', 'write')").run(crypto.randomUUID())
    fs.mkdirSync(path.join(h.team, 'projects/falcon/hr'), { recursive: true })
    fs.writeFileSync(path.join(h.team, 'projects/falcon/hr/layoff-plan-2027.txt'), 'secret')
    fs.writeFileSync(path.join(h.team, 'projects/falcon/notes.txt'), 'open')
    try {
      const bob = h.ctx.files.principal('bob')
      expect(h.ctx.files.rules().access(bob, ['projects', 'falcon', 'notes.txt'])).not.toBe('none')
      expect(h.ctx.files.rules().access(bob, ['projects', 'falcon', 'hr'])).toBe('none')
      const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
      const started = await send(chat.id, fake({ tool: 'make_zip', args: { paths: ['projects/falcon'], output: 'users/alice/all.zip' }, sayResult: true }))
      const done = await ws.alice!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
      expect(ws.alice!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === started.turnId)).toBe(false)
      expect(cards(chat.id)).toBe(0)
      const reply = done.data.message.content as string
      // entry names in any letter case (a case-sensitive Linux disk or not), with or without the folder's own name first
      const named = (s: string) => /(^|[\s/'"`(\[])hr\//i.test(s) || /layoff/i.test(s)
      expect(named(reply)).toBe(false)
      const zip = path.join(h.team, 'users/alice/all.zip')
      expect(fs.existsSync(zip)).toBe(true)
      const entries = (zipEntries(new Uint8Array(fs.readFileSync(zip))) ?? []).map((e) => e.name)
      expect(entries.some((n) => n.endsWith('notes.txt'))).toBe(true)
      expect(entries.filter((n) => /(^|\/)hr(\/|$)/i.test(n) || /layoff/i.test(n))).toEqual([])
    } finally {
      db.query("DELETE FROM folder_rules WHERE folder_id = 'f_falcon_hr'").run()
      db.query("DELETE FROM folders WHERE id = 'f_falcon_hr'").run()
      fs.rmSync(path.join(h.team, 'projects/falcon/hr'), { recursive: true, force: true })
      fs.rmSync(path.join(h.team, 'users/alice/all.zip'), { force: true })
    }
  })
  test('a zip of the project folder itself (everyone in the chat reads it) asks nothing', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
    const before = cards(chat.id)
    const started = await send(chat.id, fake({ tool: 'make_zip', args: { paths: ['projects/falcon'], output: 'projects/falcon/copy.zip' } }, { say: 'zipped' }))
    const done = await ws.alice!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
    expect(done.data.message.content).toContain('zipped')
    expect(cards(chat.id)).toBe(before)
  })
})
