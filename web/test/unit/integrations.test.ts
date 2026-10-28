// External-service connections (lib/integrations.ts): the add / edit form checks what the contract checks, becomes the
// bodies the contract accepts, sends only what changed, never sends a stored key anywhere new, and the sign-in address
// from the server is opened only when it is https.
import { describe, expect, test } from 'bun:test'
import { ApiError, IntegrationInput, IntegrationPatch, type Integration } from '@mycel/shared/api'
import {
  authorizationUrl, authOf, covers, dropsSecret, emptyForm, formFrom, needsKey, normalAccess, sameAccess, serverFieldErrors, splitByScope, toInput, toPatch, urlProblem, validate, withKind,
  type IntegrationForm,
} from '../../src/lib/integrations'
import { DICTS } from '../../src/i18n'

const at = '2026-10-28T00:00:00.000Z'
function connection(o: Partial<Integration> = {}): Integration {
  return {
    id: 'i1', scope: 'personal', kind: 'http', name: 'AI PM', slug: 'aipm', url: 'https://pm.example.com/api', auth: 'bearer', authHeader: null, hasSecret: true, account: null,
    notes: 'GET /projects', writePolicy: 'ask', status: 'connected', lastError: null, tools: [], toolsUpdatedAt: null, access: null, createdBy: { id: 'olga', name: 'Olga' },
    createdAt: at, updatedAt: at, lastUsedAt: null, canManage: true, ...o,
  }
}
const filled = (o: Partial<IntegrationForm> = {}): IntegrationForm => ({ ...emptyForm('http'), name: 'AI PM', url: 'https://pm.example.com/api', secret: 'pm-key-123', ...o })

describe('the address', () => {
  test('https only, like the contract (no user name, password or #)', () => {
    for (const ok of ['https://mcp.notion.com/mcp', 'https://api.example.com/v1?x=1', 'https://example.com:8443/']) {
      expect({ ok, problem: urlProblem(ok) }).toEqual({ ok, problem: null })
      expect(IntegrationInput.safeParse(toInput(filled({ url: ok }))).success).toBe(true)
    }
    expect(urlProblem('')).toBe('integrations.error.url')
    expect(urlProblem('http://api.example.com')).toBe('integrations.error.url')
    expect(urlProblem('javascript:alert(1)')).toBe('integrations.error.url')
    expect(urlProblem('ftp://example.com')).toBe('integrations.error.url')
    expect(urlProblem('api.example.com')).toBe('integrations.error.url')
    expect(urlProblem('https://user:pw@example.com/')).toBe('integrations.error.urlParts')
    expect(urlProblem('https://example.com/#x')).toBe('integrations.error.urlParts')
    expect(urlProblem('https://example.com/' + 'a'.repeat(2000))).toBe('integrations.error.urlLong')
    // what the client refuses, the contract refuses too
    for (const bad of ['http://api.example.com', 'https://user:pw@example.com/', 'https://example.com/#x']) expect(IntegrationInput.safeParse(toInput(filled({ url: bad }))).success).toBe(false)
  })
})

describe('the form', () => {
  test('a new MCP server signs in by default; an API asks for a key; sign-in is for MCP servers only', () => {
    expect(emptyForm('mcp').method).toBe('oauth')
    expect(emptyForm('http').method).toBe('key')
    expect(withKind(emptyForm('mcp'), 'http').method).toBe('key')
    expect(withKind({ ...emptyForm('mcp'), method: 'none' }, 'http').method).toBe('none')
    expect(authOf({ method: 'key', header: 'bearer' })).toBe('bearer')
    expect(authOf({ method: 'key', header: 'custom' })).toBe('header')
    expect(validate({ ...filled(), method: 'oauth' })).toHaveProperty('method')
  })
  test('checks: name, address, header name, key, notes', () => {
    expect(validate(filled())).toEqual({})
    expect(validate(filled({ name: '  ' })).name).toBe('integrations.error.name')
    expect(validate(filled({ name: 'x'.repeat(61) })).name).toBe('integrations.error.nameLong')
    expect(validate(filled({ secret: '' })).secret).toBe('integrations.error.key')
    expect(validate(filled({ secret: 'k'.repeat(8001) })).secret).toBe('integrations.error.keyLong')
    expect(validate(filled({ header: 'custom', headerName: 'X API Key' })).headerName).toBe('integrations.error.header')
    expect(validate(filled({ header: 'custom', headerName: 'X-API-Key' }))).toEqual({})
    expect(validate(filled({ notes: 'n'.repeat(4001) })).notes).toBe('integrations.error.notes')
    expect(validate(filled({ method: 'none', secret: '' }))).toEqual({})
    // every message the checks name exists in every language
    const keys = Object.values({ ...validate(filled({ name: '', url: 'http://x', secret: '', header: 'custom', headerName: '?', notes: 'n'.repeat(4001) })) })
    expect(keys.length).toBe(5)
    for (const k of keys) for (const d of Object.values(DICTS)) expect(d[k!]).toBeTruthy()
  })
  test('a new connection becomes a body the contract accepts: the key only with a key, notes only for an API, access only for the team', () => {
    const http = toInput(filled({ notes: '  GET /projects  ', header: 'custom', headerName: 'X-API-Key' }))
    expect(http).toEqual({ kind: 'http', name: 'AI PM', url: 'https://pm.example.com/api', auth: 'header', authHeader: 'X-API-Key', secret: 'pm-key-123', notes: 'GET /projects', writePolicy: 'ask' })
    expect(IntegrationInput.safeParse(http).success).toBe(true)
    const mcp = toInput({ ...emptyForm('mcp'), name: 'Notion', url: 'https://mcp.notion.com/mcp', secret: 'left over', notes: 'ignored' })
    expect(mcp).toEqual({ kind: 'mcp', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', authHeader: null, notes: null, writePolicy: 'ask' })
    expect(IntegrationInput.safeParse(mcp).success).toBe(true)
    const team = toInput({ ...filled(), access: { everyone: false, groups: ['g1', 'g1'], users: ['bob'] }, writePolicy: 'deny' })
    expect(team.access).toEqual({ everyone: false, groups: ['g1'], users: ['bob'] })
    expect(team.writePolicy).toBe('deny')
    expect(IntegrationInput.safeParse(team).success).toBe(true)
  })
})

describe('editing', () => {
  test('the form of a saved connection holds no key; unchanged, nothing is sent', () => {
    const c = connection()
    const f = formFrom(c)
    expect(f.secret).toBe('')
    expect(f.method).toBe('key')
    expect(toPatch(f, c)).toEqual({})
    expect(validate(f, c)).toEqual({}) // the stored key is enough
    expect(needsKey(f, c)).toBe(false)
  })
  test('a new address drops the stored key: it has to be typed again and goes along with the address', () => {
    const c = connection()
    const f = { ...formFrom(c), url: 'https://other.example.com/api' }
    expect(dropsSecret(f, c)).toBe(true)
    expect(needsKey(f, c)).toBe(true)
    expect(validate(f, c).secret).toBe('integrations.error.key')
    const p = toPatch({ ...f, secret: 'new-key' }, c)
    expect(p).toEqual({ url: 'https://other.example.com/api', secret: 'new-key' })
    expect(IntegrationPatch.safeParse(p).success).toBe(true)
    // another header for the key is another sign-in method too
    expect(dropsSecret({ ...formFrom(c), header: 'custom', headerName: 'X-Key' }, c)).toBe(true)
  })
  test('replace and remove the stored key', () => {
    const c = connection()
    const replace = { ...formFrom(c), keyAction: 'replace' as const }
    expect(validate(replace, c).secret).toBe('integrations.error.key')
    expect(toPatch({ ...replace, secret: ' fresh ' }, c)).toEqual({ secret: 'fresh' })
    const remove = { ...formFrom(c), keyAction: 'remove' as const, secret: 'ignored' }
    expect(validate(remove, c)).toEqual({})
    expect(toPatch(remove, c)).toEqual({ clearSecret: true })
  })
  test('notes, write policy and who may use a team connection', () => {
    const c = connection({ scope: 'team', access: { everyone: false, groups: ['g1'], users: [] } })
    expect(toPatch({ ...formFrom(c), notes: '', writePolicy: 'allow' }, c)).toEqual({ notes: null, writePolicy: 'allow' })
    expect(toPatch({ ...formFrom(c), access: { everyone: false, groups: ['g1'], users: [] } }, c)).toEqual({})
    expect(toPatch({ ...formFrom(c), access: { everyone: true, groups: ['g1'], users: [] } }, c)).toEqual({ access: { everyone: true, groups: [], users: [] } })
    // a personal connection never sends access
    expect(toPatch({ ...formFrom(connection()), access: { everyone: true, groups: [], users: [] } }, connection())).toEqual({})
  })
  test('an MCP server signed in: a new address means signing in again; renaming does not', () => {
    const c = connection({ kind: 'mcp', auth: 'oauth', notes: null, account: 'olga@example.test' })
    expect(dropsSecret({ ...formFrom(c), name: 'Notion (work)' }, c)).toBe(false)
    expect(dropsSecret({ ...formFrom(c), url: 'https://mcp.example.com/v2' }, c)).toBe(true)
    expect(toPatch({ ...formFrom(c), name: 'Notion (work)' }, c)).toEqual({ name: 'Notion (work)' })
  })
})

describe('who may use a team connection', () => {
  const olga = { id: 'olga', groupIds: ['g1'] }
  test('everyone, a group the person is in, or the person; admins are not implied', () => {
    expect(covers({ everyone: true, groups: [], users: [] }, olga)).toBe(true)
    expect(covers({ everyone: false, groups: ['g1'], users: [] }, olga)).toBe(true)
    expect(covers({ everyone: false, groups: [], users: ['olga'] }, olga)).toBe(true)
    expect(covers({ everyone: false, groups: ['g2'], users: ['bob'] }, olga)).toBe(false)
    expect(covers(null, olga)).toBe(false)
  })
  test('the same rule in another order is no change', () => {
    expect(sameAccess({ everyone: false, groups: ['a', 'b'], users: ['x'] }, { everyone: false, groups: ['b', 'a'], users: ['x', 'x'] })).toBe(true)
    expect(sameAccess({ everyone: true, groups: ['a'], users: [] }, { everyone: true, groups: [], users: [] })).toBe(true)
    expect(normalAccess({ everyone: true, groups: ['a'], users: ['b'] })).toEqual({ everyone: true, groups: [], users: [] })
  })
})

describe('what comes back from the server', () => {
  test('the sign-in address: https only, never javascript:, data: or http:', () => {
    expect(authorizationUrl('https://auth.example.com/authorize?state=x')).toBe('https://auth.example.com/authorize?state=x')
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://auth.example.com/authorize', 'https://user:pw@auth.example.com/', 'not a url', '//auth.example.com/x'])
      expect(() => authorizationUrl(bad)).toThrow()
  })
  test('field errors land at their fields, with the server\'s own words when it gave some', () => {
    const specific = new ApiError(400, { code: 'validation', message: '사내망 주소는 쓸 수 없어요.', fields: { 'body.url': 'private address' } })
    expect(serverFieldErrors(specific)).toEqual({ url: '사내망 주소는 쓸 수 없어요.' })
    const generic = new ApiError(400, { code: 'validation', message: 'Check what you entered.', fields: { 'body.authHeader': 'give the header name', 'body.access.users.0': 'unknown', 'body.slug': 'taken' } })
    const out = serverFieldErrors(generic)
    expect(Object.keys(out).sort()).toEqual(['access', 'headerName', 'name'])
    expect(serverFieldErrors(new ApiError(403, { code: 'forbidden', message: 'no' }))).toEqual({})
    expect(serverFieldErrors(new Error('x'))).toEqual({})
  })
  test('own connections first, then the team\'s, each by name', () => {
    const items = [connection({ id: 'a', scope: 'team', name: 'Linear' }), connection({ id: 'b', name: 'Zed' }), connection({ id: 'c', name: 'AI PM' }), connection({ id: 'd', scope: 'team', name: 'GitHub' })]
    const { mine, team } = splitByScope(items)
    expect(mine.map((x) => x.id)).toEqual(['c', 'b'])
    expect(team.map((x) => x.id)).toEqual(['d', 'a'])
  })
})
