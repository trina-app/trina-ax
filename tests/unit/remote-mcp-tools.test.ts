import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { RemoteTools } from '../../server/src/connectors/remote-mcp/tools'
import { challenge } from '../../server/src/connectors/remote-mcp/policy'
import { addMember, harness, withOwner, type Harness } from './a-lib'
const live: Harness[] = []
afterEach(async () => { for (const h of live.splice(0)) await h.close() })
async function setup(name: string, scope = 'mcp:read mcp:write offline_access') {
  const h = await harness('remote-tools-' + name); live.push(h)
  const owner = await withOwner(h), member = await addMember(h, owner, { username: 'reader' })
  const auth = (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie: owner.cookie! } }), { ip: '10.0.0.7', via: 'test' }))!
  const oauth = new RemoteOAuth(h.ctx.db, { origin: 'https://team.example' }), tools = new RemoteTools(h.ctx, () => oauth)
  const redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'v'.repeat(43)
  const c = oauth.register({ redirect_uris: [redirect] })
  const id = new URL(oauth.authorize({ client_id: c.client_id, redirect_uri: redirect, resource: oauth.resource(), response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope })).searchParams.get('id')!
  const code = new URL(oauth.decide(id, auth, true).redirectUrl).searchParams.get('code')!
  const token = oauth.token({ client_id: c.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: oauth.resource() }).access_token
  const mine = `users/${auth.user.id}/private.txt`, other = `users/${member.id}/private.txt`
  for (const p of [mine, other, 'shared/public.txt']) { fs.mkdirSync(path.dirname(path.join(h.ctx.config.teamRoot, p)), { recursive: true }); fs.writeFileSync(path.join(h.ctx.config.teamRoot, p), 'synthetic private contents') }
  return { h, auth, oauth, tools, token, mine, other }
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
