// The PDF tools in a shared project chat (docs/decisions/20261116-edit-pdf.md): a PDF or image some of the
// chat's people cannot open asks with the shared chat's read card first, also when it is named inside edit_pdf's
// operations or merge_pdfs' list; the project's own files need no card. The fake engine through the real launcher and
// gate; the project is projects/falcon (alice writes it, the finance group, bob, reads it).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type TurnRequest } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { pngRgbaOf } from '../lib/images'
import { makePagedPdf } from '../lib/pdf'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-pdf', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u, { windowId: `win-pdf-${u}` }); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: 'Falcon project notes.' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const abs = (rel: string) => path.join(h.team, rel)
const put = (rel: string, b: string | Uint8Array) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), b) }
type Ask = TurnRequest & { requestId: string; question?: string; options?: { label: string; value: string }[] }
/** one answer by `user` in the shared chat, each card answered with the next of `answers` (the last one repeats) */
async function turn(user: string, chatId: string, content: string, answers: string[]) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Ask[] = []
  const seen = new Set<string>()
  for (let waited = 0; ; waited += 50) {
    if (waited > 60_000) throw new Error('the answer did not end')
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
const clearAlways = () => h.ctx.db.query('DELETE FROM card_always_allow').run()

describe('stamp_pdf in a shared chat', () => {
  const SEAL = pngRgbaOf(40, 40, (x, y) => ((x - 19.5) ** 2 + (y - 19.5) ** 2 < 18 ** 2 ? [200, 0, 0, 255] : [0, 0, 0, 0]))
  // (docs/decisions/20261123-do-then-undo.md, the owner: the person's own folder read in their own project chat asks
  // nothing: no read card, the stamped copy is saved next to the original)
  test('a PDF in the asker\'s own folder, in their project chat: no read card, the stamped copy is saved', async () => {
    put('users/alice/quote-acme.pdf', makePagedPdf([['Quote for Acme'], ['Terms']]))
    put('users/alice/seal.png', SEAL)
    const call = fake({ tool: 'stamp_pdf', args: { file_path: 'users/alice/quote-acme.pdf', image: 'users/alice/seal.png' }, sayResult: true })
    const chat = await newShared()
    const yes = await turn('alice', chat, call, ['share'])
    expect(yes.cards.filter((c) => c.options?.some((o) => o.value === 'share'))).toEqual([])
    expect(yes.content).toContain('Saved users/alice/quote-acme (stamped).pdf; users/alice/quote-acme.pdf is unchanged.')
    expect(fs.existsSync(abs('users/alice/quote-acme (stamped).pdf'))).toBe(true)
    expect(ws.bob!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === yes.turnId)).toBe(false)
  })

  test('page written as text ("1") goes through the whole answer path (the engine, the MCP handler, the registry): stamped, not "Invalid input" (TC-5241)', async () => {
    put('projects/falcon/quotes/quote-text-page.pdf', makePagedPdf([['Quote page one'], ['Terms page two']]))
    put('projects/falcon/brand/seal.png', SEAL)
    const chat = await newShared()
    const r = await turn('alice', chat, fake({ tool: 'stamp_pdf', args: { file_path: 'projects/falcon/quotes/quote-text-page.pdf', image: 'projects/falcon/brand/seal.png', page: '1' }, sayResult: true }), [])
    expect(r.content).not.toContain('Invalid input')
    expect(r.content).toContain('Saved projects/falcon/quotes/quote-text-page (stamped).pdf')
    expect(r.content).toContain('page 1 of 2')
  })

  test('the project\'s own PDF and seal: no card, saved next to the original', async () => {
    put('projects/falcon/quotes/quote-falcon.pdf', makePagedPdf([['Quote for Falcon']]))
    put('projects/falcon/brand/seal.png', SEAL)
    const chat = await newShared()
    const r = await turn('alice', chat, fake({ tool: 'stamp_pdf', args: { file_path: 'projects/falcon/quotes/quote-falcon.pdf', image: 'projects/falcon/brand/seal.png', position: 'bottom-left' }, sayResult: true }), ['skip'])
    expect(r.cards).toEqual([])
    expect(r.content).toContain('Saved projects/falcon/quotes/quote-falcon (stamped).pdf')
    expect(fs.existsSync(abs('projects/falcon/quotes/quote-falcon (stamped).pdf'))).toBe(true)
  })

  test('edit_pdf naming my own PDF inside its operations, and merge_pdfs with one in its list: no read card in my project chat', async () => {
    put('projects/falcon/quotes/q1.pdf', makePagedPdf([['Q1']]))
    put('projects/falcon/quotes/q2.pdf', makePagedPdf([['Q2']]))
    put('users/alice/annex.pdf', makePagedPdf([['ANNEX']]))
    const chat = await newShared()
    // (the asker's own folder in their project chat: no read card since docs/decisions/20261123-do-then-undo.md)
    const ins = await turn('alice', chat, fake({ tool: 'edit_pdf', args: { file_path: 'projects/falcon/quotes/q1.pdf', operations: [{ insert_pdf: { file: 'users/alice/annex.pdf', after: 'last' } }] }, sayResult: true }), ['skip'])
    expect(ins.cards.filter((c) => c.options?.some((o) => o.value === 'share'))).toEqual([])
    const merge = await turn('alice', chat, fake({ tool: 'merge_pdfs', args: { files: ['projects/falcon/quotes/q1.pdf', { path: 'users/alice/annex.pdf' }] }, sayResult: true }), ['skip'])
    expect(merge.cards.filter((c) => c.options?.some((o) => o.value === 'share'))).toEqual([])
    // the project's own files: no card
    const own = await turn('alice', chat, fake({ tool: 'merge_pdfs', args: { files: ['projects/falcon/quotes/q1.pdf', 'projects/falcon/quotes/q2.pdf'] }, sayResult: true }), ['skip'])
    expect(own.cards).toEqual([])
    // (the merge with my annex went first, so this one takes the next name)
    expect(own.content).toContain('Saved projects/falcon/quotes/q1 (merged) (2).pdf (2 pages).')
    const pages = await turn('alice', chat, fake({ tool: 'edit_pdf', args: { file_path: 'projects/falcon/quotes/q1 (merged).pdf', operations: [{ page_numbers: {} }] }, sayResult: true }), ['skip'])
    expect(pages.cards).toEqual([])
    expect(pages.content).toContain('Saved projects/falcon/quotes/q1 (merged) (edited).pdf (2 pages).')
  })
})
