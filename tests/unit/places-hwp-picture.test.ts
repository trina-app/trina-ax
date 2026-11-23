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
import { editHwp } from '../../server/src/files/hwp-edit'
import { editHwpx } from '../../server/src/files/hwpx-edit'
import type { HwpLayout } from '../../server/src/files/hwp-picture'
import { hwpText } from '../../server/src/files/hwp'
import { readCfb } from '../../server/src/files/cfb'

setDefaultTimeout(120_000)
const FIX = path.join(import.meta.dir, '../fixtures/hwp')
const SEAL = fs.readFileSync(path.join(FIX, 'seal.png'))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
let h: Harness
const sockets: Record<string, TestSocket> = {}
beforeAll(async () => { h = await startHarness({ name: 'places-hwp-picture', stallTimeoutMs: 60_000 }); hwpPluginOn(h.ctx); for (const u of ['alice', 'bob']) { sockets[u] = await h.ws(u); await sockets[u]!.next('hello') } })
afterAll(async () => { for (const s of Object.values(sockets)) s.close(); await h.close() })

type Card = { kind: string; requestId: string; question?: string; options?: { value: string }[] }
/** one turn; each card is answered with its first button, or its last with `no` */
async function turn(user: string, chat: string, content: string, o: { attachmentIds?: string[]; no?: RegExp } = {}) {
  const ws = sockets[user]!
  const r = await h.api(user).call(API.sendMessage, { params: { id: chat }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: o.attachmentIds ?? [] } })
  const cards: Card[] = []
  for (const end = Date.now() + 40_000; Date.now() < end; await Bun.sleep(25)) {
    for (const x of ws.frames) {
      if (x.type !== 'turn.request' || x.data.turnId !== r.turnId) continue
      const q = x.data.request as unknown as Card
      if (cards.some((c) => c.requestId === q.requestId)) continue
      cards.push(q)
      const no = o.no?.test(q.question ?? '')
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: q.requestId, answer: (no ? q.options?.at(-1)?.value : q.options?.[0]?.value) ?? (no ? 'skip' : 'yes') } })
    }
    const done = ws.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { content: done.data.message.content as string, cards }
  }
  throw new Error('turn did not end')
}
const run = async (chat: string, content: string, attachmentIds: string[] = []) => (await turn('alice', chat, content, { attachmentIds })).content
async function send(chat: string, name: string, bytes: Uint8Array, user = 'alice') {
  const form = new FormData(); form.set('chatId', chat); form.set('file', new File([bytes as Uint8Array<ArrayBuffer>], name))
  return (await (await h.req(user, '/api/uploads', { method: 'POST', body: form })).json()) as Attachment
}
const newChat = async () => (await h.api('alice').call(API.createChat, { body: {} })).id as string
async function shareWithBob(chat: string) {
  const subjects = [{ subjectType: 'user' as const, subjectId: 'bob' }]
  let r = await h.api('alice').call(API.putChatAudience, { params: { id: chat }, body: { subjects } })
  if (r.status === 'confirm') r = await h.api('alice').call(API.putChatAudience, { params: { id: chat }, body: { subjects, confirmKey: r.confirmKey } })
  expect(r.status).toBe('saved')
}
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
    await shareWithBob(chat)
    const seal = await send(chat, 'seal.png', SEAL)
    await run(chat, `my seal\n${fake({ say: 'ok' })}`, [seal.id])
    const layout: HwpLayout = { pages: [{ w: 793.7, h: 1122.5, section: 0, continued: [], tables: [], cells: [], starts: [{ para: 0, table: false, preview: '' }],
      lines: [{ x: 113, y: 400, w: 566, h: 13, text: '주식회사 가나다상사  대표이사 {{대표자}} (인)', runs: [{ x: 200, w: 330, text: '주식회사 가나다상사  대표이사 {{대표자}} (인)' }], para: '0:5', cell: -1 }] }] }
    const out = await withLayout(async () => layout, () => run(chat, fake({ tool: 'read', args: { file_path: rel } }, { tool: 'edit_hwp', args: { file_path: rel, changes: [{ image: chatFilePath(seal.id, 'seal.png'), at: '(인)' }] }, sayResult: true })))
    expect(out).toContain('a picture on page 1')
    expect(out).toContain(`Saved a new version of ${rel}`)
  })

  const LAYOUT: HwpLayout = { pages: [{ w: 793.7, h: 1122.5, section: 0, continued: [], tables: [], cells: [], starts: [{ para: 0, table: false, preview: '' }],
    lines: [{ x: 113, y: 400, w: 566, h: 13, text: '주식회사 가나다상사  대표이사 {{대표자}} (인)', runs: [{ x: 200, w: 330, text: '주식회사 가나다상사  대표이사 {{대표자}} (인)' }], para: '0:5', cell: -1 }] }] }
  // the layout after the call's text change (the picture is placed from it)
  const FILLED: HwpLayout = JSON.parse(JSON.stringify(LAYOUT).replaceAll('{{대표자}}', '김예시'))
  FILLED.pages[0]!.starts.push({ para: 5, table: false, preview: '' })
  const versions = (id: string) => (h.ctx.db.query('SELECT COUNT(*) AS n FROM chat_files WHERE id = ? OR root_id = ?').get(id, id) as { n: number }).n
  const chatWithForm = async () => {
    const chat = await newChat()
    await turn('alice', chat, `hello\n${fake({ say: 'hi' })}`)
    await shareWithBob(chat)
    const doc = await send(chat, 'form.hwp', hwpEmploymentForm())
    const seal = await send(chat, 'seal.png', SEAL)
    await turn('alice', chat, `the form and my seal\n${fake({ say: 'ok' })}`, { attachmentIds: [doc.id, seal.id] })
    return { chat, doc, seal, p: chatFilePath(doc.id, 'form.hwp') }
  }

  test('the form is a chat file: text and the sender\'s own uploaded seal make a new version with no picture card; the other member opens it', async () => {
    const { chat, doc, seal, p } = await chatWithForm()
    const r = await withLayout(async () => FILLED, () => turn('alice', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit_hwp', args: { file_path: p, changes: [{ find: '{{대표자}}', replace: '김예시' }, { image: chatFilePath(seal.id, 'seal.png'), at: '(인)' }] }, sayResult: true })))
    expect(r.cards.filter((c) => /did not upload this picture/.test(c.question ?? ''))).toHaveLength(0)
    expect(r.content).toContain('saved as version 2')
    expect(versions(doc.id)).toBe(2)
    const got = new Uint8Array(await (await h.req('bob', `/api/chats/${chat}/files/${doc.id}`)).arrayBuffer())
    expect(hwpText(got)).toContain('김예시')
    expect(readCfb(got).streams.has('BinData/BIN0001.png')).toBe(true)
  })

  test('a seal another member sent: a card first; no means nothing saved, yes puts it in', async () => {
    const { chat, doc, p } = await chatWithForm()
    const bobs = await send(chat, 'bob-seal.png', SEAL, 'bob')
    await turn('bob', chat, `my seal\n${fake({ say: 'ok' })}`, { attachmentIds: [bobs.id] })
    const call = fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit_hwp', args: { file_path: p, changes: [{ image: chatFilePath(bobs.id, 'bob-seal.png'), at: '(인)' }] }, sayResult: true })
    const no = await withLayout(async () => LAYOUT, () => turn('alice', chat, call, { no: /did not upload this picture/ }))
    expect(no.cards.filter((c) => /did not upload this picture/.test(c.question ?? ''))).toHaveLength(1)
    expect(no.content).toContain('Nothing was saved')
    expect(versions(doc.id)).toBe(1)
    const yes = await withLayout(async () => LAYOUT, () => turn('alice', chat, call))
    expect(yes.cards.filter((c) => /did not upload this picture/.test(c.question ?? ''))).toHaveLength(1)
    expect(yes.content).toContain('saved as version 2')
  })

  test('the card names every picture', async () => {
    const { chat, doc, seal, p } = await chatWithForm()
    fs.mkdirSync(path.join(h.team, 'shared/seals'), { recursive: true })
    const team = Array.from({ length: 6 }, (_, k) => `shared/seals/seal-${k}.png`)
    for (const t of team) fs.writeFileSync(path.join(h.team, t), Buffer.concat([SEAL]))
    const changes = [{ image: chatFilePath(seal.id, 'seal.png'), at: '(인)' }, ...team.map((image) => ({ image, at: '(인)' }))]
    const r = await withLayout(async () => LAYOUT, () => turn('alice', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit_hwp', args: { file_path: p, changes }, sayResult: true }), { no: /did not upload this picture/ }))
    const card = r.cards.find((c) => /did not upload this picture/.test(c.question ?? ''))!
    expect(card.question).not.toContain("'seal.png'") // the person's own upload needs no asking
    for (const t of team) expect(card.question).toContain(t)
    expect(versions(doc.id)).toBe(1)
  })

  test('another member\'s AI writes a new version of the person\'s seal: stamping it asks; no means nothing saved', async () => {
    const { chat, doc, seal, p } = await chatWithForm()
    const sealPath = chatFilePath(seal.id, 'seal.png')
    fs.mkdirSync(path.join(h.team, 'shared/brand'), { recursive: true })
    fs.writeFileSync(path.join(h.team, 'shared/brand/bobs-picture.png'), SEAL)
    const bob = await turn('bob', chat, fake({ tool: 'read', args: { file_path: sealPath } }, { tool: 'resize_images', args: { paths: ['shared/brand/bobs-picture.png'], width: 16, output: sealPath }, sayResult: true }))
    expect(bob.content).not.toContain('Not done')
    expect(versions(seal.id)).toBe(2)
    const r = await withLayout(async () => LAYOUT, () => turn('alice', chat, fake({ tool: 'read', args: { file_path: p } }, { tool: 'edit_hwp', args: { file_path: p, changes: [{ image: sealPath, at: '(인)' }] }, sayResult: true }), { no: /did not upload this picture/ }))
    expect(r.cards.filter((c) => /did not upload this picture/.test(c.question ?? ''))).toHaveLength(1)
    expect(r.content).toContain('Nothing was saved')
    expect(versions(doc.id)).toBe(1)
  })

  test('a member who cannot see the form (uploaded, not sent) cannot change it, and it stays as it was', async () => {
    const chat = await newChat()
    await turn('alice', chat, `hello\n${fake({ say: 'hi' })}`)
    await shareWithBob(chat)
    const doc = await send(chat, 'unsent.hwp', hwpEmploymentForm())
    const p = chatFilePath(doc.id, 'unsent.hwp')
    const r = await withLayout(async () => LAYOUT, () => turn('bob', chat, fake({ tool: 'edit_hwp', args: { file_path: p, changes: [{ find: '{{대표자}}', replace: '김예시' }] }, sayResult: true })))
    expect(r.content).toMatch(/not found|Not done|not changed|Error/i)
    expect(r.content).not.toContain('saved as version')
    expect(versions(doc.id)).toBe(1)
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
  // the picture is placed from the document as the call's other changes left it
  const spotOf = (text: string) => { const m = /a picture on page \d+, ([\d.]+) x ([\d.]+) mm, ([\d.]+) mm from the left and ([\d.]+) mm from the top/.exec(text)!; return { h: Number(m[2]), y: Number(m[4]) } }
  const MM = 25.4 / 96
  for (const ext of ['hwp', 'hwpx'] as const) {
    test(`.${ext}: rows added above the label cell in the same call: the signature is on that cell's new row`, async () => {
      const rel = `users/alice/rows-before-seal.${ext}`
      const form = fs.readFileSync(path.join(FIX, `sign-form.${ext}`))
      fs.writeFileSync(path.join(h.team, rel), form)
      fs.writeFileSync(path.join(h.team, 'users/alice/my-seal.png'), SEAL)
      const rows = { add_rows: { table_with: '멘토', after_row: 1, rows: [['추가 1', '값'], ['추가 2', '값'], ['추가 3', '값']] } }
      const chat = await newChat()
      const out = await withLayout((b, x) => engine!.layout(b, x), () => run(chat, fake({ tool: 'read', args: { file_path: rel } }, { tool: 'edit_hwp', args: { file_path: rel, changes: [rows, { image: 'users/alice/my-seal.png', cell: { next_to: '작성일' }, width_mm: 15 }] }, sayResult: true })))
      const filled = ext === 'hwp' ? editHwp(new Uint8Array(form), [rows]) : editHwpx(new Uint8Array(form), [rows])
      const pg = (await engine!.layout(Buffer.from(filled.file), ext)).pages[0]!
      const label = pg.lines.find((l) => l.text === '작성일')!, cell = pg.cells[label.cell]!
      const right = pg.cells.find((c) => c.table === cell.table && c.row === cell.row && c.col === cell.col + 1)!
      const s = spotOf(out)
      expect(Math.abs(s.y + s.h / 2 - (right.y + right.h / 2) * MM)).toBeLessThan(0.5)
      const before = (await engine!.layout(form, ext)).pages[0]!.lines.find((l) => l.text === '작성일')!
      expect(label.y).toBeGreaterThan(before.y + 20) // the rows did move the label
    })
    test(`.${ext}: a text fill that wraps to an extra line above the seal mark in the same call: the seal is on the mark`, async () => {
      const rel = `users/alice/wrap-before-seal.${ext}`
      const form = fs.readFileSync(path.join(FIX, `sign-form.${ext}`))
      fs.writeFileSync(path.join(h.team, rel), form)
      fs.writeFileSync(path.join(h.team, 'users/alice/my-seal.png'), SEAL)
      const fill = { find: '끝.', replace: '이 협약의 내용은 갑과 을이 함께 확인하였으며 다음 해 말까지 효력을 가지고 필요한 경우 서로 협의하여 바꿀 수 있다. '.repeat(3) }
      const chat = await newChat()
      const out = await withLayout((b, x) => engine!.layout(b, x), () => run(chat, fake({ tool: 'read', args: { file_path: rel } }, { tool: 'edit_hwp', args: { file_path: rel, changes: [fill, { image: 'users/alice/my-seal.png', at: '(인)' }] }, sayResult: true })))
      const filled = ext === 'hwp' ? editHwp(new Uint8Array(form), [fill]) : editHwpx(new Uint8Array(form), [fill])
      const line = (await engine!.layout(Buffer.from(filled.file), ext)).pages[0]!.lines.find((l) => l.text.includes('(인)'))!
      const s = spotOf(out)
      expect(Math.abs(s.y + s.h / 2 - (line.y + line.h / 2) * MM)).toBeLessThan(0.5)
      const before = (await engine!.layout(form, ext)).pages[0]!.lines.find((l) => l.text.includes('(인)'))!
      expect(line.y).toBeGreaterThan(before.y + 20)
    })
  }
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
