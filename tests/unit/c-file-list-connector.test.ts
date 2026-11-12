// The file list through the remote connector (connectors/remote-mcp/tools.ts): its read and grep go through
// FileService.call like a chat engine's, and afterwards the connector checks every path the call read. A list is not
// on disk, so the call records the list's folder (same access) instead of the list itself; the connector's check then
// passes and the call answers (review of feat/file-list: it failed with "Tool unavailable" before).
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { RemoteOAuth } from '../../server/src/connectors/remote-mcp/oauth'
import { RemoteTools } from '../../server/src/connectors/remote-mcp/tools'
import { challenge } from '../../server/src/connectors/remote-mcp/policy'
import { fileListOf } from '../../server/src/file-list/service'
import { HEADER } from '../../server/src/file-list/view'
import { FakeReader } from '../lib/file-list-fake'
import { harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(120_000)
const live: Harness[] = []
afterEach(async () => { for (const h of live.splice(0)) await h.close() })
const redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'v'.repeat(43)
type Res = { content: { text: string }[]; isError?: boolean }

test('read and grep of a file list answer through the remote connector', async () => {
  const h = await harness('file-list-connector'); live.push(h)
  const owner = await withOwner(h)
  const team = h.ctx.files.fx.root
  fs.mkdirSync(path.join(team, 'shared', 'scans'), { recursive: true })
  fs.writeFileSync(path.join(team, 'shared', 'scans', 'temp.md'), '# Business registration certificate of Acme\n')
  const fl = fileListOf(h.ctx)
  const reader = new FakeReader()
  fl.useReader(() => ({ ok: true, reader }))
  expect(await fl.start('now')).toBe('done')

  const oauth = new RemoteOAuth(h.ctx.db, { origin: 'https://team.example' }), tools = new RemoteTools(h.ctx, () => oauth)
  const client = oauth.register({ redirect_uris: [redirect] })
  const auth = (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie: owner.cookie! } }), { ip: '10.0.0.7', via: 'test' }))!
  const id = new URL(oauth.authorize({ client_id: client.client_id, redirect_uri: redirect, resource: oauth.resource(), response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope: 'mcp:read' })).searchParams.get('id')!
  oauth.consent(id, auth)
  const code = new URL(oauth.decide(id, auth, true, {}).redirectUrl).searchParams.get('code')!
  const token = oauth.token({ client_id: client.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: oauth.resource() }).access_token
  const call = (name: string, args: unknown) => tools.call(token, name, args) as Promise<Res>

  const g = await call('grep', { pattern: 'registration', path: 'shared', output_mode: 'content' })
  expect(g.isError).toBeFalsy()
  expect(g.content[0]!.text).toMatch(/^shared\/_FILES\.md:\d+:shared\/scans\/temp\.md — /m)
  const r = await call('read', { file_path: 'shared/_FILES.md' })
  expect(r.isError).toBeFalsy()
  expect(r.content[0]!.text).toContain(HEADER)
  const l = await call('glob', { pattern: '**/_FILES.md' })
  expect(l.content[0]!.text).toContain('shared/_FILES.md')
})
