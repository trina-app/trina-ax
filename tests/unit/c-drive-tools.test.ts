import { afterEach, beforeEach, expect, test } from 'bun:test'
import { makeCApp, type CApp } from '../lib/c-app'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { registerDriveTools } from '../../server/src/tools/drive'
import { toolRegistry } from '../../server/src/tools/registry'
import { readScope, widening } from '../../server/src/chat/read-scope'
import { FakeGoogleDrive, DRIVE_CONFIG } from '../lib/fake-google-drive'
import * as XLSX from 'xlsx'

let a: CApp, fake: FakeGoogleDrive, i = 0
beforeEach(async () => {
  a = await makeCApp('drive-tools-' + ++i); fake = new FakeGoogleDrive()
  const svc = googleDriveOf(a.ctx, { config: DRIVE_CONFIG, fetch: fake.fetch })
  a.ctx.db.query("INSERT INTO sessions(id,user_id,token_hash,client,created_at,last_seen_at,expires_at) VALUES('drive-session','alice','drive-session-hash','web',?,?,?)").run(new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString())
  const f = svc.authorize('alice', 'drive-session'); await svc.callback(fake.authorize(f.authorizationUrl), { userId: 'alice', sessionId: 'drive-session' }); svc.complete('alice', 'drive-session', f.flowId)
  registerDriveTools(a.ctx, toolRegistry(a.ctx.files))
})
afterEach(async () => { await a?.close() })
function call(name: string, input: unknown, user: 'alice' | 'bob' = 'alice') {
  const chat = a.chat(user), turn = a.turn(user, chat)
  return { chat, turn, result: toolRegistry(a.ctx.files).call(name, input, a.toolCtx(user, turn)) }
}
test('Drive read uses only own token and marks private read scope/taint', async () => {
  const c = call('drive_read', { fileId: 'alice-file' }), r = await c.result
  expect(r.isError).not.toBe(true); expect(r.text).toContain('Alice private content')
  expect(readScope(a.ctx.db, c.chat)).toEqual([{ type: 'user', id: 'alice' }])
  expect(widening(a.ctx.db, c.chat, ['shared'])?.narrower).toHaveLength(1)
  expect((a.ctx.db.query('SELECT session_tainted FROM chats WHERE id=?').get(c.chat) as any).session_tainted).toBe(1)
  const denied = await call('drive_read', { fileId: 'bob-file' }).result
  expect(denied.isError).toBe(true); expect(denied.text).not.toContain('CANARY')
  expect((await call('drive_read', { fileId: 'alice-file' }, 'bob').result).isError).toBe(true)
})
test('search/list include shared drive flags and bounded page results without raw q', async () => {
  const r = await call('drive_search', { query: "quarter's \\ plan", driveId: 'team-drive', pageSize: 2 }).result
  expect(r.isError).not.toBe(true); expect(r.text).toContain('incompleteSearch')
  const u = new URL(fake.calls.at(-1)!.url)
  expect(u.searchParams.get('supportsAllDrives')).toBe('true')
  expect(u.searchParams.get('includeItemsFromAllDrives')).toBe('true')
  expect(u.searchParams.get('corpora')).toBe('drive')
  expect(u.searchParams.get('q')).toContain("quarter\\'s \\\\ plan")
  expect((await call('drive_list', { q: 'owner=other' }).result).isError).toBe(true)
})
test('unbound turns, revoked downloads, redirects and shortcut loops are refused', async () => {
  expect((await toolRegistry(a.ctx.files).call('drive_read', { fileId: 'alice-file' }, a.toolCtx('alice'))).isError).toBe(true)
  fake.blobs.get('alice-file')!.canDownload = false
  expect((await call('drive_read', { fileId: 'alice-file' }).result).isError).toBe(true)
  fake.blobs.get('alice-file')!.canDownload = true
  fake.response = () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
  const r = await call('drive_read', { fileId: 'alice-file' }).result
  expect(r.isError).toBe(true); expect(fake.calls.some(c => c.url.startsWith('http:'))).toBe(false)
  fake.response = null
  fake.blobs.set('loop', { owner: 'alice', name: 'link', mime: 'application/vnd.google-apps.shortcut', target: 'loop', bytes: new Uint8Array() })
  expect((await call('drive_read', { fileId: 'loop' }).result).isError).toBe(true)
})
test('Google exports use existing text and all-sheet spreadsheet converters with output limits', async () => {
  fake.blobs.set('doc', { owner: 'alice', name: 'Google document', mime: 'application/vnd.google-apps.document', bytes: new TextEncoder().encode('A Google document body') })
  const doc = await call('drive_read', { fileId: 'doc', maxChars: 8 }).result
  expect(doc.isError).not.toBe(true); expect(doc.structured).toMatchObject({ text: 'A Google', truncated: true })
  expect(fake.calls.some(c => c.url.includes('/doc/export?mimeType=text%2Fplain'))).toBe(true)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['first tab']]), 'One')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['second tab']]), 'Two')
  fake.blobs.set('sheet', { owner: 'alice', name: 'Google sheet', mime: 'application/vnd.google-apps.spreadsheet', bytes: XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) })
  const sheet = await call('drive_read', { fileId: 'sheet' }).result
  expect(sheet.isError).not.toBe(true); expect(sheet.text).toContain('first tab'); expect(sheet.text).toContain('second tab')
  fake.blobs.set('uploaded-sheet', { ...fake.blobs.get('sheet')!, name: 'Quarterly report', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const uploaded = await call('drive_read', { fileId: 'uploaded-sheet' }).result
  expect(uploaded.isError).not.toBe(true); expect(uploaded.text).toContain('second tab')
  const zip = XLSX.CFB.utils.cfb_new()
  XLSX.CFB.utils.cfb_add(zip, 'Contents/section0.xml', Buffer.from('<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:t>회의록 본문</hp:t></hp:run></hp:p></hs:sec>'))
  fake.blobs.set('hangul', { owner: 'alice', name: '회의록.hwpx', mime: 'application/hwp+zip', bytes: new Uint8Array(XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' }) as Buffer) })
  expect((await call('drive_read', { fileId: 'hangul' }).result).text).toContain('회의록 본문')
})
test('disconnect during download and user disable cannot deliver content or private scope', async () => {
  let release!: () => void
  fake.delayRead = () => new Promise(resolve => { release = resolve })
  const c = call('drive_read', { fileId: 'alice-file' })
  await new Promise(r => setTimeout(r, 10))
  await googleDriveOf(a.ctx).disconnect('alice'); release()
  const result = await c.result
  expect(result.isError).toBe(true); expect(result.text).not.toContain('Alice private')
  expect(readScope(a.ctx.db, c.chat)).toBeNull()
  const calls = fake.calls.length
  const staleContext = a.toolCtx('alice', a.turn('alice', a.chat('alice')))
  a.ctx.db.query("UPDATE users SET status='disabled' WHERE id='alice'").run()
  expect((await toolRegistry(a.ctx.files).call('drive_search', { query: 'anything' }, staleContext)).isError).toBe(true)
  expect(fake.calls.length).toBe(calls)
})
test('transient provider errors retry only a bounded number and never leak provider bodies', async () => {
  let n = 0
  fake.response = () => ++n < 3 ? Response.json({ error: 'CANARY-error' }, { status: 503 }) : null
  expect((await call('drive_list', {}).result).isError).not.toBe(true)
  expect(n).toBe(3)
  n = 0; fake.response = () => { n++; return Response.json({ error: 'CANARY-error' }, { status: 429 }) }
  const failure = await call('drive_list', {}).result
  expect(failure.isError).toBe(true); expect(n).toBe(3); expect(failure.text).not.toContain('CANARY')
})
