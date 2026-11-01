// What a connection's answer brings for save_url (integrations/connections/tools.ts, media.ts, tools/connection-urls.ts):
// inline images kept as mcp-file handles (never as text for the AI), answers up to 25 MB for tools/call (1 MB stays the
// limit elsewhere), addresses in the answer and resource links remembered as learned links, an echo of what the AI sent
// remembered as one. The image service is a synthetic Higgsfield-like fixture (tests/fixtures/higgsfield-mcp, not a
// recorded answer: no live MCP calls).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { API_KEY, FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { getMedia, sweepMedia, MEDIA_TTL_MS } from '../../server/src/integrations/connections/media'
import { recordSent } from '../../server/src/tools/connection-urls'
import { saveUrl } from '../../server/src/tools/save-url'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnTool, TurnToolContext } from '../../server/src/services'
import { isolation } from '../../server/src/tools/isolate'

setDefaultTimeout(30_000)

const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'fixtures', 'higgsfield-mcp', 'tools-call.json'), 'utf8'))
const HERO = 'https://cdn.higgsfield.test/user_2xKq7Pz9/hf_20261101_0a8f3c2e/hero.png?X-Amz-Expires=3600&X-Amz-Signature=5f2c9d1e7a'
const ALT = 'https://cdn.higgsfield.test/user_2xKq7Pz9/hf_20261101_0a8f3c2e/hero-alt.webp'

let A: CApp, fake: FakeServices, conn: any, api: any
const post = (as: Person, p: string, body: unknown) => A.json(p, { method: 'POST', as, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeAll(async () => {
  A = await makeCApp('c-integrations-media')
  fake = new FakeServices()
  fake.tools = [
    { name: 'generate_image', description: 'Generate an image', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } },
    { name: 'jobs_wait', description: 'Wait for jobs', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'big_image', description: 'A large inline image', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'echo_args', description: 'Repeats its input', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ]
  fake.results = { generate_image: FIXTURE.generate_image, jobs_wait: FIXTURE.jobs_wait }
  integrationsOf(A.ctx, { net: fake.net() })
  conn = (await post('alice', '/api/integrations', { kind: 'mcp', name: 'Higgsfield', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })).body
  api = (await post('alice', '/api/integrations', { kind: 'http', name: 'Files API', url: `${fake.base}/api/v1`, auth: 'bearer', secret: API_KEY })).body
  expect([conn.status, api.status]).toEqual(['connected', 'connected'])
})
afterAll(async () => { fake?.stop(); await A?.close() })

function turn(user: Person) {
  const chat = A.chat(user)
  const turnId = A.turn(user, chat)
  const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: false })
  const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles() } as TurnToolContext['files']
  files.person = { locale: 'en', async confirm() { return true }, *turnUrls() {} }
  files.confirmWidening = async () => null
  const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale: 'en', signal: new AbortController().signal, files }
  const tools = new Map(built.tools.map((t) => [t.name, t]))
  const call = async (name: string, args: unknown) => {
    // what the chat's tool set does before every call (chat/tools.ts)
    recordSent(A.ctx.db, chat, args)
    const r = await (tools.get(name) as TurnTool).call(args, tc)
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), content: r.content, isError: !!r.isError, summary: r.summary ?? '' }
  }
  return { chat, turnId, files, call }
}
const urlsOf = (chat: string) => A.ctx.db.query('SELECT url, echo, integration_id AS i FROM chat_connection_urls WHERE chat_id = ? ORDER BY url').all(chat) as { url: string; echo: number; i: string }[]

describe('an image service answer (synthetic Higgsfield-like fixture)', () => {
  test('the result address and the resource link become learned links; the inline image becomes a handle, never text', async () => {
    const t = turn('alice')
    const job = await t.call('my_higgsfield__generate_image', { prompt: 'a hero image of a mint-green landing page' })
    expect(job.isError).toBe(false)
    const r = await t.call('my_higgsfield__jobs_wait', { job_id: '0a8f3c2e-5d1b-4f7a-9c11-7e2d6b9a4f10' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain(HERO.replace(/&/g, '&'))
    expect(r.text).toMatch(/\[image image\/png 4×3 \d+ B: mcp-file:[A-Za-z0-9_-]{22} \(save it with save_url/)
    expect(r.text).not.toContain(FIXTURE.jobs_wait.content[2].data.slice(0, 40))
    expect(r.summary).toMatch(/1 file kept: mcp-file:\S+ png \d+ B sha256 [0-9a-f]{16}/)
    expect(urlsOf(t.chat)).toEqual([{ url: ALT, echo: 0, i: conn.id }, { url: HERO, echo: 0, i: conn.id }])
    // the handle saves the image without asking the service again
    const handle = /mcp-file:[A-Za-z0-9_-]{22}/.exec(r.text)![0]
    const calls = fake.calls.length
    const saved = await saveUrl(A.ctx, { url: handle, save_as: 'shared/landing/images/hero.png' }, t.files, { statfs: () => ({ bsize: 4096, blocks: 1e8, bfree: 5e7, bavail: 5e7 }), normalize: async () => {} })
    expect(saved.structured).toMatchObject({ path: 'shared/landing/images/hero.png', type: 'image/png' })
    expect(fs.readFileSync(path.join(A.team, 'shared/landing/images/hero.png')).equals(Buffer.from(FIXTURE.jobs_wait.content[2].data, 'base64'))).toBe(true)
    expect(fake.calls.length).toBe(calls)
  })
  // the real normalizer in the converter isolation (bun run build:native)
  test.skipIf(!fs.existsSync(path.join(import.meta.dir, '../../native/bin', `${process.platform}-${process.arch}`, 'mycel-safeops')) || isolation() === 'none')('the AI sees the image when the team allows images for the AI (rebuilt as JPEG), and not when it is off', async () => {
    const setVision = (on: boolean) => A.ctx.db.query("INSERT INTO settings (key, value) VALUES ('aiVision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(on))
    const on = await turn('alice').call('my_higgsfield__jobs_wait', {})
    const img = on.content.filter((c) => c.type === 'image') as { type: 'image'; data: string; mimeType: string }[]
    expect(img).toHaveLength(1)
    expect(img[0]!.mimeType).toBe('image/jpeg')
    expect(Buffer.from(img[0]!.data, 'base64').subarray(0, 3).toString('hex')).toBe('ffd8ff')
    expect(on.text).toContain('Its image is shown below')
    setVision(false)
    try {
      const off = await turn('alice').call('my_higgsfield__jobs_wait', {})
      expect(off.content.filter((c) => c.type === 'image')).toHaveLength(0)
      expect(off.text).toContain('mcp-file:')
    } finally { setVision(true) }
  })
  test('an answer over 1 MB with an inline image works (tools/call takes up to 25 MB); over 25 MB it is refused', async () => {
    const t = turn('alice')
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000100000001008020000', 'hex'), Buffer.alloc(3 * 1024 * 1024, 1)])
    fake.results.big_image = { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] }
    const r = await t.call('my_higgsfield__big_image', {})
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/image\/png 16×16 3\.0 MB: mcp-file:/)
    expect(r.text.length).toBeLessThan(2000)
    const handle = /mcp-file:[A-Za-z0-9_-]{22}/.exec(r.text)![0]
    expect(getMedia(A.data, t.chat, 'alice', handle)?.meta.size).toBe(png.length)
    expect(getMedia(A.data, t.chat, 'bob', handle)).toBeNull()
    fake.results.big_image = { content: [{ type: 'image', data: Buffer.alloc(26 * 1024 * 1024, 2).toString('base64'), mimeType: 'image/png' }] }
    const over = await t.call('my_higgsfield__big_image', {})
    expect(over.isError).toBe(true)
    expect(over.text).toContain('too large')
    delete fake.results.big_image
  })
  test('a stored key the service repeats in an inline block\'s type is hidden: in the text and in what is kept', async () => {
    const t = turn('alice')
    fake.results.big_image = { content: [{ type: 'image', data: Buffer.from('not an image at all').toString('base64'), mimeType: `x/y; key=${MCP_KEY}` }] }
    const r = await t.call('my_higgsfield__big_image', {})
    expect(r.text).toContain('unknown type')
    expect(r.text).not.toContain(MCP_KEY)
    expect(r.text).not.toContain(MCP_KEY.slice(0, 10))
    const dir = path.join(A.data, 'connection-media', t.chat)
    for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toContain(MCP_KEY)
    delete fake.results.big_image
  })
  test('an address the AI sent and the service repeated is remembered as an echo', async () => {
    const t = turn('alice')
    await t.call('my_higgsfield__echo_args', { image_url: 'https://attacker.example/c?d=SECRETDATA42' })
    expect(urlsOf(t.chat)).toEqual([{ url: 'https://attacker.example/c?d=SECRETDATA42', echo: 1, i: conn.id }])
  })
  test('api_request answers: addresses in them are learned links too (and echoes stay echoes)', async () => {
    const t = turn('alice')
    await t.call('api_request', { connection: 'my_filesapi', method: 'GET', path: '/tasks', query: { file: 'https://files.example/report.pdf' } })
    expect(urlsOf(t.chat)).toEqual([{ url: 'https://files.example/report.pdf', echo: 1, i: api.id }])
  })
  test('kept items go after a day', () => {
    const t = turn('alice')
    const n = sweepMedia(A.data, Date.now() + MEDIA_TTL_MS + 60_000)
    expect(n).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(A.data, 'connection-media', t.chat))).toBe(false)
  })
})
