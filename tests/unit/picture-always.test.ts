// "Always allow" on the card for a picture the person did not upload (docs/decisions/20261123-picture-always-allow.md):
// it covers exactly the pictures the card listed, for this person, across turns and in their scheduled runs, until
// they take it back in Settings. Through real chat turns of edit_office insert_picture (edit_hwp: places-hwp-picture).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { API, type AiAllowance, type Attachment } from '@mycel/shared/api'
import { chatFilePath } from '@mycel/shared/places'
import { which } from '../../server/src/config'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { CONFIRMED } from '../lib/schedule-card'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const pandoc = which('pandoc')
const t = pandoc ? test : test.skip
const ALWAYS = '__always'
const isCard = (q?: string) => /did not upload this picture|직접 올린 그림/.test(q ?? '')

function png(n: number): Uint8Array {
  const c = (k: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const b = Buffer.concat([Buffer.from(k), d]); const x = Buffer.alloc(4); x.writeUInt32BE(zlib.crc32(b) >>> 0); return Buffer.concat([l, b, x]) }
  const i = Buffer.alloc(13); i.writeUInt32BE(n, 0); i.writeUInt32BE(n, 4); i[8] = 8; i[9] = 2
  const rows = Buffer.concat(Array.from({ length: n }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(n * 3, 90)])))
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), c('IHDR', i), c('IDAT', zlib.deflateSync(rows)), c('IEND', Buffer.alloc(0))]))
}

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'picture-always', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000, timeZone: 'Asia/Seoul' })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const abs = (rel: string) => path.join(h.team, ...rel.split('/'))
const put = (rel: string, b: Uint8Array) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), b) }
const form = (rel: string) => put(rel, new Uint8Array(Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from('# Form\n\nSigner (seal) and (mark)\n') }).stdout))
const stamp = (doc: string, images: string[]) => fake({ tool: 'read', args: { file_path: doc } }, { tool: 'edit_office', args: { file_path: doc, changes: images.map((image) => ({ insert_picture: { image, over: '(seal)' } })) }, sayResult: true })
const newChat = async (user = 'alice') => (await h.api(user).call(API.createChat, { body: {} })).id as string
const pictures = async (user = 'alice') => ((await h.api(user).call(API.listAiAllowances)).items as AiAllowance[]).filter((a) => a.kind === 'picture')

type Card = { requestId: string; question?: string; options?: { value: string; label: string }[]; note?: string }
/** one turn; the picture card takes `answer` (a value of its options), any other card its first button */
async function turn(user: string, chat: string, content: string, answer: 'always' | 'yes' | 'no' = 'no', attachmentIds: string[] = []) {
  const sock = ws[user]!
  const r = await h.api(user).call(API.sendMessage, { params: { id: chat }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds } })
  const cards: Card[] = []
  for (const end = Date.now() + 40_000; Date.now() < end; await Bun.sleep(25)) {
    for (const x of sock.frames) {
      if (x.type !== 'turn.request' || x.data.turnId !== r.turnId) continue
      const q = x.data.request as unknown as Card
      if (cards.some((c) => c.requestId === q.requestId)) continue
      cards.push(q)
      const v = !isCard(q.question) ? q.options?.[0]?.value : answer === 'always' ? ALWAYS : answer === 'yes' ? q.options?.[0]?.value : q.options?.at(-1)?.value
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: q.requestId, answer: v ?? 'skip' } })
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { content: done.data.message.content as string, cards: cards.filter((c) => isCard(c.question)) }
  }
  throw new Error('turn did not end')
}
const farTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + 12 * 3600_000))
/** alice's scheduled task runs `prompt` now; whether its edit_office call worked */
async function scheduled(chatId: string, prompt: string): Promise<boolean> {
  const db = h.ctx.db
  const s = h.rt().schedules.create('alice', { title: 'T ' + crypto.randomUUID().slice(0, 6), prompt, repeat: 'daily', time: farTime() }, undefined, CONFIRMED, { chatId })
  db.query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), s.id)
  expect(h.rt().schedules.runDue(new Date())).toEqual([s.id])
  const id = (db.query('SELECT id FROM turns WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1').get(s.id) as { id: string }).id
  for (const end = Date.now() + 30_000; Date.now() < end; await Bun.sleep(25)) {
    const st = (db.query('SELECT status FROM turns WHERE id = ?').get(id) as { status: string }).status
    const m = db.query("SELECT status FROM messages WHERE turn_id = ? AND role = 'assistant'").get(id) as { status: string } | null
    if (st !== 'queued' && m && m.status !== 'streaming') break
  }
  h.rt().schedules.delete('alice', s.id)
  return (db.query("SELECT ok FROM tool_events WHERE turn_id = ? AND tool = 'edit_office' ORDER BY rowid DESC LIMIT 1").get(id) as { ok: number } | null)?.ok === 1
}

describe('Always allow on the picture card', () => {
  t('offered on the card; then no card for that picture in a later chat; a different picture still asks', async () => {
    put('shared/a/ceo.png', png(8)); put('shared/a/other.png', png(9)); form('users/alice/a1.docx')
    const first = await turn('alice', await newChat(), stamp('users/alice/a1.docx', ['shared/a/ceo.png']), 'always')
    expect(first.cards).toHaveLength(1)
    expect(first.cards[0]!.options!.map((o) => o.value)).toContain(ALWAYS)
    expect(first.cards[0]!.note).toContain('even if someone later replaces the file at that name. Other files still ask.')
    const before = fs.readFileSync(abs('users/alice/a1.docx'))
    const again = await turn('alice', await newChat(), stamp('users/alice/a1.docx', ['shared/a/ceo.png']))
    expect(again.cards).toHaveLength(0)
    expect(fs.readFileSync(abs('users/alice/a1.docx')).equals(before)).toBe(false)
    const other = await turn('alice', await newChat(), stamp('users/alice/a1.docx', ['shared/a/other.png']))
    expect(other.cards).toHaveLength(1)
    expect(other.cards[0]!.question).toContain("'shared/a/other.png'")
    expect(other.content).toContain('Nothing was saved')
    // another person's turn: Alice's Always is not theirs
    form('users/bob/b1.docx')
    expect((await turn('bob', await newChat('bob'), stamp('users/bob/b1.docx', ['shared/a/ceo.png']))).cards).toHaveLength(1)
  })

  t('a card with several pictures: Always covers exactly the listed ones, and a later card lists only the new one', async () => {
    for (const n of ['one', 'two', 'three']) put(`shared/m/${n}.png`, png(n.length + 10))
    form('users/alice/m.docx')
    await turn('alice', await newChat(), stamp('users/alice/m.docx', ['shared/m/one.png', 'shared/m/two.png']), 'always')
    expect((await pictures()).map((p) => p.picture)).toEqual(expect.arrayContaining(['shared/m/one.png', 'shared/m/two.png']))
    expect((await pictures()).map((p) => p.picture)).not.toContain('shared/m/three.png')
    const r = await turn('alice', await newChat(), stamp('users/alice/m.docx', ['shared/m/one.png', 'shared/m/three.png']))
    expect(r.cards).toHaveLength(1)
    expect(r.cards[0]!.question).toContain("'shared/m/three.png'")
    expect(r.cards[0]!.question).not.toContain('one.png')
  })

  t('a chat file is approved by its id and named by its name in Settings', async () => {
    const chat = await newChat(); form('users/alice/c.docx')
    await turn('alice', chat, fake({ say: 'hello' }))
    const subjects = [{ subjectType: 'user' as const, subjectId: 'bob' }]
    let shared = await h.api('alice').call(API.putChatAudience, { params: { id: chat }, body: { subjects } })
    if (shared.status === 'confirm') shared = await h.api('alice').call(API.putChatAudience, { params: { id: chat }, body: { subjects, confirmKey: shared.confirmKey } })
    expect(shared.status).toBe('saved')
    const up = new FormData(); up.set('chatId', chat); up.set('file', new File([png(12) as Uint8Array<ArrayBuffer>], 'bob-stamp.png'))
    const f = (await (await h.req('bob', '/api/uploads', { method: 'POST', body: up })).json()) as Attachment
    await turn('bob', chat, `my stamp\n${fake({ say: 'ok' })}`, 'no', [f.id])
    const row = { name: 'bob-stamp.png' }
    const image = chatFilePath(f.id, row.name)
    expect((await turn('alice', chat, stamp('users/alice/c.docx', [image]), 'always')).cards).toHaveLength(1)
    expect((await pictures()).some((p) => p.picture === row.name)).toBe(true)
    expect((await turn('alice', chat, stamp('users/alice/c.docx', [image]))).cards).toHaveLength(0)
  })

  t('a scheduled run: an approved picture goes in, one without an Always is refused, and taking it back refuses it again', async () => {
    put('shared/s/ok.png', png(14)); put('shared/s/no.png', png(15)); form('users/alice/s.docx')
    const chat = await newChat()
    expect(await scheduled(chat, stamp('users/alice/s.docx', ['shared/s/ok.png']))).toBe(false)
    await turn('alice', chat, stamp('users/alice/s.docx', ['shared/s/ok.png']), 'always')
    const before = fs.readFileSync(abs('users/alice/s.docx'))
    expect(await scheduled(chat, stamp('users/alice/s.docx', ['shared/s/ok.png']))).toBe(true)
    expect(fs.readFileSync(abs('users/alice/s.docx')).equals(before)).toBe(false)
    const now = fs.readFileSync(abs('users/alice/s.docx'))
    expect(await scheduled(chat, stamp('users/alice/s.docx', ['shared/s/no.png']))).toBe(false)
    expect(fs.readFileSync(abs('users/alice/s.docx')).equals(now)).toBe(true)
    const row = (await pictures()).find((p) => p.picture === 'shared/s/ok.png')!
    await h.api('alice').call(API.deleteAiAllowance, { params: { id: row.id } })
    expect(await scheduled(chat, stamp('users/alice/s.docx', ['shared/s/ok.png']))).toBe(false)
  })

  t('taken back in Settings: the card comes back; only its own person can take it back', async () => {
    put('shared/r/seal.png', png(16)); form('users/alice/r.docx')
    await turn('alice', await newChat(), stamp('users/alice/r.docx', ['shared/r/seal.png']), 'always')
    const row = (await pictures()).find((p) => p.picture === 'shared/r/seal.png')!
    expect(row.id).not.toContain('/')
    expect((await h.req('bob', `/api/ai-allowances/${row.id}`, { method: 'DELETE', headers: { 'x-mycel-csrf': '1' } })).status).toBe(404)
    expect((await turn('alice', await newChat(), stamp('users/alice/r.docx', ['shared/r/seal.png']))).cards).toHaveLength(0)
    await h.api('alice').call(API.deleteAiAllowance, { params: { id: row.id } })
    expect((await pictures()).some((p) => p.picture === 'shared/r/seal.png')).toBe(false)
    expect((await turn('alice', await newChat(), stamp('users/alice/r.docx', ['shared/r/seal.png']))).cards).toHaveLength(1)
  })
})
