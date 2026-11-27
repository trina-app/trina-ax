// QA TC-7332 (follow-up of #284, docs/decisions/20261121-ai-scratch-files.md rule 4): in a shared project chat the AI
// said "I can't delete files or folders from this chat" and made no call. delete_files was left out of the shared
// chat's tool list (rooms/ai-tools.ts SHARED_TOOLS), so the unit tests of the tool itself passed while a real turn never
// had it. Here, through a real turn with the fake engine: the tool is offered in a shared project chat, the prompt does
// not say the AI cannot delete, the AI's own file of this chat goes to the trash without a card, and a teammate's file
// asks on the delete card as in a private chat (docs/decisions/20261126-shared-chat-everything.md; no answer: nothing
// moved).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { DELETE_REFUSAL } from '../../server/src/chat/delete-files'
import { SHARED_TOOLS } from '../../server/src/rooms/ai-tools'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const user = (id: string): ProjectParticipant => ({ subjectType: 'user', subjectId: id })

let h: Harness
const ws: Record<string, TestSocket> = {}
let folder = ''
let shared = ''
beforeAll(async () => {
  h = await startHarness({ name: 'ai-scratch-shared', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const p = await h.api('dana').call(API.createProject, { body: { name: 'Scratch Share', participants: [user('alice'), user('bob')], instructions: '' } })
  folder = p.folderPath
  shared = (await h.api('alice').call(API.createChat, { body: { projectId: p.id } })).id
  expect((await h.api('alice').call(API.getChat, { params: { id: shared } })).shared).toBeTruthy()
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

async function ask(who: string, content: string) {
  const started = await h.api(who).call(API.sendMessage, { params: { id: shared }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const done = await ws[who]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return done.data.message as { content: string }
}
const abs = (rel: string) => path.join(h.team, ...rel.split('/'))
const cards = (who: string) => ws[who]!.frames.filter((f) => f.type === 'turn.request').length

describe('QA TC-7332: delete_files in a shared project chat', () => {
  test('offered there, and the prompt does not tell the AI it cannot delete', async () => {
    expect(SHARED_TOOLS.has('delete_files')).toBe(true)
    const tools = (await ask('alice', fake({ echo: 'tools' }))).content
    expect(tools.split(',')).toContain('delete_files')
    const sys = (await ask('alice', fake({ echo: 'system' }))).content
    expect(sys).not.toContain('You cannot delete files or folders in this chat')
    expect(sys).not.toContain('putting team files in the trash;')
    expect(sys).toContain('files you made yourself in this chat for Alice Kim')
  })

  test('the AI\'s own file of this chat goes to the trash with no card; a teammate\'s file asks on the delete card (no answer: nothing moved)', async () => {
    const mine = `${folder}/notes/hello-summary.md`
    await ask('alice', fake({ tool: 'write', args: { file_path: mine, content: '# hello\n' }, sayResult: true }))
    expect(fs.existsSync(abs(mine))).toBe(true)
    const before = cards('alice')
    const gone = await ask('alice', `delete the notes you made\n${fake({ tool: 'delete_files', args: { paths: [`${folder}/notes`] }, sayResult: true })}`)
    expect(gone.content).toContain('files you made yourself in this chat')
    expect(fs.existsSync(abs(`${folder}/notes`))).toBe(false)
    expect(cards('alice')).toBe(before)
    // bob's file in the same project (his own answer in this chat): alice's AI asks on the delete card, as in her own chat
    const his = `${folder}/bob-plan.md`
    await ask('bob', fake({ tool: 'write', args: { file_path: his, content: '# plan\n' }, sayResult: true }))
    expect(fs.existsSync(abs(his))).toBe(true)
    const no = await ask('alice', `delete bob-plan.md\n${fake({ tool: 'delete_files', args: { paths: [his] }, sayResult: true })}`)
    expect(no.content).not.toContain(DELETE_REFUSAL.shared)
    expect(fs.existsSync(abs(his))).toBe(true)
    expect(cards('alice')).toBe(before + 1)
  })

  test('a file alice\'s AI made that bob then changed in this chat is not hers alone any more: the card (no answer: nothing moved)', async () => {
    const f = `${folder}/draft.md`
    await ask('alice', fake({ tool: 'write', args: { file_path: f, content: '# draft\n' }, sayResult: true }))
    await ask('bob', fake({ tool: 'read', args: { file_path: f } }, { tool: 'write', args: { file_path: f, content: '# draft v2\n' }, sayResult: true }))
    expect(fs.readFileSync(abs(f), 'utf8')).toContain('draft v2')
    const before = cards('alice')
    const no = await ask('alice', `delete draft.md\n${fake({ tool: 'delete_files', args: { paths: [f] }, sayResult: true })}`)
    expect(no.content).not.toContain(DELETE_REFUSAL.shared)
    expect(fs.existsSync(abs(f))).toBe(true)
    expect(cards('alice')).toBe(before + 1)
  })
})
