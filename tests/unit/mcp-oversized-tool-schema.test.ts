// A tool whose input schema is too large (mcp.ts MAX_SCHEMA_CHARS) is kept with its longest descriptions shortened,
// and left out only when its structure alone does not fit; either way the check logs it, and a list that is empty only
// because of that says so (toolsTooLarge), not "the service listed no tools". A sign-in whose advertised scopes are too
// many to ask for asks for none and says so (oauth.ts discover scopeOmitted). Nothing here is keyed to one service.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { cutWords, MAX_SCHEMA_CHARS, MAX_SCHEMAS_CHARS, SHORTENED, shrinkSchema, toolOf } from '../../server/src/integrations/connections/mcp'
import { authorizationUrl, discover, MAX_SCOPE_CHARS } from '../../server/src/integrations/connections/oauth'
import type { NetOptions } from '../../server/src/integrations/connections/net'

setDefaultTimeout(60_000)

const size = (x: unknown) => JSON.stringify(x).length
/** a tool with one string property whose description is `n` characters */
const longTool = (name: string, n: number, more: Record<string, unknown> = {}) => ({
  name, description: `${name} tool`,
  inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'd'.repeat(n) }, ...more }, required: ['command'] },
})

describe('shrinkSchema / toolOf', () => {
  test('a schema just over the cap is kept, shortened to fit, with the marker; the note says shortened', () => {
    const t = longTool('exec', MAX_SCHEMA_CHARS)
    expect(size(t.inputSchema)).toBeGreaterThan(MAX_SCHEMA_CHARS)
    const notes: [string, number, boolean][] = []
    const kept = toolOf(t, undefined, (...a) => notes.push(a))!
    expect(kept).not.toBeNull()
    expect(size(kept.inputSchema)).toBeLessThanOrEqual(MAX_SCHEMA_CHARS)
    // as close to the cap as one common length allows
    expect(size(kept.inputSchema)).toBeGreaterThan(MAX_SCHEMA_CHARS - 50)
    const d = (kept.inputSchema as any).properties.command.description as string
    expect(d.endsWith(SHORTENED)).toBe(true)
    expect((kept.inputSchema as any).required).toEqual(['command'])
    expect(notes).toEqual([['exec', size(t.inputSchema), true]])
  })

  test('a schema under the cap is kept as it is, with no note', () => {
    const t = longTool('small', 1000)
    const notes: unknown[] = []
    expect(toolOf(t, undefined, (...a) => notes.push(a))!.inputSchema).toEqual(t.inputSchema)
    expect(notes).toEqual([])
  })

  test('nested long descriptions are cut to one length; short ones and values (enum, default, const, examples) stay', () => {
    const value = 'v'.repeat(3000)
    const schema = {
      type: 'object', description: 'top',
      properties: {
        a: { type: 'object', description: 'a'.repeat(20_000), properties: { deep: { type: 'array', items: { type: 'string', description: 'b'.repeat(20_000) } } } },
        short: { type: 'string', description: 'stays whole' },
        mode: { type: 'string', enum: [value, 'x'], default: value, examples: [{ description: value }] },
        fixed: { const: { description: value } },
        // a property named "description" is a schema, not words
        description: { type: 'string', description: 'c'.repeat(10_000) },
      },
    }
    const out = shrinkSchema(schema, MAX_SCHEMA_CHARS) as any
    expect(size(out)).toBeLessThanOrEqual(MAX_SCHEMA_CHARS)
    expect(out.description).toBe('top')
    expect(out.properties.short.description).toBe('stays whole')
    expect(out.properties.mode).toEqual(schema.properties.mode)
    expect(out.properties.fixed).toEqual(schema.properties.fixed)
    const cut = [out.properties.a.description, out.properties.a.properties.deep.items.description, out.properties.description.description]
    for (const c of cut) expect(c.endsWith(SHORTENED)).toBe(true)
    // one common length for the long ones
    expect(new Set(cut.map((c: string) => c.length)).size).toBe(1)
    expect(out.properties.description.type).toBe('string')
  })

  test('properties named like value keywords (example, default, enum, const, examples) are schemas: walked and cut', () => {
    const named = (k: string) => ({ [k]: { type: 'string', description: 'p'.repeat(10_000) } })
    const maps = {
      type: 'object',
      properties: { ...named('example'), ...named('default'), ...named('enum') },
      $defs: named('const'), definitions: named('examples'), patternProperties: { '^x-': { type: 'string', description: 'q'.repeat(10_000) } },
      dependentSchemas: named('default'),
    }
    const out = shrinkSchema(maps, MAX_SCHEMA_CHARS) as any
    expect(out).not.toBeNull()
    expect(size(out)).toBeLessThanOrEqual(MAX_SCHEMA_CHARS)
    for (const d of [out.properties.example, out.properties.default, out.properties.enum, out.$defs.const, out.definitions.examples, out.patternProperties['^x-'], out.dependentSchemas.default])
      expect(d.description.endsWith(SHORTENED)).toBe(true)
    // the reported case: one property named "example" with a 40k description is kept, not dropped
    const t = { name: 'ex', description: '', inputSchema: { type: 'object', properties: named('example') } }
    ;(t.inputSchema.properties.example as any).description = 'e'.repeat(40_000)
    expect(toolOf(t)).not.toBeNull()
  })

  test('a schema that cannot fit (its structure alone is too large) is left out, and the note says so', () => {
    const props = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`field_number_${i}`, { type: 'string', description: 'x'.repeat(50) }]))
    const t = { name: 'huge', description: '', inputSchema: { type: 'object', properties: props } }
    expect(shrinkSchema(t.inputSchema, MAX_SCHEMA_CHARS)).toBeNull()
    const notes: [string, number, boolean][] = []
    expect(toolOf(t, undefined, (...a) => notes.push(a))).toBeNull()
    expect(notes).toEqual([['huge', size(t.inputSchema), false]])
    // no description at all to cut: left out too
    const bare = { type: 'object', properties: { e: { type: 'string', enum: ['y'.repeat(MAX_SCHEMA_CHARS)] } } }
    expect(shrinkSchema(bare, MAX_SCHEMA_CHARS)).toBeNull()
  })

  test('the tool\'s own description: cut at 1,000 with the marker, never a split surrogate pair', () => {
    const t = { ...longTool('t', 10), description: 'w'.repeat(5000) }
    const d = toolOf(t)!.description
    expect(d.length).toBe(1000)
    expect(d.endsWith(SHORTENED)).toBe(true)
    const emoji = '😀'.repeat(100)
    const c = cutWords(emoji, 50)
    expect(c.endsWith(SHORTENED)).toBe(true)
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(c)).toBe(false)
  })
})

let A: CApp, fake: FakeServices
const send = (method: string) => (as: Person, p: string, body?: unknown) =>
  A.json(p, { method, as, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
const post = send('POST'), del = send('DELETE')

describe('a check of a service with oversized tools', () => {
  const logged: { msg: string; fields?: Record<string, unknown> }[] = []
  beforeAll(async () => {
    A = await makeCApp('mcp-oversized-tool-schema')
    fake = new FakeServices()
    integrationsOf(A.ctx, { net: fake.net() })
    const warn = A.ctx.log.warn.bind(A.ctx.log)
    A.ctx.log.warn = (msg, fields) => { logged.push({ msg, fields }); warn(msg, fields) }
  })
  afterAll(async () => { fake?.stop(); await A?.close() })

  test('one tool with a long command reference: kept shortened, logged, and usable', async () => {
    logged.length = 0
    fake.tools = [longTool('exec', 36_000)]
    const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Big', url: `${fake.base}/mcp-open?big`, auth: 'none' })
    try {
      expect(r.body.status).toBe('connected')
      expect(r.body.tools.map((t: any) => t.name)).toEqual(['exec'])
      expect(r.body.toolsTooLarge).toBeUndefined()
      const line = logged.find((l) => l.msg.includes('schema size limit'))!
      expect(line.fields).toMatchObject({ id: r.body.id, name: 'Big', shortened: 1, dropped: 0, shortenedTools: [`exec (${size(fake.tools[0]!.inputSchema)})`] })
    } finally { await del('alice', `/api/integrations/${r.body.id}`) }
  })

  test('every tool left out as too large: connected, empty, toolsTooLarge (not "listed no tools"), logged', async () => {
    logged.length = 0
    const props = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`field_number_${i}`, { type: 'string' }]))
    fake.tools = [{ name: 'huge', description: 'x', inputSchema: { type: 'object', properties: props } }]
    const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Huge', url: `${fake.base}/mcp-open?huge`, auth: 'none' })
    try {
      expect(r.body.status).toBe('connected')
      expect(r.body.tools).toEqual([])
      expect(r.body.toolsTooLarge).toBe(1)
      expect(logged.find((l) => l.msg.includes('schema size limit'))!.fields).toMatchObject({ dropped: 1, droppedTools: [`huge (${size(fake.tools[0]!.inputSchema)})`] })
      // a later check that keeps its tools clears it
      fake.tools = [longTool('fine', 10)]
      const again = await post('alice', `/api/integrations/${r.body.id}/refresh`, {})
      expect(again.body.tools.map((t: any) => t.name)).toEqual(['fine'])
      expect(again.body.toolsTooLarge).toBeUndefined()
    } finally { await del('alice', `/api/integrations/${r.body.id}`) }
  })

  test('"shortened" counts only tools kept: not a duplicate, not one past a full list', async () => {
    logged.length = 0
    // a small tool first, then the same name oversized (a duplicate, skipped), then a new oversized one (kept)
    fake.tools = [longTool('dup', 10), longTool('dup', 40_000), longTool('kept', 40_000)]
    fake.pageSize = 3
    const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Dup', url: `${fake.base}/mcp-open?dup`, auth: 'none' })
    fake.pageSize = 2
    try {
      expect(r.body.tools.map((t: any) => t.name)).toEqual(['dup', 'kept'])
      const f = logged.find((l) => l.msg.includes('schema size limit'))!.fields!
      expect(f).toMatchObject({ shortened: 1, dropped: 0 })
      expect((f.shortenedTools as string[])[0]).toMatch(/^kept \(/)
    } finally { await del('alice', `/api/integrations/${r.body.id}`) }
  })

  test('the total cap counts the shortened size', async () => {
    logged.length = 0
    // each shortened to about MAX_SCHEMA_CHARS: no more than the 4,000,000 characters in all are kept
    const n = Math.floor(MAX_SCHEMAS_CHARS / MAX_SCHEMA_CHARS) + 5
    fake.tools = Array.from({ length: n }, (_, i) => longTool(`t${i}`, 40_000))
    // one page (about 5.2 MB), so the page limit does not stop reading first
    fake.pageSize = n
    const r = await post('alice', '/api/integrations', { kind: 'mcp', name: 'Many', url: `${fake.base}/mcp-open?many`, auth: 'none' })
    fake.pageSize = 2
    try {
      expect(r.body.status).toBe('connected')
      expect(r.body.tools.length).toBeLessThan(n)
      expect(r.body.tools.length).toBeGreaterThanOrEqual(Math.floor(MAX_SCHEMAS_CHARS / (MAX_SCHEMA_CHARS + 20)))
      expect(r.body.toolsTotal).toBe(n)
      // the ones past the full list were not kept, so not counted as shortened
      expect(logged.find((l) => l.msg.includes('schema size limit'))!.fields).toMatchObject({ shortened: r.body.tools.length, dropped: 0 })
    } finally { await del('alice', `/api/integrations/${r.body.id}`) }
  })
})

describe('discover: scopes', () => {
  const MCP = 'https://mcp.example.test/mcp', AS = 'https://auth.example.test'
  const netWith = (scopes: string[]): NetOptions => ({
    answer: async (url) => {
      const json = (j: unknown) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(j) })
      if (url === 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp') return json({ resource: MCP, authorization_servers: [AS], scopes_supported: scopes })
      if (url === `${AS}/.well-known/oauth-authorization-server`) return json({ issuer: AS, authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, registration_endpoint: `${AS}/register`, code_challenge_methods_supported: ['S256'] })
      return { status: 404 }
    },
  })
  const client = { clientId: 'c', clientSecret: null, authMethod: 'none' as const, redirectUri: 'https://team.example.test/cb' }

  test('a few scopes: all asked for, nothing omitted', async () => {
    const found = await discover(MCP, netWith(['read', 'write']))
    expect(found.scope).toBe('read write')
    expect(found.scopeOmitted).toBeUndefined()
  })

  test(`over ${MAX_SCOPE_CHARS} characters: none asked for, and how many is reported`, async () => {
    const many = Array.from({ length: 160 }, (_, i) => `resource_number_${i}:read`)
    expect(many.join(' ').length).toBeGreaterThan(MAX_SCOPE_CHARS)
    const found = await discover(MCP, netWith(many))
    expect(found.scope).toBeNull()
    expect(found.scopeOmitted).toEqual({ count: 160, chars: many.join(' ').length })
    expect(new URL(authorizationUrl({ ...found, client }, 'S'.repeat(43), 'C'.repeat(43))).searchParams.has('scope')).toBe(false)
  })

  test('the 401\'s own scope hint wins over the advertised list', async () => {
    const many = Array.from({ length: 160 }, (_, i) => `resource_number_${i}:read`)
    const found = await discover(MCP, netWith(many), `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp", scope="read"`)
    expect(found.scope).toBe('read')
    expect(found.scopeOmitted).toBeUndefined()
  })
})
