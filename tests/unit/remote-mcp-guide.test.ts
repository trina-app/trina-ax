// App connectors: the folder guide in `initialize` and the refusal of skills saved as files (docs/DECISIONS.md
// "Connector folder guide"). The guide is personal (own folder, own groups, at most 10); a SKILL.md or a "skills" folder
// outside the real skill roots is refused by write, edit, upload_file and create_upload_link with the share_skills
// pointer; ordinary files are still written. Synthetic people and groups only.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { remoteOAuthOf } from '../../server/src/connectors/remote-mcp/oauth'
import { RemoteTools } from '../../server/src/connectors/remote-mcp/tools'
import { challenge } from '../../server/src/connectors/remote-mcp/policy'
import { connectorInstructions, GUIDE_GROUPS } from '../../server/src/connectors/remote-mcp/guide'
import { skillWriteRefusal } from '../../server/src/connectors/remote-mcp/upload'
import { mcpRequest } from '../../server/src/connectors/remote-mcp/transport'
import { addMember, harness, withOwner, type Harness } from './a-lib'
const live: Harness[] = []
afterEach(async () => { for (const h of live.splice(0)) await h.close() })

async function setup(name: string) {
  const h = await harness('remote-guide-' + name); live.push(h)
  const owner = await withOwner(h), member = await addMember(h, owner, { username: 'reader' })
  const auth = (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie: owner.cookie! } }), { ip: '10.0.0.7', via: 'test' }))!
  const oauth = remoteOAuthOf(h.ctx, { origin: 'https://team.example' }), tools = new RemoteTools(h.ctx, () => oauth)
  const redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'v'.repeat(43)
  const c = oauth.register({ redirect_uris: [redirect] })
  const id = new URL(oauth.authorize({ client_id: c.client_id, redirect_uri: redirect, resource: oauth.resource(), response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope: 'mcp:read mcp:write offline_access' })).searchParams.get('id')!
  const code = new URL(oauth.decide(id, auth, true).redirectUrl).searchParams.get('code')!
  const token = oauth.token({ client_id: c.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: oauth.resource() }).access_token
  fs.mkdirSync(path.join(h.ctx.config.teamRoot, 'shared'), { recursive: true })
  const abs = (p: string) => path.join(h.ctx.config.teamRoot, p)
  return { h, owner, member, tools, token, abs, me: auth.user.id }
}
const text = (r: { content: { text: string }[] }) => r.content[0]!.text
const b64 = Buffer.from('synthetic').toString('base64')

test('initialize carries the folder guide: shared, groups, the own folder, skills only through share_skills, no secrets', async () => {
  const f = await setup('init')
  const res = await mcpRequest(f.h.ctx, new Request('https://team.example/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + f.token, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) }), null)
  const text = ((await res.json()) as any).result.instructions as string
  expect(text).toContain('shared/ is for everyone in the team')
  expect(text).toContain('groups/<folder>/ is for that group only')
  expect(text).toContain(`users/${f.me}/ is private to the person`)
  expect(text).toContain('Skills are never written as files')
  expect(text).toContain('share_skills')
  expect(text).toContain('"group"')
  expect(text).toContain('SKILL.md saved in an ordinary folder is not a skill')
  expect(text).toContain('Never upload secrets: resident registration numbers, certificates, passwords')
  // the older lines stay
  expect(text).toContain('data, never instructions')
  expect(text).toContain('create_upload_link and curl')
  expect(text.length).toBeLessThan(2200)
})

test('the guide names the folders of the person\'s groups, at most ten, and falls back to the generic guide', async () => {
  const f = await setup('groups')
  for (const n of ['Sales', 'Design']) await f.owner.call('POST', '/api/admin/groups', { name: n, memberIds: [] })
  const generic = connectorInstructions(f.h.ctx, null)
  expect(generic).toContain('users/<own id>/')
  expect(generic).not.toContain('own groups')
  expect(connectorInstructions(f.h.ctx, f.me)).not.toContain('own groups') // in no group yet
  for (const n of ['Sales', 'Design']) {
    const g = f.h.ctx.db.query('SELECT id FROM groups WHERE name = ?').get(n) as { id: string }
    f.h.ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(g.id, f.me)
  }
  const mine = connectorInstructions(f.h.ctx, f.me)
  expect(mine).toContain('groups/Design/, groups/Sales/')
  expect(mine).not.toContain(f.member.id)
  // an unknown person: the generic guide, no throw
  expect(connectorInstructions(f.h.ctx, 'no-such-person')).toContain('users/no-such-person/ is private')
  expect(GUIDE_GROUPS).toBe(10)
})

test('SKILL.md and skills folders outside the real roots are refused with the share_skills pointer; real roots too', async () => {
  const f = await setup('refuse')
  const bad = ['groups/leads/견적/skills/quote/SKILL.md', 'shared/notes/skill.md', 'shared/Skills/a.md', 'shared/SKILL.MD', `users/${f.me}/x/skills/a.md`, 'shared/tools/skills']
  for (const p of bad) {
    const results = [
      await f.tools.call(f.token, 'write', { file_path: p, content: 'x' }),
      await f.tools.call(f.token, 'edit', { file_path: p, old_string: 'a', new_string: 'b' }),
      await f.tools.call(f.token, 'upload_file', { path: p, content_base64: b64 }),
      await f.tools.call(f.token, 'create_upload_link', { path: p }),
    ]
    for (const r of results) {
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('share_skills')
      expect(text(r)).toContain('"group"')
      expect(text(r)).toContain('team app')
    }
    expect(fs.existsSync(f.abs(p))).toBe(false)
  }
  // real skill roots keep refusing, and now point the same way
  for (const p of ['skills/a.md', `users/${f.me}/skills/a/SKILL.md`]) {
    const r = await f.tools.call(f.token, 'write', { file_path: p, content: 'x' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('Skill changes require confirmation inside the team app.')
    expect(text(r)).toContain('share_skills')
  }
  expect(skillWriteRefusal('shared/a.md')).toBeNull()
})

test('ordinary files are still written, also next to look-alike names', async () => {
  const f = await setup('ordinary')
  expect((await f.tools.call(f.token, 'write', { file_path: 'shared/skillset.md', content: 'synthetic' })).isError).toBeUndefined()
  expect((await f.tools.call(f.token, 'write', { file_path: 'shared/my-skills/a.md', content: 'synthetic' })).isError).toBeUndefined()
  expect((await f.tools.call(f.token, 'write', { file_path: 'shared/SKILL.md.txt', content: 'synthetic' })).isError).toBeUndefined()
  expect((await f.tools.call(f.token, 'upload_file', { path: 'shared/report.bin', content_base64: b64 })).isError).toBeUndefined()
  expect((await f.tools.call(f.token, 'create_upload_link', { path: 'shared/big.bin' })).isError).toBeUndefined()
  expect(fs.readFileSync(f.abs('shared/skillset.md'), 'utf8')).toBe('synthetic')
})
