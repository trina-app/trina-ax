import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { RemoteTools } from '../../server/src/connectors/remote-mcp/tools'
import { challenge } from '../../server/src/connectors/remote-mcp/policy'
import { addMember, harness, withOwner, type Harness } from './a-lib'
const live: Harness[] = []
afterEach(async () => { for (const h of live.splice(0)) await h.close() })
async function setup(name: string, scope = 'mcp:read mcp:write offline_access', as: 'owner' | 'member' = 'owner') {
  const h = await harness('remote-tools-' + name); live.push(h)
  const owner = await withOwner(h), member = await addMember(h, owner, { username: 'reader' })
  const cookie = as === 'owner' ? owner.cookie! : member.client.cookie!
  const auth = (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie } }), { ip: '10.0.0.7', via: 'test' }))!
  const oauth = new RemoteOAuth(h.ctx.db, { origin: 'https://team.example' }), tools = new RemoteTools(h.ctx, () => oauth)
  const redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'v'.repeat(43)
  const c = oauth.register({ redirect_uris: [redirect] })
  const id = new URL(oauth.authorize({ client_id: c.client_id, redirect_uri: redirect, resource: oauth.resource(), response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope })).searchParams.get('id')!
  const code = new URL(oauth.decide(id, auth, true).redirectUrl).searchParams.get('code')!
  const token = oauth.token({ client_id: c.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: oauth.resource() }).access_token
  const mine = `users/${auth.user.id}/private.txt`, other = `users/${member.id}/private.txt`
  for (const p of [mine, other, 'shared/public.txt']) { fs.mkdirSync(path.dirname(path.join(h.ctx.config.teamRoot, p)), { recursive: true }); fs.writeFileSync(path.join(h.ctx.config.teamRoot, p), 'synthetic private contents') }
  return { h, auth, oauth, tools, token, mine, other, member }
}
test('only read scope tools are advertised; arbitrary tool families and writes are unavailable', async () => {
  const f = await setup('scopes', 'mcp:read')
  expect(f.tools.list(f.oauth.authenticate(f.token)).map(t => t.name)).toEqual(['list', 'glob', 'grep', 'read', 'skills_list'])
  expect((await f.tools.call(f.token, 'write', { file_path: 'shared/new.txt', content: 'x' })).isError).toBe(true)
  expect((await f.tools.call(f.token, 'web_fetch', { url: 'https://outside.invalid' })).isError).toBe(true)
  expect(fs.existsSync(path.join(f.h.ctx.config.teamRoot, 'shared/new.txt'))).toBe(false)
})
test('core policy denies other personal files, traversal and links; own read works', async () => {
  const f = await setup('policy')
  const own = await f.tools.call(f.token, 'read', { file_path: f.mine })
  expect(own.isError).toBeUndefined(); expect(own.content[0]!.text).toContain('synthetic private contents')
  for (const p of [f.other, '../outside.txt', '/etc/passwd']) expect((await f.tools.call(f.token, 'read', { file_path: p })).isError).toBe(true)
  fs.symlinkSync(path.join(f.h.ctx.config.teamRoot, f.mine), path.join(f.h.ctx.config.teamRoot, 'shared/link.txt'))
  fs.linkSync(path.join(f.h.ctx.config.teamRoot, f.mine), path.join(f.h.ctx.config.teamRoot, 'shared/hard.txt'))
  expect((await f.tools.call(f.token, 'read', { file_path: 'shared/link.txt' })).isError).toBe(true)
  expect((await f.tools.call(f.token, 'read', { file_path: 'shared/hard.txt' })).isError).toBe(true)
})
test('private read taints this grant across server restart; widening is refused, narrower save remains possible', async () => {
  const f = await setup('taint')
  await f.tools.call(f.token, 'read', { file_path: f.mine })
  const restarted = new RemoteTools(f.h.ctx, () => new RemoteOAuth(f.h.ctx.db, { origin: 'https://team.example' }))
  const wide = await restarted.call(f.token, 'write', { file_path: 'shared/leak.txt', content: 'synthetic private contents' })
  expect(wide.isError).toBe(true); expect(wide.content[0]!.text).toContain('more people')
  expect(fs.existsSync(path.join(f.h.ctx.config.teamRoot, 'shared/leak.txt'))).toBe(false)
  expect((await restarted.call(f.token, 'write', { file_path: `users/${f.auth.user.id}/copy.txt`, content: 'synthetic' })).isError).toBeUndefined()
})
test('read and write are serialized so an overlapping write sees the completed private read scope', async () => {
  const f = await setup('serialized'), original = f.h.ctx.files.call.bind(f.h.ctx.files)
  let started!: () => void, finish!: () => void
  const ready = new Promise<void>(r => { started = r }), wait = new Promise<void>(r => { finish = r })
  f.h.ctx.files.call = async (...args) => { if (args[0] === 'read') { started(); await wait }; return original(...args) }
  const read = f.tools.call(f.token, 'read', { file_path: f.mine }); await ready
  const write = f.tools.call(f.token, 'write', { file_path: 'shared/race.txt', content: 'synthetic' })
  finish(); await read
  expect((await write).isError).toBe(true)
  expect(fs.existsSync(path.join(f.h.ctx.config.teamRoot, 'shared/race.txt'))).toBe(false)
})
test('revocation during an async extraction prevents releasing its result', async () => {
  const f = await setup('revoked'), original = f.h.ctx.files.call.bind(f.h.ctx.files)
  f.h.ctx.files.call = async (...args) => { const r = await original(...args); f.oauth.disconnect(f.oauth.authenticate(f.token).id, f.auth); return r }
  await expect(f.tools.call(f.token, 'read', { file_path: f.mine })).rejects.toThrow('invalid_token')
})
test('permission changes during async read suppress output; next call uses the new permissions', async () => {
  const f = await setup('changed'), original = f.h.ctx.files.call.bind(f.h.ctx.files)
  f.h.ctx.files.call = async (...args) => { const r = await original(...args); f.h.ctx.db.query("UPDATE users SET role='member' WHERE id=?").run(f.auth.user.id); return r }
  const res = await f.tools.call(f.token, 'read', { file_path: f.mine })
  expect(res.isError).toBe(true); expect(res.content[0]!.text).not.toContain('synthetic private contents')
  f.h.ctx.files.call = original
  expect((await f.tools.call(f.token, 'read', { file_path: f.other })).isError).toBe(true)
})
test('MCP cannot approve a skill mutation and audit rows contain tool names only', async () => {
  const f = await setup('skill')
  const res = await f.tools.call(f.token, 'write', { file_path: 'skills/unconfirmed.md', content: 'malicious instruction' })
  expect(res.isError).toBe(true)
  const rows = JSON.stringify(f.h.ctx.db.query("SELECT detail FROM audit_log WHERE action='remote_mcp.tool'").all())
  expect(rows).not.toContain('malicious instruction'); expect(rows).not.toContain(f.token)
})

// ---------------- upload_file ----------------
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x00, 0x80, 0x7f])
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text)
test('upload_file saves binary bytes intact, creates folders and the file appears in list', async () => {
  const f = await setup('upload-ok')
  expect(f.tools.list(f.oauth.authenticate(f.token)).map(t => t.name)).toContain('upload_file')
  const res = await f.tools.call(f.token, 'upload_file', { path: 'groups/sales/report.pdf', content_base64: b64(bytes) })
  expect(res.isError).toBeUndefined()
  expect(body(res)).toEqual({ path: 'groups/sales/report.pdf', size: bytes.length, conflictCopy: false, replaced: false })
  expect(Buffer.compare(fs.readFileSync(path.join(f.h.ctx.config.teamRoot, 'groups/sales/report.pdf')), bytes)).toBe(0)
  expect((await f.tools.call(f.token, 'list', { path: 'groups/sales' })).content[0]!.text).toContain('report.pdf')
  // line breaks from a base64 tool are accepted
  const wrapped = b64(bytes).replace(/(.{4})/g, '$1\n')
  expect((await f.tools.call(f.token, 'upload_file', { path: 'groups/sales/wrapped.bin', content_base64: wrapped })).isError).toBeUndefined()
  // a macOS (NFD) name is saved in NFC and is not a clash
  const nfd = await f.tools.call(f.token, 'upload_file', { path: 'groups/sales/' + '보고서.pdf'.normalize('NFD'), content_base64: b64(bytes) })
  expect(body(nfd)).toMatchObject({ path: 'groups/sales/' + '보고서.pdf'.normalize('NFC'), conflictCopy: false })
  // no per-turn write budget on a long-lived connection
  f.h.ctx.files.cfg.maxWriteBytesPerTurn = 4
  for (const n of [1, 2]) expect((await f.tools.call(f.token, 'upload_file', { path: `groups/sales/budget-${n}.bin`, content_base64: b64(bytes) })).isError).toBeUndefined()
})
test('upload_file is hidden and refused without the write scope', async () => {
  const f = await setup('upload-scope', 'mcp:read')
  expect(f.tools.list(f.oauth.authenticate(f.token)).map(t => t.name)).not.toContain('upload_file')
  const res = await f.tools.call(f.token, 'upload_file', { path: 'shared/x.pdf', content_base64: b64(bytes) })
  expect(res.isError).toBe(true); expect(res.content[0]!.text).toContain('no permission')
  expect(fs.existsSync(path.join(f.h.ctx.config.teamRoot, 'shared/x.pdf'))).toBe(false)
})
test('upload_file is refused in folders without write permission', async () => {
  const f = await setup('upload-denied')
  expect((await f.tools.call(f.token, 'upload_file', { path: f.other.replace('private.txt', 'x.pdf'), content_base64: b64(bytes) })).isError).toBe(true)
  expect(fs.existsSync(path.join(f.h.ctx.config.teamRoot, f.other.replace('private.txt', 'x.pdf')))).toBe(false)
  const m = await setup('upload-denied-member', undefined, 'member')
  fs.mkdirSync(path.join(m.h.ctx.config.teamRoot, 'groups/readonly'), { recursive: true })
  m.h.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_upload_ro', 'groups/readonly')").run()
  m.h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_upload_ro', 'f_upload_ro', 'everyone', NULL, 'read')").run()
  const res = await m.tools.call(m.token, 'upload_file', { path: 'groups/readonly/x.pdf', content_base64: b64(bytes) })
  expect(res.isError).toBe(true); expect(res.content[0]!.text).toContain('Access denied')
  expect(fs.existsSync(path.join(m.h.ctx.config.teamRoot, 'groups/readonly/x.pdf'))).toBe(false)
  expect((await m.tools.call(m.token, 'upload_file', { path: `users/${m.member.id}/mine.pdf`, content_base64: b64(bytes) })).isError).toBeUndefined()
})
test('upload_file refuses too large and invalid base64 content', async () => {
  const f = await setup('upload-bad')
  const big = await f.tools.call(f.token, 'upload_file', { path: 'shared/big.bin', content_base64: b64(Buffer.alloc(20 * 1024 * 1024 + 1)) })
  expect(big.isError).toBe(true); expect(big.content[0]!.text).toContain('too large')
  for (const bad of ['abc$', 'abc', 'YWJj=YWJj', '****']) {
    const res = await f.tools.call(f.token, 'upload_file', { path: 'shared/bad.bin', content_base64: bad })
    expect(res.isError).toBe(true); expect(res.content[0]!.text).toContain('not valid base64')
  }
  expect((await f.tools.call(f.token, 'upload_file', { path: 'shared/bad.bin', content_base64: 1 })).isError).toBe(true)
  expect(fs.existsSync(path.join(f.h.ctx.config.teamRoot, 'shared/big.bin'))).toBe(false)
  expect(fs.existsSync(path.join(f.h.ctx.config.teamRoot, 'shared/bad.bin'))).toBe(false)
})
test('upload_file name clash saves a copy; overwrite keeps the old file as a version', async () => {
  const f = await setup('upload-clash'), abs = path.join(f.h.ctx.config.teamRoot, 'shared/report.pdf')
  fs.writeFileSync(abs, 'original synthetic bytes')
  const copy = await f.tools.call(f.token, 'upload_file', { path: 'shared/report.pdf', content_base64: b64(bytes) })
  expect(body(copy)).toEqual({ path: 'shared/report (2).pdf', size: bytes.length, conflictCopy: true, replaced: false })
  expect(fs.readFileSync(abs, 'utf8')).toBe('original synthetic bytes')
  expect(Buffer.compare(fs.readFileSync(path.join(f.h.ctx.config.teamRoot, 'shared/report (2).pdf')), bytes)).toBe(0)
  const over = await f.tools.call(f.token, 'upload_file', { path: 'shared/report.pdf', content_base64: b64(bytes), overwrite: true })
  expect(body(over)).toEqual({ path: 'shared/report.pdf', size: bytes.length, conflictCopy: false, replaced: true })
  expect(Buffer.compare(fs.readFileSync(abs), bytes)).toBe(0)
  expect(f.h.ctx.db.query("SELECT size FROM file_versions WHERE path='shared/report.pdf'").all()).toEqual([{ size: 'original synthetic bytes'.length }])
})
test('upload_file audit row has actor, path and size but no content; widening is refused', async () => {
  const f = await setup('upload-audit'), content = b64(Buffer.from('synthetic upload marker bytes'))
  expect((await f.tools.call(f.token, 'upload_file', { path: 'shared/audit.bin', content_base64: content })).isError).toBeUndefined()
  const rows = f.h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action='remote_mcp.tool'").all() as { actor_id: string; detail: string }[]
  const row = rows.find(r => JSON.parse(r.detail).tool === 'upload_file')!
  expect(row.actor_id).toBe(f.auth.user.id)
  expect(JSON.parse(row.detail)).toMatchObject({ tool: 'upload_file', ok: true, via: 'connector', path: 'shared/audit.bin', size: 29 })
  expect(JSON.stringify(rows)).not.toContain(content); expect(JSON.stringify(rows)).not.toContain(f.token)
  await f.tools.call(f.token, 'read', { file_path: f.mine })
  const wide = await f.tools.call(f.token, 'upload_file', { path: 'shared/leak.pdf', content_base64: b64(bytes) })
  expect(wide.isError).toBe(true); expect(wide.content[0]!.text).toContain('more people')
  expect(fs.existsSync(path.join(f.h.ctx.config.teamRoot, 'shared/leak.pdf'))).toBe(false)
  expect((await f.tools.call(f.token, 'upload_file', { path: 'skills/x.zip', content_base64: b64(bytes) })).isError).toBe(true)
})
