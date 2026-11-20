// App connectors: create_download_link + GET /connector-downloads/<token> (the mirror of the upload links), and read
// with raw: true (QA TC-5589..5591).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, expect, test } from 'bun:test'
import { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { RemoteTools } from '../../server/src/connectors/remote-mcp/tools'
import { challenge, hash } from '../../server/src/connectors/remote-mcp/policy'
import { DOWNLOAD_LIMITS, DOWNLOAD_MS, linkDownload } from '../../server/src/connectors/remote-mcp/download-link'
import { loggablePath } from '../../server/src/http/middleware'
import { addMember, harness, withOwner, type Harness } from './a-lib'
const live: Harness[] = []
const outside: string[] = []
const defaults = { ...DOWNLOAD_LIMITS }
afterEach(async () => {
  Object.assign(DOWNLOAD_LIMITS, defaults)
  for (const h of live.splice(0)) await h.close()
  for (const d of outside.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

async function setup(name: string, scope = 'mcp:read mcp:write offline_access', as: 'owner' | 'member' = 'member') {
  const h = await harness('remote-dl-' + name); live.push(h)
  const owner = await withOwner(h), member = await addMember(h, owner, { username: 'reader' })
  const cookie = as === 'owner' ? owner.cookie! : member.client.cookie!
  const auth = (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie } }), { ip: '10.0.0.7', via: 'test' }))!
  const oauth = new RemoteOAuth(h.ctx.db, { origin: 'https://team.example' }), tools = new RemoteTools(h.ctx, () => oauth)
  const redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'v'.repeat(43)
  const c = oauth.register({ redirect_uris: [redirect] })
  const id = new URL(oauth.authorize({ client_id: c.client_id, redirect_uri: redirect, resource: oauth.resource(), response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope })).searchParams.get('id')!
  const code = new URL(oauth.decide(id, auth, true).redirectUrl).searchParams.get('code')!
  const token = oauth.token({ client_id: c.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: oauth.resource() }).access_token
  const abs = (p: string) => path.join(h.ctx.config.teamRoot, p)
  const write = (p: string, body: string | Buffer) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), body) }
  fs.mkdirSync(abs('shared'), { recursive: true })
  const link = async (args: Record<string, unknown>) => {
    const r = await tools.call(token, 'create_download_link', args)
    return { r, text: r.content[0]!.text, body: r.isError ? null : JSON.parse(r.content[0]!.text) }
  }
  const get = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
    linkDownload(h.ctx, new Request(url, { method, headers }), url.split('/').pop()!, '10.0.0.7', {}, oauth)
  const rule = (folder: string, access: 'read' | 'write' | 'none') => {
    h.ctx.db.query('INSERT OR IGNORE INTO folders (id, path) VALUES (?, ?)').run('f_' + folder.replace(/\W/g, '_'), folder)
    const { id } = h.ctx.db.query('SELECT id FROM folders WHERE path = ?').get(folder) as { id: string }
    h.ctx.db.query("DELETE FROM folder_rules WHERE folder_id = ? AND subject_type = 'everyone'").run(id)
    h.ctx.db.query('UPDATE folders SET limited = ? WHERE id = ?').run(access === 'write' ? 0 : 1, id)
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'everyone', NULL, ?)").run('r_' + id, id, access)
  }
  const links = () => (h.ctx.db.query('SELECT count(*) AS n FROM remote_mcp_download_links').get() as { n: number }).n
  const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  return { h, auth, ownerId, member, oauth, tools, token, abs, write, link, get, rule, links }
}
const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31 + 7) & 0xff))
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')

test('create_download_link is listed with read scope only, read-only, and answers a URL on the connector origin', async () => {
  const ro = await setup('scope', 'mcp:read')
  const names = ro.tools.list(ro.oauth.authenticate(ro.token)).map(t => t.name)
  expect(names).toContain('create_download_link'); expect(names).not.toContain('create_upload_link')
  const tool = ro.tools.list(ro.oauth.authenticate(ro.token)).find(t => t.name === 'create_download_link')!
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
  expect(tool.description).toContain('curl -o')
  ro.write('shared/a.md', '# hi\n')
  const t0 = ro.oauth.now(); ro.oauth.now = () => t0
  const { body } = await ro.link({ path: 'shared/a.md' })
  expect(body.url).toMatch(/^https:\/\/team\.example\/connector-downloads\/tax_dl_[A-Za-z0-9_-]{43}$/)
  expect(body).toMatchObject({ method: 'GET', path: 'shared/a.md', size: 5, uses: DOWNLOAD_LIMITS.uses })
  expect(body.command).toBe(`curl --fail -o "<local file>" "${body.url}"`)
  expect(Date.parse(body.expiresAt) - t0).toBe(DOWNLOAD_MS)
  // only the hash is stored
  const token = body.url.split('/').pop()
  const rows = ro.h.ctx.db.query('SELECT * FROM remote_mcp_download_links').all() as { hash: string }[]
  expect(rows.map(r => r.hash)).toEqual([hash(token)]); expect(JSON.stringify(rows)).not.toContain(token)
  // bad input
  expect((await ro.link({ path: 'shared/a.md', extra: 1 })).r.isError).toBe(true)
  expect((await ro.link({})).r.isError).toBe(true)
  // the file joined this session's read scope, as a read does
  const scopes = ro.h.ctx.db.query('SELECT sources FROM remote_mcp_scopes').all() as { sources: string }[]
  expect(scopes.length).toBe(1); expect(JSON.parse(scopes[0]!.sources).length).toBe(1)
})

test('GET answers the exact bytes with type and file name, a Korean path with a space, at most N times, audited without the token', async () => {
  const f = await setup('get')
  const p = 'shared/공유/보고서 초안.md', text = '# 보고서 초안\n\n- 첫째 줄\n'
  f.write(p, text)
  const { body } = await f.link({ path: p })
  expect(body.path).toBe(p)
  const res = await f.get(body.url)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe(text)
  expect(res.headers.get('content-type')).toMatch(/^text\/markdown/)
  expect(res.headers.get('content-disposition')).toStartWith('attachment; filename="')
  expect(res.headers.get('content-disposition')).toEndWith(`; filename*=UTF-8''${encodeURIComponent('보고서 초안.md')}`)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  // a binary file, bigger: sha256 the same
  f.write('shared/pic.png', bytes)
  const bin = await f.link({ path: 'shared/pic.png' })
  for (let i = 0; i < DOWNLOAD_LIMITS.uses; i++) {
    const r = await f.get(bin.body.url)
    expect(r.status).toBe(200); expect(r.headers.get('content-type')).toBe('image/png')
    expect(sha(new Uint8Array(await r.arrayBuffer()))).toBe(sha(bytes))
  }
  // used up
  const used = await f.get(bin.body.url)
  expect(used.status).toBe(404); expect(((await used.json()) as any).error).toBe('invalid_link')
  // malformed and unknown tokens, another method
  expect((await f.get('https://team.example/connector-downloads/nope')).status).toBe(404)
  expect((await f.get('https://team.example/connector-downloads/tax_dl_' + 'a'.repeat(43))).status).toBe(404)
  expect((await f.get(body.url, {}, 'POST')).status).toBe(405)
  // audit: a row per GET, actor and path; never the token or its hash
  const token = body.url.split('/').pop()
  const rows = f.h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'remote_mcp.download'").all() as { actor_id: string; detail: string }[]
  expect(rows.length).toBe(1 + DOWNLOAD_LIMITS.uses)
  expect(rows[0]!.actor_id).toBe(f.auth.user.id)
  expect(JSON.parse(rows[0]!.detail)).toMatchObject({ via: 'connector_link', ok: true, path: p, size: Buffer.byteLength(text), use: 1 })
  const made = (f.h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'remote_mcp.tool'").all() as { detail: string }[]).map(r => JSON.parse(r.detail)).find(d => d.tool === 'create_download_link')
  expect(made).toMatchObject({ ok: true, path: p })
  const all = JSON.stringify(f.h.ctx.db.query('SELECT * FROM audit_log').all())
  expect(all).not.toContain(token); expect(all).not.toContain(hash(token))
  expect(loggablePath('/connector-downloads/' + token)).toBe('/connector-downloads/***')
})

test('a foreign Origin is refused before a use is taken; Range resumes a download', async () => {
  const f = await setup('origin')
  DOWNLOAD_LIMITS.uses = 1
  f.write('shared/big.bin', bytes)
  const { body } = await f.link({ path: 'shared/big.bin' })
  expect((await f.get(body.url, { origin: 'https://evil.invalid' })).status).toBe(403)
  const part = await f.get(body.url, { range: 'bytes=1000-1999' })
  expect(part.status).toBe(206)
  expect(Buffer.compare(Buffer.from(await part.arrayBuffer()), bytes.subarray(1000, 2000))).toBe(0)
})

test('a file the person may not read: refused at link time like a missing file; access lost later: 404', async () => {
  const f = await setup('access')
  f.write('groups/hr/salaries.md', 'synthetic')
  f.rule('groups/hr', 'none')
  const hidden = await f.link({ path: 'groups/hr/salaries.md' })
  const missing = await f.link({ path: 'groups/hr/nothing.md' })
  expect(hidden.r.isError).toBe(true)
  expect(hidden.text.replace('salaries', 'X')).toBe(missing.text.replace('nothing', 'X'))
  // the owner's personal folder
  f.write(`users/${f.ownerId}/notes.md`, 'synthetic')
  expect((await f.link({ path: `users/${f.ownerId}/notes.md` })).r.isError).toBe(true)
  expect(f.links()).toBe(0)
  // made while readable, then the folder is closed
  f.write('shared/team/plan.md', 'synthetic plan')
  const { body } = await f.link({ path: 'shared/team/plan.md' })
  f.rule('shared/team', 'none')
  const res = await f.get(body.url)
  expect(res.status).toBe(404); expect(await res.text()).not.toContain('synthetic')
  expect(JSON.parse((f.h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'remote_mcp.download'").get() as { detail: string }).detail)).toMatchObject({ ok: false, reason: 'access' })
})

test('a changed, replaced or deleted file: 404', async () => {
  const f = await setup('changed')
  f.write('shared/a.md', 'version one')
  const edited = await f.link({ path: 'shared/a.md' })
  const t = new Date(Date.now() + 5000)
  fs.writeFileSync(f.abs('shared/a.md'), 'version two'); fs.utimesSync(f.abs('shared/a.md'), t, t)
  expect((await f.get(edited.body.url)).status).toBe(404)
  // replaced by another file of the same size and time (a new inode)
  const swapped = await f.link({ path: 'shared/a.md' })
  const st = fs.statSync(f.abs('shared/a.md'))
  fs.writeFileSync(f.abs('shared/a.tmp'), 'version 2!!'); fs.utimesSync(f.abs('shared/a.tmp'), st.atime, st.mtime)
  fs.renameSync(f.abs('shared/a.tmp'), f.abs('shared/a.md'))
  expect((await f.get(swapped.body.url)).status).toBe(404)
  const gone = await f.link({ path: 'shared/a.md' })
  fs.rmSync(f.abs('shared/a.md'))
  expect((await f.get(gone.body.url)).status).toBe(404)
  const reasons = (f.h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'remote_mcp.download'").all() as { detail: string }[]).map(r => JSON.parse(r.detail).reason)
  expect(reasons).toEqual(['changed', 'changed', 'access'])
})

test('an expired link is refused and purged', async () => {
  const f = await setup('expired')
  f.write('shared/a.md', 'x')
  const { body } = await f.link({ path: 'shared/a.md' })
  const start = f.oauth.now()
  f.oauth.now = () => start + DOWNLOAD_MS + 1
  expect((await f.get(body.url)).status).toBe(404)
  // the housekeeping of the next connector call removes it
  await f.tools.call(f.token, 'list', { path: 'shared' }).catch(() => {})
  f.oauth.granted(f.oauth.authenticate(f.token))
  expect(f.links()).toBe(0)
})

test('a link of another person, a revoked connection or a link stored for another user: 404', async () => {
  const f = await setup('other')
  f.write('shared/a.md', 'synthetic')
  const { body } = await f.link({ path: 'shared/a.md' })
  // the stored row names another person than the grant's: refused
  f.h.ctx.db.query('UPDATE remote_mcp_download_links SET user_id = ?').run(f.ownerId)
  expect((await f.get(body.url)).status).toBe(404)
  const again = await f.link({ path: 'shared/a.md' })
  f.oauth.revokeGrant(f.oauth.authenticate(f.token).id)
  expect((await f.get(again.body.url)).status).toBe(404)
})

test('a symbolic link is never followed: refused at link time, and a file swapped for a link after: 404', async () => {
  const f = await setup('symlink')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-outside-')); outside.push(dir)
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside the team folder')
  fs.symlinkSync(path.join(dir, 'secret.txt'), f.abs('shared/link.txt'))
  fs.symlinkSync(dir, f.abs('shared/dirlink'))
  expect((await f.link({ path: 'shared/link.txt' })).r.isError).toBe(true)
  expect((await f.link({ path: 'shared/dirlink/secret.txt' })).r.isError).toBe(true)
  expect((await f.link({ path: '../' + path.basename(dir) + '/secret.txt' })).r.isError).toBe(true)
  expect(f.links()).toBe(0)
  f.write('shared/real.txt', 'outside the team folder'.replace('outside', 'inside!'))
  const { body } = await f.link({ path: 'shared/real.txt' })
  fs.rmSync(f.abs('shared/real.txt'))
  fs.symlinkSync(path.join(dir, 'secret.txt'), f.abs('shared/real.txt'))
  const res = await f.get(body.url)
  expect(res.status).toBe(404); expect(await res.text()).not.toContain('outside the team folder')
})

test('read with raw: true gives the exact text; converted, non-UTF-8, long files and extra arguments are refused', async () => {
  const f = await setup('raw')
  const text = '﻿<!doctype html>\r\n<p>한글 · tabs\there</p>\n\n'
  f.write('shared/page.html', text)
  const r = await f.tools.call(f.token, 'read', { file_path: 'shared/page.html', raw: true })
  expect(r.isError).toBeUndefined()
  expect(Buffer.compare(Buffer.from(r.content[0]!.text, 'utf8'), fs.readFileSync(f.abs('shared/page.html')))).toBe(0)
  // a whole read: write may follow
  const w = await f.tools.call(f.token, 'write', { file_path: 'shared/page.html', content: 'new' })
  expect(w.isError).toBeUndefined(); expect(fs.readFileSync(f.abs('shared/page.html'), 'utf8')).toBe('new')
  f.write('shared/long.md', 'x'.repeat(30_000))
  f.write('shared/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]))
  f.write('shared/doc.docx', 'not really a docx')
  for (const [p, want] of [['shared/long.md', 'too long for raw'], ['shared/latin1.txt', 'not plain UTF-8'], ['shared/doc.docx', 'converted to text']] as const) {
    const out = await f.tools.call(f.token, 'read', { file_path: p, raw: true })
    expect(out.isError).toBe(true); expect(out.content[0]!.text).toContain(want)
  }
  const extra = await f.tools.call(f.token, 'read', { file_path: 'shared/page.html', raw: true, offset: 2 })
  expect(extra.isError).toBe(true); expect(extra.content[0]!.text).toContain('leave out offset')
  // without raw: numbered lines, as before
  expect((await f.tools.call(f.token, 'read', { file_path: 'shared/page.html' })).content[0]!.text).toMatch(/^\s*1\t/)
})

test('the guide names the download loop', async () => {
  const { connectorInstructions } = await import('../../server/src/connectors/remote-mcp/guide')
  const f = await setup('guide')
  expect(connectorInstructions(f.h.ctx, f.auth.user.id)).toContain('create_download_link and curl -o, then create_upload_link (overwrite)')
})

test('a resumed download gets the whole rest of the file, never cut at 8 MiB (curl -C - would take a short 206 as the end)', async () => {
  const f = await setup('range-whole')
  const big = Buffer.alloc(9 * 1024 * 1024 + 123)
  for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 0xff
  f.write('shared/big.bin', big)
  const { body } = await f.link({ path: 'shared/big.bin' })
  const from = 1000
  const res = await f.get(body.url, { range: `bytes=${from}-` })
  expect(res.status).toBe(206)
  expect(res.headers.get('content-range')).toBe(`bytes ${from}-${big.length - 1}/${big.length}`)
  expect(res.headers.get('content-length')).toBe(String(big.length - from))
  const got = Buffer.from(await res.arrayBuffer())
  expect(got.length).toBe(big.length - from)
  expect(sha(got)).toBe(sha(big.subarray(from)))
})

test('conditional headers are ignored: always the bytes, never a 304 that uses up a GET', async () => {
  const f = await setup('conditional')
  f.write('shared/a.md', 'synthetic text')
  const { body } = await f.link({ path: 'shared/a.md' })
  const first = await f.get(body.url)
  const etag = first.headers.get('etag')!, modified = first.headers.get('last-modified')!
  expect(etag).toBeTruthy()
  const again = await f.get(body.url, { 'if-none-match': etag, 'if-modified-since': modified })
  expect(again.status).toBe(200); expect(await again.text()).toBe('synthetic text')
  // If-Range with another tag does not turn a Range into a whole file either
  const part = await f.get(body.url, { range: 'bytes=0-8', 'if-range': '"other"' })
  expect(part.status).toBe(206); expect(await part.text()).toBe('synthetic')
})

test('a Range past the end: 416 with Content-Range, audited, and the use is given back', async () => {
  const f = await setup('range-bad')
  f.write('shared/a.md', 'synthetic text')
  const { body } = await f.link({ path: 'shared/a.md' })
  const bad = await f.get(body.url, { range: 'bytes=999-' })
  expect(bad.status).toBe(416)
  expect(bad.headers.get('content-range')).toBe('bytes */14')
  expect(((await bad.json()) as any).error).toBe('range_not_satisfiable')
  const rows = (f.h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'remote_mcp.download'").all() as { detail: string }[]).map(r => JSON.parse(r.detail))
  expect(rows).toEqual([expect.objectContaining({ ok: false, reason: 'range' })])
  // every use is still there
  for (let i = 0; i < DOWNLOAD_LIMITS.uses; i++) expect((await f.get(body.url)).status).toBe(200)
  expect((await f.get(body.url)).status).toBe(404)
})
