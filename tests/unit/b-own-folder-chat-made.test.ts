// A file this chat made in the person's own folder, changed in a later answer after a room read, goes without the room
// card (server/src/chat/turn.ts ownFolderTarget + chat/shared-actions.ts madeInChat;
// docs/decisions/20261117-own-folder-chat-made-no-card.md). Reproduces FL-08 of the AI flow check (tests/ai-scenarios,
// 2026-11-17 default mode on dev with #1168): the quote's page and its unstamped copy, both made by the same chat in the
// person's own folder in its first answer, asked a room card each when the chat fixed them after reading the room.
// A bare link with nobody on it (made when a room post linked the file) does not count as shared. The guard holds, a
// card each, for: a personal subfolder shared with someone (a folder share), a file shared with someone, a file
// this chat did not make (there before, made by another chat, changed by the person since), a copied or renamed file,
// a skill or instruction file, a group folder, and a room's file saved over the chat's draft (save_room_file).
// The fixture team: alice and erin in marketing (groups/marketing: alice, erin, carol, dana), bob in finance.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type RoomMessage, type TurnRequest } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import crypto from 'node:crypto'
import { fileOpener, roomsOf } from '../../server/src/rooms/service'
import { roomFilesOf } from '../../server/src/rooms/files'
import { fileSharesOf, newLinkId } from '../../server/src/files/shares'
import { sharedWithAnyoneAt } from '../../server/src/files/share-readers'
import { madeInChat } from '../../server/src/chat/shared-actions'
import { pngRgbaOf } from '../lib/images'
import { makePagedPdf } from '../lib/pdf'

setDefaultTimeout(120_000)
// the fake engine's directives, their strings spelled as JSON escapes (the person's own words are only the test's)
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
type Ask = Extract<TurnRequest, { kind: 'ask_user' }>

let h: Harness
const ws: Record<string, TestSocket> = {}
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-own-folder-chat-made', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  for (const u of ['alice', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h?.close() })

let groups = 0
async function teamRoom(memberIds: string[] = ['alice', 'erin', 'carol', 'dana']): Promise<string> {
  const g = await h.api('dana').call(API.createGroup, { body: { name: `own-folder-${++groups}`, memberIds } })
  const r = (await h.api(memberIds[0]!).call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)
  if (!r) throw new Error('no team room')
  return r.id
}
const at = (rel: string) => path.join(h.team, rel)
const put = (rel: string, body: string | Uint8Array = 'x\n') => { fs.mkdirSync(path.dirname(at(rel)), { recursive: true }); fs.writeFileSync(at(rel), body) }
const exists = (rel: string) => fs.existsSync(at(rel))
const read = (rel: string) => fs.readFileSync(at(rel), 'utf8')
const values = (c: Ask) => c.options?.map((o) => o.value) ?? []
async function send(user: string, roomId: string, body: string): Promise<RoomMessage> {
  return await h.api(user).call(API.sendRoomMessage, { params: { id: roomId }, body: { body, clientMessageId: cm(), mentions: [], fileIds: [] } })
}
const newChat = async (user: string) => (await h.api(user).call(API.createChat, { body: {} })).id
/** one answer; each card is answered "skip" (the room card's no); its cards and the answer */
async function run(user: string, chatId: string, content: string) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Ask[] = []
  const end = Date.now() + 90_000
  for (;;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === x.data.request.requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as Ask
      cards.push(c)
      if (process.env.DEBUG_CARDS) console.log(JSON.stringify({ q: c.question, o: values(c) }))
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: values(c).includes('no') ? 'no' : 'skip' } })
      continue
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, done: done.data.message }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}
const roomRead = (room: string) => ({ tool: 'room_read', args: { room } })
const write = (file_path: string, content = 'made by the AI\n') => ({ tool: 'write', args: { file_path, content } })
/** a change of a file that is there: read first (as the write tool wants), then written */
const fix = (file_path: string, content: string) => [{ tool: 'read', args: { file_path } }, write(file_path, content)]
const labels = (done: { steps?: { tool?: string; label: string }[] }, tool: string) => (done.steps ?? []).filter((s) => s.tool === tool).map((s) => s.label)
const WHY = "Messages from your conversations (other people's words) came in here, so changes are asked first."
const OWN = 'saved without asking: your own folder'
/** a room with a planted message, and a fresh folder of alice's */
async function setup(name: string) {
  const roomId = await teamRoom()
  await send('erin', roomId, '사아자 베이커리는 볼펜 단가 5,500원으로 해주세요.')
  return { roomId, dir: `users/alice/${name}-${uuidv7().slice(-6)}` }
}
/** alice shares `rel` (a live row: a folder share or a file's link) with `subjects` (none: a link nobody is on yet) */
function share(rel: string, kind: 'folder' | 'file', subjects: string[] = ['erin']) {
  const db = h.ctx.db, id = newLinkId(), now = new Date().toISOString()
  db.query("INSERT INTO file_shares (id, path, ino, dev, owner_id, state, created_by, created_at, kind, folder_id) VALUES (?,?,0,0,'alice','live','alice',?,?,?)").run(id, rel, now, kind, kind === 'folder' ? '0:0:1' : null)
  for (const s of subjects) db.query("INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?,'user',?,'view','alice',?,'dialog')").run(id, s, now)
  return id
}

describe('FL-08: files this chat made in the person\'s own folder', () => {
  test('changed in a later answer after a room read: no card, the step says why', async () => {
    const { roomId, dir } = await setup('quote')
    const page = `${dir}/quote.md`, copy = `${dir}/quote (unstamped).docx`
    const chat = await newChat('alice')
    // the first answer (no room read yet): the page, and a document printed from it (make_file from a source)
    const first = await run('alice', chat, `make the quote\n${fake(write(page, '# Quote\n\npen 6,000\n'), { tool: 'make_file', args: { format: 'docx', source: page, output: copy }, sayResult: true }, { say: 'made' })}`)
    expect(first.cards).toHaveLength(0)
    expect(exists(copy)).toBe(true)
    expect(madeInChat(h.ctx.db, chat, 'alice', page)).toBe(true)
    expect(madeInChat(h.ctx.db, chat, 'alice', copy)).toBe(true)
    // the CEO's price in the room: read it, fix the page, print it again over the copy: no room card for either
    const again = await run('alice', chat, `fix it as the CEO said\n${fake(roomRead(roomId), ...fix(page, '# Quote\n\npen 5,500\n'), { tool: 'read', args: { file_path: copy } }, { tool: 'make_file', args: { format: 'docx', source: page, output: copy }, sayResult: true }, { say: 'fixed' })}`)
    expect(again.cards.map((c) => c.question)).toEqual([])
    expect(read(page)).toContain('5,500')
    expect(labels(again.done, 'write').some((l) => l.endsWith(OWN))).toBe(true)
    expect(labels(again.done, 'make_file').some((l) => l.endsWith(OWN))).toBe(true)
    // and once more in a third answer: still the chat's own files
    const third = await run('alice', chat, `once more\n${fake(...fix(page, '# Quote\n\npen 5,000\n'), { say: 'fixed' })}`)
    expect(third.cards).toHaveLength(0)
    expect(read(page)).toContain('5,000')
  })
})

describe('FL-08 rerun: a link nobody is on', () => {
  test('a chat-made file whose link was made (a room post linked it, a "let them view" button was offered) but given to nobody: still no card', async () => {
    const { roomId, dir } = await setup('linked')
    const pdf = `${dir}/quote.md`
    const chat = await newChat('alice')
    await run('alice', chat, `draft\n${fake(write(pdf, 'v1\n'), { say: 'ok' })}`)
    // a room post linking the file (post_to_room: a link only; attachments are copies), then the link row files/shares.ts
    // linkFor makes on first use (share-fixes.ts when it offers [볼 수 있게 하기]): no people on it
    await send('alice', roomId, `the draft: /files/view?path=${encodeURIComponent(pdf)}`)
    const link = fileSharesOf(h.ctx).linkFor('alice', pdf)
    // batch 5 review: none of it lets a room member open the file without a grant row (the room's link check and the
    // link page both go by the folder rules or a grant)
    expect(fileOpener(h.ctx, 'erin')(pdf)).toBe(false)
    expect(fileSharesOf(h.ctx).open('erin', link.id).kind).toBe('no_access')
    expect(sharedWithAnyoneAt(h.ctx.db, pdf.split('/'))).toBe(false)
    const r = await run('alice', chat, `fix\n${fake(roomRead(roomId), ...fix(pdf, 'v2\n'), { say: 'x' })}`)
    expect(r.cards.map((c) => c.question)).toEqual([])
    expect(read(pdf)).toBe('v2\n')
    // the [볼 수 있게 하기] tap (a grant row): erin opens it, and the next change asks again
    h.ctx.db.query("INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?,'user','erin','view','alice',?,'ai')").run(link.id, new Date().toISOString())
    expect(fileSharesOf(h.ctx).open('erin', link.id).kind).toBe('open')
    const after = await run('alice', chat, `again\n${fake(...fix(pdf, 'v3\n'), { say: 'x' })}`)
    expect(after.cards).toHaveLength(1)
    expect(read(pdf)).toBe('v2\n')
  })
})

describe('the guard still holds: a card each', () => {
  test('a personal subfolder shared with someone (a folder share), a file shared with someone (paused too)', async () => {
    const { roomId, dir } = await setup('shared')
    const a = `${dir}/sub/a.md`, b = `${dir}/b.md`
    const chat = await newChat('alice')
    await run('alice', chat, `draft\n${fake(write(a, 'a v1\n'), write(b, 'b v1\n'), { say: 'ok' })}`)
    expect(madeInChat(h.ctx.db, chat, 'alice', a)).toBe(true)
    share(`${dir}/sub`, 'folder', ['erin'])
    const fileShare = share(b, 'file', ['erin'])
    h.ctx.db.query('UPDATE file_shares SET paused_at = ? WHERE id = ?').run(new Date().toISOString(), fileShare)
    const r = await run('alice', chat, `fix\n${fake(roomRead(roomId), ...fix(a, 'PLANTED\n'), ...fix(b, 'PLANTED\n'), { say: 'x' })}`)
    expect(r.cards).toHaveLength(2)
    expect(r.cards[0]!.question).toContain(WHY)
    expect(read(a)).toBe('a v1\n')
    expect(read(b)).toBe('b v1\n')
  })

  test('a file this chat did not make: there before, made by another chat, changed by the person since', async () => {
    const { roomId, dir } = await setup('notmade')
    const before = `${dir}/before.md`, other = `${dir}/other.md`, touched = `${dir}/touched.md`
    put(before, 'mine v1\n')
    const elsewhere = await newChat('alice')
    await run('alice', elsewhere, `draft\n${fake(write(other, 'other v1\n'), { say: 'ok' })}`)
    const chat = await newChat('alice')
    await run('alice', chat, `draft\n${fake(write(touched, 'touched v1\n'), { say: 'ok' })}`)
    expect(madeInChat(h.ctx.db, chat, 'alice', touched)).toBe(true)
    // the person saves the file on the Files screen: theirs now
    // the person saves the file on the Files screen (team-files/service.ts records it with no turn): theirs now
    put(touched, 'person v2\n')
    h.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action, detail) VALUES (NULL, 'alice', ?, 'update', ?)").run(touched, JSON.stringify({ tool: 'file-screen' }))
    expect(madeInChat(h.ctx.db, chat, 'alice', before)).toBe(false)
    expect(madeInChat(h.ctx.db, chat, 'alice', other)).toBe(false)
    expect(madeInChat(h.ctx.db, chat, 'alice', touched)).toBe(false)
    const r = await run('alice', chat, `fix\n${fake(roomRead(roomId), ...fix(before, 'PLANTED\n'), ...fix(other, 'PLANTED\n'), ...fix(touched, 'PLANTED\n'), { say: 'x' })}`)
    expect(r.cards).toHaveLength(3)
    expect(read(before)).toBe('mine v1\n')
    expect(read(other)).toBe('other v1\n')
    expect(read(touched)).toBe('person v2\n')
  })

  test('a file this chat copied or renamed into place', async () => {
    const { roomId, dir } = await setup('moved')
    const orig = `${dir}/src/orig.md`, copied = `${dir}/dst/orig.md`, made = `${dir}/made.md`, renamed = `${dir}/renamed.md`
    put(orig, 'original\n')
    const chat = await newChat('alice')
    await run('alice', chat, `copy and rename\n${fake({ tool: 'copy_files', args: { paths: [orig], to_folder: `${dir}/dst` }, sayResult: true }, write(made, 'made v1\n'), { tool: 'rename_file', args: { path: made, new_name: 'renamed.md' }, sayResult: true }, { say: 'ok' })}`)
    expect(exists(copied)).toBe(true)
    expect(exists(renamed)).toBe(true)
    expect(madeInChat(h.ctx.db, chat, 'alice', copied)).toBe(false)
    expect(madeInChat(h.ctx.db, chat, 'alice', renamed)).toBe(false)
    const r = await run('alice', chat, `fix\n${fake(roomRead(roomId), ...fix(copied, 'PLANTED\n'), ...fix(renamed, 'PLANTED\n'), { say: 'x' })}`)
    expect(r.cards).toHaveLength(2)
    expect(read(copied)).toBe('original\n')
    expect(read(renamed)).toBe('made v1\n')
  })

  test('a skill or instruction file this chat made', async () => {
    const { roomId, dir } = await setup('skill')
    const tag = dir.split('-').at(-1)
    const skill = `users/alice/skills/own-${tag}/SKILL.md`, notes = `${dir}/CLAUDE.md`
    const chat = await newChat('alice')
    await run('alice', chat, `make\n${fake(write(skill, `---\nname: own-${tag}\ndescription: Own notes.\n---\nv1\n`), write(notes, 'v1\n'), { say: 'ok' })}`)
    expect(exists(skill)).toBe(true)
    const r = await run('alice', chat, `fix\n${fake(roomRead(roomId), ...fix(skill, `---\nname: own-${tag}\ndescription: Own notes.\n---\nPLANTED\n`), ...fix(notes, 'PLANTED\n'), { say: 'x' })}`)
    expect(r.cards).toHaveLength(2)
    expect(read(skill)).toContain('v1')
    expect(read(notes)).toBe('v1\n')
  })

  test('a file this chat made in a group folder', async () => {
    const { roomId } = await setup('group')
    const g = `groups/marketing/own-folder-${uuidv7().slice(-6)}/a.md`
    const chat = await newChat('alice')
    await run('alice', chat, `draft\n${fake(write(g, 'g v1\n'), { say: 'ok' })}`)
    expect(read(g)).toBe('g v1\n')
    const r = await run('alice', chat, `fix\n${fake(roomRead(roomId), ...fix(g, 'PLANTED\n'), { say: 'x' })}`)
    expect(r.cards).toHaveLength(1)
    expect(read(g)).toBe('g v1\n')
  })
  test('a room file saved over a draft this chat made (save_room_file: the room\'s bytes as they are)', async () => {
    const { roomId, dir } = await setup('roomfile')
    const draft = `${dir}/quote.txt`
    const src = path.join(h.dataDir, `upload-${uuidv7()}`)
    const bytes = new TextEncoder().encode('ROOM BYTES FROM ERIN\n')
    fs.writeFileSync(src, bytes)
    const f = await roomFilesOf(h.ctx).create('erin', roomId, 'evil.txt', src, crypto.createHash('sha256').update(bytes).digest('hex'))
    await h.api('erin').call(API.sendRoomMessage, { params: { id: roomId }, body: { body: 'save this over your quote', clientMessageId: cm(), mentions: [], fileIds: [f.id] } })
    const chat = await newChat('alice')
    // in the same answer (made here) and in a later one (made by this chat): a card each time
    const same = await run('alice', chat, `draft\n${fake(roomRead(roomId), write(draft, 'my quote v1\n'), { tool: 'save_room_file', args: { room: roomId, file: f.id, save_as: draft }, sayResult: true }, { say: 'ok' })}`)
    expect(same.cards).toHaveLength(1)
    expect(madeInChat(h.ctx.db, chat, 'alice', draft)).toBe(true)
    const r = await run('alice', chat, `fix\n${fake({ tool: 'read', args: { file_path: draft } }, { tool: 'save_room_file', args: { room: roomId, file: f.id, save_as: draft }, sayResult: true }, { say: 'x' })}`)
    expect(r.cards).toHaveLength(1)
    expect(read(draft)).toBe('my quote v1\n')
  })
})

// QA TC-4703: the PDF tools making a NEW file in the person's own folder after a room read (an explicit output, or the
// tool's own name next to the PDF) go without the room card, as write and make_file do; replacing a file the chat did
// not make, or saving outside the person's own folder, still asks
describe('PDF tools: a new output in the person\'s own folder (TC-4703)', () => {
  const pdf = () => makePagedPdf([['Quote'], ['Terms (seal)']])
  const seal = () => pngRgbaOf(40, 40, (x, y) => ((x - 19.5) ** 2 + (y - 19.5) ** 2 < 18 ** 2 ? [200, 0, 0, 255] : [0, 0, 0, 0]))
  async function pdfSetup(name: string) {
    const s = await setup(name)
    put(`${s.dir}/form.pdf`, pdf())
    put(`${s.dir}/b.pdf`, pdf())
    put(`${s.dir}/seal.png`, seal())
    return s
  }
  test('stamp_pdf, edit_pdf, merge_pdfs and split_pdf into new own-folder files: no card', async () => {
    const { roomId, dir } = await pdfSetup('pdfnew')
    const chat = await newChat('alice')
    const r = await run('alice', chat, `fill it\n${fake(roomRead(roomId),
      { tool: 'stamp_pdf', args: { file_path: `${dir}/form.pdf`, image: `${dir}/seal.png`, output: `${dir}/out/stamped.pdf` }, sayResult: true },
      { tool: 'stamp_pdf', args: { file_path: `${dir}/form.pdf`, image: `${dir}/seal.png` }, sayResult: true },
      { tool: 'edit_pdf', args: { file_path: `${dir}/form.pdf`, operations: [{ remove_pages: '2' }], output: `${dir}/out/one-page` }, sayResult: true },
      { tool: 'edit_pdf', args: { file_path: `${dir}/form.pdf`, operations: [{ remove_pages: '2' }] }, sayResult: true },
      { tool: 'merge_pdfs', args: { files: [`${dir}/form.pdf`, `${dir}/b.pdf`], output: `${dir}/out/both.pdf` }, sayResult: true },
      { tool: 'merge_pdfs', args: { files: [`${dir}/form.pdf`, `${dir}/b.pdf`] }, sayResult: true },
      { tool: 'split_pdf', args: { file_path: `${dir}/form.pdf`, every: 1 }, sayResult: true },
      { say: 'done' })}`)
    expect(r.cards.map((c) => c.question)).toEqual([])
    expect(exists(`${dir}/out/stamped.pdf`)).toBe(true)
    expect(exists(`${dir}/out/one-page.pdf`)).toBe(true)
    expect(exists(`${dir}/out/both.pdf`)).toBe(true)
    const names = fs.readdirSync(at(dir))
    // the tools' own names next to the PDF: a stamped copy, an edited copy, a merged one and two parts
    expect(names.filter((n) => n.startsWith('form (')).length).toBeGreaterThanOrEqual(5)
    expect(labels(r.done, 'stamp_pdf').every((l) => l.endsWith(OWN))).toBe(true)
  })
  test('still a card: replacing a PDF the chat did not make, an output over such a file, an output outside the own folder, a split into a group folder', async () => {
    const { roomId, dir } = await pdfSetup('pdfguard')
    put(`${dir}/old.pdf`, pdf())
    put(`${dir}/.hidden.pdf`, pdf())
    const g = `groups/marketing/own-pdf-${uuidv7().slice(-6)}`
    fs.mkdirSync(at(g), { recursive: true })
    const chat = await newChat('alice')
    const before = read(`${dir}/old.pdf`)
    const r = await run('alice', chat, `fill it\n${fake(roomRead(roomId),
      { tool: 'read', args: { file_path: `${dir}/form.pdf` } },
      { tool: 'edit_pdf', args: { file_path: `${dir}/form.pdf`, operations: [{ remove_pages: '2' }], replace: true }, sayResult: true },
      { tool: 'read', args: { file_path: `${dir}/old.pdf` } },
      { tool: 'stamp_pdf', args: { file_path: `${dir}/form.pdf`, image: `${dir}/seal.png`, output: `${dir}/old.pdf` }, sayResult: true },
      { tool: 'stamp_pdf', args: { file_path: `${dir}/form.pdf`, image: `${dir}/seal.png`, output: `${g}/stamped.pdf` }, sayResult: true },
      { tool: 'split_pdf', args: { file_path: `${dir}/form.pdf`, every: 1, output_folder: g }, sayResult: true },
      { tool: 'stamp_pdf', args: { file_path: `${dir}/.hidden.pdf`, image: `${dir}/seal.png` }, sayResult: true },
      { say: 'done' })}`)
    expect(r.cards).toHaveLength(5)
    expect(read(`${dir}/old.pdf`)).toBe(before)
    expect(exists(`${g}/stamped.pdf`)).toBe(false)
    expect(fs.readdirSync(at(g))).toEqual([])
  })
})
