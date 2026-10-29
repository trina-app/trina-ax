// App connectors: create_upload_link + PUT /connector-uploads/<token> (one-time links for big files).
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { RemoteTools } from '../../server/src/connectors/remote-mcp/tools'
import { challenge, hash } from '../../server/src/connectors/remote-mcp/policy'
import { LINK_LIMITS, LINK_MS, linkUpload } from '../../server/src/connectors/remote-mcp/upload-link'
import { loggablePath } from '../../server/src/http/middleware'
import { addMember, harness, withOwner, type Harness } from './a-lib'
const live: Harness[] = []
const defaults = { ...LINK_LIMITS }
afterEach(async () => { Object.assign(LINK_LIMITS, defaults); for (const h of live.splice(0)) await h.close() })

async function setup(name: string, scope = 'mcp:read mcp:write offline_access', as: 'owner' | 'member' = 'owner') {
  const h = await harness('remote-link-' + name); live.push(h)
  const owner = await withOwner(h), member = await addMember(h, owner, { username: 'reader' })
  const cookie = as === 'owner' ? owner.cookie! : member.client.cookie!
  const auth = (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie } }), { ip: '10.0.0.7', via: 'test' }))!
  const oauth = new RemoteOAuth(h.ctx.db, { origin: 'https://team.example' }), tools = new RemoteTools(h.ctx, () => oauth)
  const redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'v'.repeat(43)
  const c = oauth.register({ redirect_uris: [redirect] })
  const id = new URL(oauth.authorize({ client_id: c.client_id, redirect_uri: redirect, resource: oauth.resource(), response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope })).searchParams.get('id')!
  const code = new URL(oauth.decide(id, auth, true).redirectUrl).searchParams.get('code')!
  const token = oauth.token({ client_id: c.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: oauth.resource() }).access_token
  fs.mkdirSync(path.join(h.ctx.config.teamRoot, 'shared'), { recursive: true })
  const link = async (args: Record<string, unknown>) => {
    const r = await tools.call(token, 'create_upload_link', args)
    return { r, body: r.isError ? null : JSON.parse(r.content[0]!.text) }
  }
  const put = (url: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
    linkUpload(h.ctx, new Request(url, { method: 'PUT', body, headers, duplex: 'half' } as RequestInit), url.split('/').pop()!, '10.0.0.7', oauth)
  const abs = (p: string) => path.join(h.ctx.config.teamRoot, p)
  const tmpFiles = () => { try { return fs.readdirSync(path.join(h.ctx.config.dataDir, 'uploads', 'tmp')) } catch { return [] } }
  return { h, auth, oauth, tools, token, member, link, put, abs, tmpFiles }
}
const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31 + 7) & 0xff))

test('create_upload_link is listed only with write scope and returns a one-time URL on the connector origin', async () => {
  const ro = await setup('scope', 'mcp:read')
  expect(ro.tools.list(ro.oauth.authenticate(ro.token)).map(t => t.name)).not.toContain('create_upload_link')
  const refused = await ro.tools.call(ro.token, 'create_upload_link', { path: 'shared/x.bin' })
  expect(refused.isError).toBe(true); expect(refused.content[0]!.text).toContain('no permission')
  const f = await setup('create'), t0 = f.oauth.now()
  f.oauth.now = () => t0
  const tool = f.tools.list(f.oauth.authenticate(f.token)).find(t => t.name === 'create_upload_link')!
  expect(tool.description).toContain('curl')
  expect(f.tools.list(f.oauth.authenticate(f.token)).find(t => t.name === 'upload_file')!.description).toContain('create_upload_link')
  const { body } = await f.link({ path: 'shared/movie.mp4', size: bytes.length })
  expect(body.url).toMatch(/^https:\/\/team\.example\/connector-uploads\/tax_up_[A-Za-z0-9_-]{43}$/)
  expect(body).toMatchObject({ method: 'PUT', path: 'shared/movie.mp4', overwrite: false, maxBytes: LINK_LIMITS.maxBytes })
  expect(body.command).toBe(`curl --fail-with-body -T "<local file>" "${body.url}"`)
  expect(Date.parse(body.expiresAt) - f.oauth.now()).toBe(LINK_MS)
  expect(LINK_LIMITS.maxBytes).toBe(50 * 1024 * 1024)
  // only the hash is stored
  const token = body.url.split('/').pop()
  const rows = f.h.ctx.db.query('SELECT * FROM remote_mcp_upload_links').all() as { hash: string }[]
  expect(rows.map(r => r.hash)).toEqual([hash(token)]); expect(JSON.stringify(rows)).not.toContain(token)
  // a declared size over the cap is refused now
  const big = await f.link({ path: 'shared/huge.bin', size: LINK_LIMITS.maxBytes + 1 })
  expect(big.r.isError).toBe(true); expect(big.r.content[0]!.text).toContain('too large')
  expect((await f.link({ path: 'skills/x.zip' })).r.isError).toBe(true)
  expect((await f.link({ path: 'shared/x.bin', extra: 1 })).r.isError).toBe(true)
})

test('create_upload_link is refused for a read-only folder', async () => {
  const m = await setup('readonly', undefined, 'member')
  fs.mkdirSync(m.abs('groups/readonly'), { recursive: true })
  m.h.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_link_ro', 'groups/readonly')").run()
  m.h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_link_ro', 'f_link_ro', 'everyone', NULL, 'read')").run()
  const { r } = await m.link({ path: 'groups/readonly/x.pdf' })
  expect(r.isError).toBe(true); expect(r.content[0]!.text).toContain('Access denied')
  expect(m.h.ctx.db.query('SELECT count(*) AS n FROM remote_mcp_upload_links').get()).toEqual({ n: 0 })
})

test('PUT saves the bytes intact, the file is listed, the link works once and the audit has no token', async () => {
  const f = await setup('put')
  const { body } = await f.link({ path: 'groups/media/clip.bin' })
  const res = await f.put(body.url, bytes, { 'content-length': String(bytes.length) })
  expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store')
  expect(await res.json()).toEqual({ path: 'groups/media/clip.bin', size: bytes.length, conflictCopy: false, replaced: false })
  expect(Buffer.compare(fs.readFileSync(f.abs('groups/media/clip.bin')), bytes)).toBe(0)
  expect((await f.tools.call(f.token, 'list', { path: 'groups/media' })).content[0]!.text).toContain('clip.bin')
  expect(f.tmpFiles()).toEqual([])
  // second PUT with the same link
  const again = await f.put(body.url, Buffer.from('second'))
  expect(again.status).toBe(404); expect(((await again.json()) as any).error).toBe('invalid_link')
  expect(Buffer.compare(fs.readFileSync(f.abs('groups/media/clip.bin')), bytes)).toBe(0)
  // malformed and unknown tokens
  expect((await f.put('https://team.example/connector-uploads/nope', Buffer.from('x'))).status).toBe(404)
  expect((await f.put('https://team.example/connector-uploads/tax_up_' + 'a'.repeat(43), Buffer.from('x'))).status).toBe(404)
  // audit: actor, path, size, via link; never the token or its hash
  const token = body.url.split('/').pop()
  const rows = f.h.ctx.db.query("SELECT actor_id, action, target, detail FROM audit_log WHERE action IN ('remote_mcp.upload','remote_mcp.tool')").all() as { actor_id: string; action: string; detail: string }[]
  const up = rows.find(r => r.action === 'remote_mcp.upload')!
  expect(up.actor_id).toBe(f.auth.user.id)
  expect(JSON.parse(up.detail)).toMatchObject({ via: 'connector_link', ok: true, path: 'groups/media/clip.bin', size: bytes.length })
  const made = rows.find(r => r.action === 'remote_mcp.tool' && JSON.parse(r.detail).tool === 'create_upload_link')!
  expect(JSON.parse(made.detail)).toMatchObject({ ok: true, path: 'groups/media/clip.bin' })
  const all = JSON.stringify(f.h.ctx.db.query('SELECT * FROM audit_log').all()) + JSON.stringify(f.h.ctx.db.query('SELECT * FROM file_events').all())
  expect(all).not.toContain(token); expect(all).not.toContain(hash(token))
  expect(loggablePath('/connector-uploads/' + token)).toBe('/connector-uploads/***')
})

test('PUT name clash makes a copy; overwrite keeps a version; a foreign Origin is refused', async () => {
  const f = await setup('clash')
  fs.writeFileSync(f.abs('shared/report.pdf'), 'original synthetic bytes')
  const copy = await f.link({ path: 'shared/report.pdf' })
  expect(await (await f.put(copy.body.url, bytes)).json()).toEqual({ path: 'shared/report (2).pdf', size: bytes.length, conflictCopy: true, replaced: false })
  expect(fs.readFileSync(f.abs('shared/report.pdf'), 'utf8')).toBe('original synthetic bytes')
  const over = await f.link({ path: 'shared/report.pdf', overwrite: true })
  expect((await f.put(over.body.url, bytes, { origin: 'https://evil.invalid' })).status).toBe(403)
  // a foreign page cannot use up the link: the Origin check runs before the token is consumed
  expect(await (await f.put(over.body.url, bytes)).json()).toEqual({ path: 'shared/report.pdf', size: bytes.length, conflictCopy: false, replaced: true })
  expect(Buffer.compare(fs.readFileSync(f.abs('shared/report.pdf')), bytes)).toBe(0)
  expect(f.h.ctx.db.query("SELECT size FROM file_versions WHERE path='shared/report.pdf'").all()).toEqual([{ size: 'original synthetic bytes'.length }])
})

test('an expired link is refused and purged', async () => {
  const f = await setup('expired')
  const { body } = await f.link({ path: 'shared/late.bin' })
  const start = f.oauth.now()
  f.oauth.now = () => start + LINK_MS + 1
  const res = await f.put(body.url, bytes)
  expect(res.status).toBe(404)
  expect(fs.existsSync(f.abs('shared/late.bin'))).toBe(false)
  expect(f.h.ctx.db.query('SELECT count(*) AS n FROM remote_mcp_upload_links').get()).toEqual({ n: 0 })
})

test('an oversize body is refused while it streams, without buffering it', async () => {
  const f = await setup('oversize')
  LINK_LIMITS.maxBytes = 4096
  const declared = await f.link({ path: 'shared/big.bin' })
  // Content-Length over the cap: refused before the body is read
  const quick = await f.put(declared.body.url, Buffer.alloc(5000), { 'content-length': '5000' })
  expect(quick.status).toBe(413)
  const { body } = await f.link({ path: 'shared/big.bin' })
  let pulls = 0
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls++; if (pulls > 1000) c.close(); else c.enqueue(new Uint8Array(1024)) } }, { highWaterMark: 0 })
  const res = await f.put(body.url, stream)
  expect(res.status).toBe(413); expect(((await res.json()) as any).error).toBe('too_large')
  expect(pulls).toBeLessThan(20)
  expect(fs.existsSync(f.abs('shared/big.bin'))).toBe(false)
  expect(f.tmpFiles()).toEqual([])
  const rows = f.h.ctx.db.query("SELECT detail FROM audit_log WHERE action='remote_mcp.upload'").all() as { detail: string }[]
  expect(rows.map(r => JSON.parse(r.detail))).toEqual([expect.objectContaining({ ok: false, reason: 'too_large' }), expect.objectContaining({ ok: false, reason: 'too_large' })])
})

test('a revoked connection or a narrowed scope makes the link useless', async () => {
  const f = await setup('revoked')
  const { body } = await f.link({ path: 'shared/a.bin' })
  f.oauth.revokeGrant(f.oauth.authenticate(f.token).id)
  const res = await f.put(body.url, bytes)
  expect(res.status).toBe(403); expect(((await res.json()) as any).error).toBe('access_denied')
  expect(fs.existsSync(f.abs('shared/a.bin'))).toBe(false)
  const g = await setup('narrowed')
  const second = await g.link({ path: 'shared/b.bin' })
  g.h.ctx.db.query('UPDATE remote_mcp_grants SET scopes=?').run(JSON.stringify(['mcp:read']))
  expect((await g.put(second.body.url, bytes)).status).toBe(403)
  expect(fs.existsSync(g.abs('shared/b.bin'))).toBe(false)
})

test('a connection revoked while the body streams is checked again before saving', async () => {
  const f = await setup('revoke-stream')
  const { body } = await f.link({ path: 'shared/slow.bin' })
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({ pull(c) {
    sent++
    if (sent === 2) f.oauth.revokeGrant(f.oauth.authenticate(f.token).id)
    if (sent > 3) c.close(); else c.enqueue(new Uint8Array(1024))
  } }, { highWaterMark: 0 })
  expect((await f.put(body.url, stream)).status).toBe(403)
  expect(fs.existsSync(f.abs('shared/slow.bin'))).toBe(false)
  expect(f.tmpFiles()).toEqual([])
})

test('write permission removed after the link was made is refused at upload time', async () => {
  const m = await setup('perm-removed', undefined, 'member')
  fs.mkdirSync(m.abs('groups/team'), { recursive: true })
  m.h.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_link_team', 'groups/team')").run()
  m.h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_link_team', 'f_link_team', 'everyone', NULL, 'write')").run()
  const { r, body } = await m.link({ path: 'groups/team/plan.pdf' })
  expect(r.isError).toBeUndefined()
  m.h.ctx.db.query("UPDATE folder_rules SET access='read' WHERE id='r_link_team'").run()
  const res = await m.put(body.url, bytes)
  expect(res.status).toBe(403)
  const out = (await res.json()) as any
  expect(out.error).toBe('refused'); expect(out.message).toContain('Access denied')
  expect(fs.existsSync(m.abs('groups/team/plan.pdf'))).toBe(false)
  const row = m.h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action='remote_mcp.upload'").get() as { actor_id: string; detail: string }
  expect(row.actor_id).toBe(m.member.id); expect(JSON.parse(row.detail)).toMatchObject({ ok: false, reason: 'refused', path: 'groups/team/plan.pdf' })
})

test('link creation is rate limited per connection and unused links are capped', async () => {
  const f = await setup('rate')
  LINK_LIMITS.perGrantPerMinute = 3
  for (let i = 0; i < 3; i++) expect((await f.link({ path: `shared/r${i}.bin` })).r.isError).toBeUndefined()
  const fourth = await f.link({ path: 'shared/r3.bin' })
  expect(fourth.r.isError).toBe(true); expect(fourth.r.content[0]!.text).toContain('Too many upload links')
  const g = await setup('open')
  LINK_LIMITS.openPerGrant = 2
  for (let i = 0; i < 2; i++) expect((await g.link({ path: `shared/o${i}.bin` })).r.isError).toBeUndefined()
  expect((await g.link({ path: 'shared/o2.bin' })).r.content[0]!.text).toContain('unused upload links')
})
