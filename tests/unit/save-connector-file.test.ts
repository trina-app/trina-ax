// save_connector_file (server/src/tools/save-connector-file.ts, docs/decisions/20261118-save-connector-file.md): the
// original bytes of a Gmail attachment and of a Google Drive file saved into the team folder through the normal save
// path. Before it a Word / Excel / Hangul attachment reached the AI only as text (no handle to save) and a Drive file
// could not be saved at all (QA TC-4927). Fake Google, a fake library and a fake Drive only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { makeCApp, PEOPLE, type CApp, type Person } from '../lib/c-app'
import { APP_CLIENT, FakeGoogle, FakeLibrary, sessionRow } from '../lib/fake-google-apps'
import { FakeGoogleDrive, DRIVE_CONFIG, membersMayConnect } from '../lib/fake-google-drive'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { googleAppsOf } from '../../server/src/integrations/google-apps/service'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { readScope } from '../../server/src/chat/read-scope'
import { dropChatMedia, dropUserMedia, MEDIA_TTL_MS } from '../../server/src/integrations/connections/media'
import { toolRegistry } from '../../server/src/tools/registry'
import { TurnFiles } from '../../server/src/files/service'
import type { ToolCtx } from '../../server/src/files/service'
import type { TurnTool, TurnToolContext } from '../../server/src/services'

setDefaultTimeout(60_000)

const xlsx = () => {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['item', 'price'], ['desk', 120]]), 'Quote')
  return Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}
const teamFile = (A: CApp, rel: string) => fs.readFileSync(path.join(A.team, ...rel.split('/')))
const teamHas = (A: CApp, rel: string) => fs.existsSync(path.join(A.team, ...rel.split('/')))
/** a chat turn's tool context: `widen` is the wider-audience card's answer (null: go ahead) */
const ctxOf = (A: CApp, user: Person, turnId: string, widen?: (target: string) => string | null): ToolCtx => ({
  ...A.toolCtx(user, turnId), ...(widen ? { confirmWidening: async (t: string) => widen(t) } : {}),
})

describe('Gmail attachments', () => {
  let A: CApp, lib: FakeLibrary, google: FakeGoogle
  beforeAll(async () => {
    lib = new FakeLibrary().start()
    process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL = lib.url
    A = await makeCApp('save-connector-gmail')
    ;(A.ctx.config as any).tunnel = { host: 'team.example.test' }
    google = new FakeGoogle(lib)
    const apps = googleAppsOf(A.ctx, { fetch: google.fetch })
    for (const p of PEOPLE) sessionRow(A.ctx.db, p)
    const r = await A.json('/api/admin/google-apps/gmail/client', { method: 'PUT', as: 'carol', headers: { 'content-type': 'application/json' }, body: JSON.stringify(APP_CLIENT) })
    expect(r.status).toBe(200)
    for (const who of ['alice', 'bob'] as const) {
      const f = await apps.authorize(who, `${who}-session`, 'gmail')
      expect(await apps.callback(google.authorize(f.authorizationUrl, who), { userId: who, sessionId: `${who}-session` })).toBe(true)
      expect((await apps.complete(who, `${who}-session`, 'gmail', f.flowId)).status).toBe('connected')
    }
  })
  afterAll(async () => { await A?.close(); lib?.stop(); delete process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL })

  /** read an attachment in a new chat turn of `user`: the AI's text and the handle it names */
  async function readAttachment(user: Person, fileName: string, bytes: Buffer) {
    lib.attachment = bytes as typeof lib.attachment
    const chat = A.chat(user), turnId = A.turn(user, chat)
    const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: false })
    const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles(), signal: new AbortController().signal } as unknown as TurnToolContext['files']
    const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale: 'en', signal: new AbortController().signal, files }
    const tool = built.tools.find((t) => t.name === 'my_gmail__get_gmail_attachment_content') as TurnTool
    const r = await tool.call({ message_id: 'm1', attachment_id: 'a1', file_name: fileName }, tc)
    const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    return { chat, turnId, text, handle: /save_connector_file with "(mcp-file:[A-Za-z0-9_-]+)"/.exec(text)?.[1] }
  }
  const save = (user: Person, turnId: string, args: unknown, widen?: (t: string) => string | null) => toolRegistry(A.ctx.files).call('save_connector_file', args, ctxOf(A, user, turnId, widen))

  test('an Excel attachment is read as text and kept: saved as the original .xlsx, byte for byte, in the person\'s downloads', async () => {
    const bytes = xlsx()
    const a = await readAttachment('alice', 'quote.xlsx', bytes)
    expect(a.text).toContain('desk')
    // before: only PDFs and pictures got a handle, an Excel file could be kept only by retyping its text
    expect(a.handle).toBeDefined()
    expect(a.text).not.toContain('write its text into a file')
    const r = await save('alice', a.turnId, { file: a.handle })
    expect(r.isError).not.toBe(true)
    expect(r.structured).toMatchObject({ path: 'users/alice/downloads/quote.xlsx', size: bytes.length })
    expect(teamFile(A, 'users/alice/downloads/quote.xlsx').equals(bytes)).toBe(true)
    // the same name again, not read in this turn: a copy next to it, the first one unchanged
    const again = await save('alice', a.turnId, { file: a.handle })
    expect(again.isError).not.toBe(true)
    expect(again.structured).toMatchObject({ conflictCopyOf: 'users/alice/downloads/quote.xlsx' })
    expect(teamFile(A, 'users/alice/downloads/quote.xlsx').equals(bytes)).toBe(true)
  })

  test('a Hangul or Word attachment and one that cannot be read are kept too; a folder save keeps the file\'s own name', async () => {
    const docx = Buffer.from('PK\u0003\u0004[Content_Types].xml the person\'s own Word bytes')
    const a = await readAttachment('alice', '계약서.docx', docx)
    expect(a.handle).toBeDefined()
    const r = await save('alice', a.turnId, { file: a.handle, save_as: 'shared/contracts/' }, () => null)
    expect(r.isError).not.toBe(true)
    expect(r.structured).toMatchObject({ path: 'shared/contracts/계약서.docx' })
    expect(teamFile(A, 'shared/contracts/계약서.docx').equals(docx)).toBe(true)
    const odd = await readAttachment('alice', 'tool.bin', Buffer.from([1, 2, 3, 4, 5]))
    expect(odd.text).toContain('cannot be read here')
    expect(odd.handle).toBeDefined()
  })

  test('a handle opens only in its own chat and only for its person', async () => {
    const a = await readAttachment('alice', 'quote.xlsx', xlsx())
    const otherChat = A.turn('alice', A.chat('alice'))
    const elsewhere = await save('alice', otherChat, { file: a.handle })
    expect(elsewhere.isError).toBe(true)
    expect(elsewhere.text).toContain('only in the chat')
    const bobs = await save('bob', A.turn('bob', A.chat('bob')), { file: a.handle })
    expect(bobs.isError).toBe(true)
    // no turn at all
    expect((await toolRegistry(A.ctx.files).call('save_connector_file', { file: a.handle }, A.toolCtx('alice'))).isError).toBe(true)
  })

  test('the normal save rules: no skills folder or instruction file, the wider-audience card decides, outside a chat only the own folder', async () => {
    const a = await readAttachment('alice', 'quote.xlsx', xlsx())
    const skills = await save('alice', a.turnId, { file: a.handle, save_as: 'skills/quote.xlsx' }, () => null)
    expect(skills.isError).toBe(true)
    expect(skills.text).toContain('skills folder')
    const instr = await save('alice', a.turnId, { file: a.handle, save_as: 'shared/CLAUDE.md' }, () => null)
    expect(instr.isError).toBe(true)
    expect(teamHas(A, 'shared/CLAUDE.md')).toBe(false)
    // the card says no: nothing written
    const asked: string[] = []
    const no = await save('alice', a.turnId, { file: a.handle, save_as: 'shared/quote-no.xlsx' }, (t) => { asked.push(t); return 'the user did not allow it' })
    expect(no.isError).toBe(true)
    expect(asked).toEqual(['shared/quote-no.xlsx'])
    expect(teamHas(A, 'shared/quote-no.xlsx')).toBe(false)
    // no card to ask (no chat turn's check): only the person's own folder
    const unasked = await save('alice', a.turnId, { file: a.handle, save_as: 'shared/quote-unasked.xlsx' })
    expect(unasked.isError).toBe(true)
    expect(teamHas(A, 'shared/quote-unasked.xlsx')).toBe(false)
  })

  test('the name the AI gave is cleaned and checked against the bytes: no instruction file, no "..", no direction marks, no programs', async () => {
    const plain = Buffer.from('plain words, not an archive')
    const claude = await readAttachment('alice', 'CLAUDE.md', plain)
    const c = await save('alice', claude.turnId, { file: claude.handle })
    expect(c.isError).toBe(true)
    expect(c.text).toContain('instruction file')
    expect(teamHas(A, 'users/alice/downloads/CLAUDE.md')).toBe(false)
    const dots = await readAttachment('alice', '..', plain)
    const d = await save('alice', dots.turnId, { file: dots.handle })
    expect(d.isError).not.toBe(true)
    expect(String(d.structured!.path)).toMatch(/^users\/alice\/downloads\/file-[0-9a-f]{6}$/)
    const bidi = await readAttachment('alice', 'invoice\u202Efdp.txt', plain)
    const b = await save('alice', bidi.turnId, { file: bidi.handle })
    expect(b.structured).toMatchObject({ path: 'users/alice/downloads/invoicefdp.txt' })
    // a program named like a PDF is not saved; a PDF named like a text file gets .pdf
    const exe = await readAttachment('alice', 'scan.pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]))
    const e = await save('alice', exe.turnId, { file: exe.handle })
    expect(e.isError).toBe(true)
    expect(e.text).toContain('program')
    const pdf = await readAttachment('alice', 'notes.txt', Buffer.from('%PDF-1.4\n%fake but starts like one\n'))
    expect((await save('alice', pdf.turnId, { file: pdf.handle })).structured).toMatchObject({ path: 'users/alice/downloads/notes.pdf' })
    // a ZIP that is no Office file is saved as .zip, whatever the name says
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('payload/run.sh not office'), Buffer.alloc(40)])
    const z = await readAttachment('alice', 'quote.xlsx', zip)
    expect((await save('alice', z.turnId, { file: z.handle })).structured).toMatchObject({ path: 'users/alice/downloads/quote.zip' })
  })

  test('a folder the person cannot write is refused before anything is read; a connection that is gone or no longer theirs takes its files with it', async () => {
    const a = await readAttachment('alice', 'quote.xlsx', xlsx())
    const asked: string[] = []
    const ro = await save('alice', a.turnId, { file: a.handle, save_as: 'users/bob/' }, (t) => { asked.push(t); return null })
    expect(ro.isError).toBe(true)
    expect(asked).toEqual([])
    const gmail = (A.ctx.db.query("SELECT id FROM integrations WHERE owner_user_id='alice' AND google_app='gmail'").get() as { id: string }).id
    A.ctx.db.query("UPDATE integrations SET owner_user_id='carol' WHERE id=?").run(gmail)
    try {
      const gone = await save('alice', a.turnId, { file: a.handle })
      expect(gone.isError).toBe(true)
      expect(gone.text).toContain('may no longer use it')
    } finally { A.ctx.db.query("UPDATE integrations SET owner_user_id='alice' WHERE id=?").run(gmail) }
  })

  test('the save records the connection again before the wider-audience card', async () => {
    const a = await readAttachment('alice', 'quote.xlsx', xlsx())
    // the read record emptied (as if it were another chat's state): the save puts the connection back before asking
    A.ctx.db.query('UPDATE chats SET session_read_scope=NULL WHERE id=?').run(a.chat)
    let seen: unknown = null
    const r = await save('alice', a.turnId, { file: a.handle, save_as: 'shared/quote-card.xlsx' }, () => { seen = readScope(A.ctx.db, a.chat); return null })
    expect(r.isError).not.toBe(true)
    expect(seen).toEqual(expect.arrayContaining([{ type: 'user', id: 'alice', via: 'connection' }]))
  })

  test('kept files expire after 24 hours, and go with the chat or the account', async () => {
    const a = await readAttachment('alice', 'quote.xlsx', xlsx())
    const id = a.handle!.slice('mcp-file:'.length)
    const meta = path.join(A.data, 'connection-media', a.chat, `${id}.json`)
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'))
    fs.writeFileSync(meta, JSON.stringify({ ...m, createdAt: Date.now() - MEDIA_TTL_MS - 1000 }))
    const old = await save('alice', a.turnId, { file: a.handle })
    expect(old.isError).toBe(true)
    expect(old.text).toContain('24 hours')
    const b = await readAttachment('alice', 'quote.xlsx', xlsx())
    expect(dropChatMedia(A.data, b.chat)).toBe(1)
    expect(fs.existsSync(path.join(A.data, 'connection-media', b.chat))).toBe(false)
    const c1 = await readAttachment('alice', 'one.xlsx', xlsx()), c2 = await readAttachment('bob', 'two.xlsx', xlsx())
    expect(dropUserMedia(A.data, 'alice')).toBeGreaterThanOrEqual(1)
    expect((await save('alice', c1.turnId, { file: c1.handle })).isError).toBe(true)
    expect((await save('bob', c2.turnId, { file: c2.handle })).isError).not.toBe(true)
  })

  test('in a chat shared with people: the asker saves their attachment, another member cannot use the asker\'s handle', async () => {
    const a = await readAttachment('alice', 'quote.xlsx', xlsx())
    A.ctx.db.query("UPDATE chats SET people_shared_at=datetime('now') WHERE id=?").run(a.chat)
    A.ctx.db.query("INSERT INTO chat_audience (chat_id, subject_type, subject_id, added_by, added_at) VALUES (?, 'user', 'bob', 'alice', datetime('now'))").run(a.chat)
    const bobTurn = A.turn('bob', a.chat)
    const bob = await save('bob', bobTurn, { file: a.handle, save_as: 'shared/' }, () => null)
    expect(bob.isError).toBe(true)
    expect(bob.text).toContain('only in the chat')
    const mine = await save('alice', A.turn('alice', a.chat), { file: a.handle, save_as: 'shared/shared-quote.xlsx' }, () => null)
    expect(mine.isError).not.toBe(true)
    expect(teamHas(A, 'shared/shared-quote.xlsx')).toBe(true)
  })

  test('the 18 MB cap stays: a larger attachment is not read and gets no handle', async () => {
    const a = await readAttachment('alice', 'big.xlsx', Buffer.alloc(Math.round(18.5 * 1024 * 1024), 7))
    expect(a.text).toContain('larger than about 18 MB')
    expect(a.handle).toBeUndefined()
  })
})

describe('Google Drive files', () => {
  let A: CApp, fake: FakeGoogleDrive, i = 0
  beforeEach(async () => {
    A = await makeCApp('save-connector-drive-' + ++i); fake = new FakeGoogleDrive()
    const svc = googleDriveOf(A.ctx, { config: DRIVE_CONFIG, fetch: fake.fetch }); membersMayConnect(A.ctx.db)
    A.ctx.db.query("INSERT INTO sessions(id,user_id,token_hash,client,created_at,last_seen_at,expires_at) VALUES('drive-session','alice','drive-session-hash','web',?,?,?)").run(new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString())
    const f = svc.authorize('alice', 'drive-session'); await svc.callback(fake.authorize(f.authorizationUrl), { userId: 'alice', sessionId: 'drive-session' }); svc.complete('alice', 'drive-session', f.flowId)
  })
  afterEach(async () => { await A?.close() })
  const save = (args: unknown, user: Person = 'alice', widen?: (t: string) => string | null) => {
    const chat = A.chat(user), turn = A.turn(user, chat)
    return { chat, result: toolRegistry(A.ctx.files).call('save_connector_file', args, ctxOf(A, user, turn, widen)) }
  }

  test('a Drive file is saved as it is; what the chat read records the Drive', async () => {
    const bytes = xlsx()
    fake.blobs.set('sheet-file', { owner: 'alice', name: 'Budget 2026.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: new Uint8Array(bytes) })
    const s = save({ file: 'drive:sheet-file' }), r = await s.result
    expect(r.isError).not.toBe(true)
    expect(r.structured).toMatchObject({ path: 'users/alice/downloads/Budget 2026.xlsx', size: bytes.length })
    expect(teamFile(A, 'users/alice/downloads/Budget 2026.xlsx').equals(bytes)).toBe(true)
    expect(readScope(A.ctx.db, s.chat)).toEqual([{ type: 'user', id: 'alice', via: 'connection' }])
  })

  test('a Google document is saved as .docx (exported as Word, not as text)', async () => {
    fake.blobs.set('gdoc', { owner: 'alice', name: 'Meeting notes', mime: 'application/vnd.google-apps.document', bytes: new TextEncoder().encode('exported word bytes') })
    const r = await save({ file: 'drive:gdoc', save_as: 'users/alice/notes/' }).result
    expect(r.isError).not.toBe(true)
    expect(r.structured).toMatchObject({ path: 'users/alice/notes/Meeting notes.docx' })
    expect(fake.calls.some((c) => c.url.includes('/gdoc/export?mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document'))).toBe(true)
  })

  test('what the connection may do stays: another person\'s file, a file that may not be downloaded and a shared chat are refused, nothing written', async () => {
    expect((await save({ file: 'drive:bob-file' }).result).isError).toBe(true)
    fake.blobs.get('alice-file')!.canDownload = false
    expect((await save({ file: 'drive:alice-file' }).result).isError).toBe(true)
    fake.blobs.get('alice-file')!.canDownload = true
    // bob has no Drive of his own
    expect((await save({ file: 'drive:alice-file' }, 'bob').result).isError).toBe(true)
    // a chat shared with people: only behind the asker's Drive notice (ToolCtx.sharedService, docs/decisions/
    // 20261126-shared-chat-everything.md); a call without it, or a no on it, writes nothing
    const chat = A.chat('alice'), turn = A.turn('alice', chat)
    A.ctx.db.query("UPDATE chats SET people_shared_at=datetime('now') WHERE id=?").run(chat)
    const shared = await toolRegistry(A.ctx.files).call('save_connector_file', { file: 'drive:alice-file' }, ctxOf(A, 'alice', turn, () => null))
    expect(shared.isError).toBe(true)
    const declined = await toolRegistry(A.ctx.files).call('save_connector_file', { file: 'drive:alice-file' }, { ...ctxOf(A, 'alice', turn, () => null), sharedService: async () => 'Nothing was fetched from Google Drive.' })
    expect(declined.isError).toBe(true)
    expect(declined.text).toContain('Nothing was fetched from Google Drive')
    expect(fs.existsSync(path.join(A.team, 'users', 'alice', 'downloads'))).toBe(false)
  })

  test('an export over 10 MB, and a download over 32 MB that declares no size, are refused', async () => {
    fake.blobs.set('big-doc', { owner: 'alice', name: 'Big doc', mime: 'application/vnd.google-apps.document', bytes: new Uint8Array(11 * 1024 * 1024) })
    // Google gives no size for its own formats: the export stream is cut at 10 MB
    fake.response = (url) => url.pathname.endsWith('/big-doc') && !url.searchParams.get('alt') ? Response.json({ id: 'big-doc', name: 'Big doc', mimeType: 'application/vnd.google-apps.document', capabilities: { canDownload: true } }) : null
    expect((await save({ file: 'drive:big-doc' }).result).isError).toBe(true)
    fake.blobs.set('big-bin', { owner: 'alice', name: 'big.bin', mime: 'application/octet-stream', bytes: new Uint8Array(33 * 1024 * 1024) })
    fake.response = (url) => url.pathname.endsWith('/big-bin') && !url.searchParams.get('alt') ? Response.json({ id: 'big-bin', name: 'big.bin', mimeType: 'application/octet-stream', capabilities: { canDownload: true } }) : null
    expect((await save({ file: 'drive:big-bin' }).result).isError).toBe(true)
    fake.response = null
    expect(fs.existsSync(path.join(A.team, 'users', 'alice', 'downloads'))).toBe(false)
  })

  test('the 32 MB cap stays', async () => {
    fake.blobs.set('huge', { owner: 'alice', name: 'huge.zip', mime: 'application/zip', bytes: new Uint8Array(33 * 1024 * 1024) })
    const r = await save({ file: 'drive:huge' }).result
    expect(r.isError).toBe(true)
  })
})

describe('a file in another connection\'s answer', () => {
  let A: CApp, fake: FakeServices
  const quote = xlsx()
  beforeAll(async () => {
    A = await makeCApp('save-connector-mcp')
    fake = new FakeServices()
    fake.tools = [{ name: 'export_quote', description: 'Export the quote', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]
    fake.results = { export_quote: { content: [{ type: 'resource', resource: { uri: 'file:///exports/Quote%20Q4.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', blob: quote.toString('base64') } }] } }
    integrationsOf(A.ctx, { net: fake.net() })
    const c = await A.json('/api/integrations', { method: 'POST', as: 'alice', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'mcp', name: 'Quotes', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY }) })
    expect(c.body.status).toBe('connected')
  })
  afterAll(async () => { fake?.stop(); await A?.close() })

  test('an Office file save_url refuses is saved as it is, named by its address', async () => {
    const chat = A.chat('alice'), turnId = A.turn('alice', chat)
    const built = integrationToolProvider(A.ctx).build({ userId: 'alice', chatId: chat, turnId, browser: false, scheduled: false })
    const files = { user: A.ctx.files.principal('alice'), turnId, files: new TurnFiles() } as TurnToolContext['files']
    const tc: TurnToolContext = { turnId, chatId: chat, userId: 'alice', messageId: 'm', locale: 'en', signal: new AbortController().signal, files }
    const r = await (built.tools.find((t) => t.name === 'my_quotes__export_quote') as TurnTool).call({}, tc)
    const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    expect(text).toContain('save_connector_file')
    const handle = /(mcp-file:[A-Za-z0-9_-]{22})/.exec(text)![1]
    const saved = await toolRegistry(A.ctx.files).call('save_connector_file', { file: handle }, ctxOf(A, 'alice', turnId))
    expect(saved.isError).not.toBe(true)
    expect(saved.structured).toMatchObject({ path: 'users/alice/downloads/Quote Q4.xlsx' })
    expect(teamFile(A, 'users/alice/downloads/Quote Q4.xlsx').equals(quote)).toBe(true)
  })
})
