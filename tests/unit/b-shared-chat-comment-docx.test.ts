// Word comments in a shared project chat (limits audit 1 #22): comment_docx is offered there, as edit_hwp is. The
// document counts as read by the chat (a .docx some of its people cannot open asks with the read card first), and a
// new .docx (output) goes through the shared chat's write gates. The fake engine through the real launcher and gate;
// the project is projects/falcon (alice writes it, bob reads it).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type TurnRequest } from '@mycel/shared/api'
import { which } from '../../server/src/config'
import { docxExtraText } from '../../server/src/files/ooxml'
import { SHARED_TOOLS, WRITE_TARGET_ARGS } from '../../server/src/rooms/ai-tools'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'

setDefaultTimeout(90_000)
const pandoc = which('pandoc')
const withPandoc = pandoc ? test : test.skip
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
function docx(md: string): Uint8Array {
  const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from(md) })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return new Uint8Array(r.stdout)
}
const CONTRACT = '# Supply contract\n\nArticle 1 (Purpose) This contract covers office supplies.\n\nArticle 3 (Payment) Paid at the end of each month.\n'

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-comment-docx', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u, { windowId: `win-cdx-${u}` }); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: 'Falcon project notes.' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const abs = (rel: string) => path.join(h.team, rel)
const put = (rel: string, b: string | Uint8Array) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), b) }
type Ask = TurnRequest & { requestId: string; question?: string; options?: { label: string; value: string }[] }
/** one answer by `user` in the chat, each card answered with the next of `answers` (the last one repeats) */
async function turn(user: string, chatId: string, content: string, answers: string[]) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Ask[] = []
  const seen = new Set<string>()
  for (let waited = 0; ; waited += 50) {
    if (waited > 80_000) throw new Error('the answer did not end')
    for (const f of ws[user]!.frames) {
      if (f.type !== 'turn.request' || f.data.turnId !== r.turnId || seen.has(f.data.request.requestId)) continue
      seen.add(f.data.request.requestId)
      cards.push(f.data.request as Ask)
      const answer = answers[Math.min(cards.length - 1, answers.length - 1)]!
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: f.data.request.requestId, answer } })
    }
    const done = ws[user]!.frames.find((f) => f.type === 'message.done' && f.data.messageId === r.assistantMessage.id)
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, content: done.data.message.content as string }
    await Bun.sleep(50)
  }
}
const newShared = async () => (await h.api('alice').call(API.createChat, { body: { projectId } })).id
const comments = [{ on: 'Article 3 (Payment)', text: 'Please check the payment date.' }]
const commentsIn = (rel: string) => docxExtraText(new Uint8Array(fs.readFileSync(abs(rel))))

describe('comment_docx in a shared project chat', () => {
  test('offered there, and its output is a write target (the read card counts it only when a file is there)', () => {
    expect(SHARED_TOOLS.has('comment_docx')).toBe(true)
    expect(WRITE_TARGET_ARGS.comment_docx).toEqual(['output'])
  })

  withPandoc('the project\'s own contract: no card, a new version with the comment (before: the tool was not there)', async () => {
    put('projects/falcon/contract.docx', docx(CONTRACT))
    const chat = await newShared()
    const r = await turn('alice', chat, fake(
      { tool: 'read', args: { file_path: 'projects/falcon/contract.docx' } },
      { tool: 'comment_docx', args: { file_path: 'projects/falcon/contract.docx', comments }, sayResult: true },
    ), ['skip'])
    expect(r.cards).toEqual([])
    expect(r.content).toContain('Saved a new version of projects/falcon/contract.docx with the comments')
    expect(commentsIn('projects/falcon/contract.docx')).toContain('Please check the payment date.')
    // bob, who sees the chat, gets no card of alice's turn
    expect(ws.bob!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === r.turnId)).toBe(false)
  })

  withPandoc('a contract in the asker\'s own folder, in their project chat: no read card, the commented copy is saved', async () => {
    put('users/alice/draft-acme.docx', docx(CONTRACT))
    const before = fs.readFileSync(abs('users/alice/draft-acme.docx'))
    const call = fake(
      { tool: 'read', args: { file_path: 'users/alice/draft-acme.docx' } },
      { tool: 'comment_docx', args: { file_path: 'users/alice/draft-acme.docx', comments, output: 'users/alice/draft-acme (reviewed).docx' }, sayResult: true },
    )
    const chat = await newShared()
    // (docs/decisions/20261123-do-then-undo.md, the owner: the asker's own folder in their project chat asks nothing)
    const yes = await turn('alice', chat, call, ['share'])
    expect(yes.cards.filter((c) => c.options?.some((o) => o.value === 'share'))).toEqual([])
    expect(yes.content).toContain('Saved users/alice/draft-acme (reviewed).docx with the comments')
    expect(commentsIn('users/alice/draft-acme (reviewed).docx')).toContain('Please check the payment date.')
    expect(fs.readFileSync(abs('users/alice/draft-acme.docx')).equals(before)).toBe(true)
  })
})
