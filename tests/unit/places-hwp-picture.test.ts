// edit_hwp's image change through a real chat turn: the form in the team folder, the seal a file sent in the chat (read
// through the chat's own open) or a team file; with the pinned renderer, forms Hancom Docs saved are stamped through the
// whole tool path (the image helper, the office worker, both read-backs). HWP_PICTURE_OUT keeps the results for a look
// in Hancom Docs.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Attachment } from '@mycel/shared/api'
import { chatFilePath } from '@mycel/shared/places'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { hwpPluginOn } from '../lib/hwp-plugin'
import { componentC } from '../../server/src/team-files/component'
import { localHwpAssets, NativeHwpEngine } from '../../server/src/files/hwp-engine'
import { hwpEmploymentForm } from '../lib/hwp'
import type { HwpLayout } from '../../server/src/files/hwp-picture'

setDefaultTimeout(120_000)
const FIX = path.join(import.meta.dir, '../fixtures/hwp')
const SEAL = fs.readFileSync(path.join(FIX, 'seal.png'))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
let h: Harness, ws: TestSocket
beforeAll(async () => { h = await startHarness({ name: 'places-hwp-picture', stallTimeoutMs: 60_000 }); hwpPluginOn(h.ctx); ws = await h.ws('alice'); await ws.next('hello') })
afterAll(async () => { ws.close(); await h.close() })

async function run(chat: string, content: string, attachmentIds: string[] = []) {
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chat }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds } })
  const answered = new Set<string>()
  for (const end = Date.now() + 30_000; Date.now() < end; await Bun.sleep(25)) {
    for (const x of ws.frames) {
      if (x.type !== 'turn.request' || x.data.turnId !== r.turnId) continue
      const q = x.data.request as unknown as { kind: string; requestId: string; question?: string; options?: { value: string }[] }
      if (answered.has(q.requestId)) continue
      answered.add(q.requestId)
      await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: q.requestId, answer: q.options?.[0]?.value ?? 'yes' } })
    }
    const done = ws.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return done.data.message.content as string
  }
  throw new Error('turn did not end')
}
async function send(chat: string, name: string, bytes: Uint8Array) {
  const form = new FormData(); form.set('chatId', chat); form.set('file', new File([bytes as Uint8Array<ArrayBuffer>], name))
  return (await (await h.req('alice', '/api/uploads', { method: 'POST', body: form })).json()) as Attachment
}
const newChat = async () => (await h.api('alice').call(API.createChat, { body: {} })).id as string
const withLayout = async <T>(l: (b: Buffer, x: 'hwp' | 'hwpx') => Promise<HwpLayout>, f: () => Promise<T>) => {
  const p = componentC(h.ctx).hwp, was = p.layout
  p.layout = async (_u, b, x) => l(b, x)
  try { return await f() } finally { p.layout = was }
}

describe('the seal is a file of the chat', () => {
  test('a form in the team folder gets the seal sent in the chat', async () => {
    const rel = 'shared/chat-seal-form.hwp'
    fs.mkdirSync(path.dirname(path.join(h.team, rel)), { recursive: true })
    fs.writeFileSync(path.join(h.team, rel), hwpEmploymentForm())
    const chat = await newChat()
    await run(chat, `hello\n${fake({ say: 'hi' })}`)
    // (a chat shared with someone keeps its attachments as chat files; a private one in the person's .attachments)
    let r = await h.api('alice').call(API.putChatAudience, { params: { id: chat }, body: { subjects: [{ subjectType: 'user', subjectId: 'bob' }] } })
    if (r.status === 'confirm') r = await h.api('alice').call(API.putChatAudience, { params: { id: chat }, body: { subjects: [{ subjectType: 'user', subjectId: 'bob' }], confirmKey: r.confirmKey } })
    expect(r.status).toBe('saved')
    const seal = await send(chat, 'seal.png', SEAL)
    await run(chat, `my seal\n${fake({ say: 'ok' })}`, [seal.id])
    const layout: HwpLayout = { pages: [{ w: 793.7, h: 1122.5, section: 0, continued: [], tables: [], cells: [], starts: [{ para: 0, table: false, preview: '' }],
      lines: [{ x: 113, y: 400, w: 566, h: 13, text: '주식회사 가나다상사  대표이사 {{대표자}} (인)', runs: [{ x: 200, w: 330, text: '주식회사 가나다상사  대표이사 {{대표자}} (인)' }], para: '0:5', cell: -1 }] }] }
    const out = await withLayout(async () => layout, () => run(chat, fake({ tool: 'read', args: { file_path: rel } }, { tool: 'edit_hwp', args: { file_path: rel, changes: [{ image: chatFilePath(seal.id, 'seal.png'), at: '(인)' }] }, sayResult: true })))
    expect(out).toContain('a picture on page 1')
    expect(out).toContain(`Saved a new version of ${rel}`)
  })
})

const RHWP = fs.existsSync(localHwpAssets().bin)
;(RHWP ? describe : describe.skip)('forms Hancom Docs saved, through the whole tool path', () => {
  const engine = RHWP ? new NativeHwpEngine() : null
  const cases: [string, Record<string, unknown>[]][] = [
    ['sign-form-hancom.hwp', [{ at: '(인)', occurrence: 1 }, { at: '(인)', occurrence: 2 }, { cell: { next_to: '서명' }, width_mm: 25 }]],
    ['sign-form-hancom.hwpx', [{ at: '(인)', occurrence: 1 }, { at: '(인)', occurrence: 2 }, { cell: { next_to: '서명' }, width_mm: 25 }]],
    ['contract-hancom.hwp', [{ at: '(인)', occurrence: 1 }, { at: '(인)', occurrence: 2 }]],
  ]
  for (const [name, places] of cases) test(name, async () => {
    const rel = `users/alice/${name}`
    fs.copyFileSync(path.join(FIX, name), path.join(h.team, rel))
    fs.writeFileSync(path.join(h.team, 'users/alice/my-seal.png'), SEAL)
    const chat = await newChat()
    const changes = places.map((x) => ({ image: 'users/alice/my-seal.png', ...x }))
    const out = await withLayout((b, x) => engine!.layout(b, x), () => run(chat, fake({ tool: 'read', args: { file_path: rel } }, { tool: 'edit_hwp', args: { file_path: rel, changes }, sayResult: true })))
    expect(out).toContain('tied to the paragraph or table of its label')
    expect(out.match(/a picture on page 1/g)).toHaveLength(places.length)
    if (process.env.HWP_PICTURE_OUT) fs.copyFileSync(path.join(h.team, rel), path.join(process.env.HWP_PICTURE_OUT, name))
  })
})
