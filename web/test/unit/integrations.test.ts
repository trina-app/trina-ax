// External-service connections (lib/integrations.ts): the add / edit form checks what the contract checks, becomes the
// bodies the contract accepts, sends only what changed, never sends a stored key anywhere new, and the sign-in address
// from the server is opened only when it is https.
import { describe, expect, test } from 'bun:test'
import { ApiError, INTEGRATION_TOOLS_MAX, IntegrationInput, IntegrationPatch, type Integration } from '@mycel/shared/api'
import {
  appPatch, audienceOf, authorizationUrl, authOf, canSignIn, covers, flowReasonKey, storedSecretStays, dropsSecret, emptyForm, formFrom, formFromTemplate, lastCheckNote, methodsFor, needsKey, normalAccess, sameAccess, serverFieldErrors, splitByScope, toInput, toPatch, toolsShortfall, urlProblem, usesApp, validate, withKind,
  type IntegrationForm,
} from '../../src/lib/integrations'
import { DICTS, translate } from '../../src/i18n'

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
  test('a new MCP server signs in by default; an API asks for a key; an API signs in only with its own app', () => {
    expect(emptyForm('mcp').method).toBe('oauth')
    expect(emptyForm('http').method).toBe('key')
    expect(withKind(emptyForm('mcp'), 'http').method).toBe('key')
    expect(methodsFor('http')).toContain('oauth')
    expect(withKind({ ...emptyForm('mcp'), method: 'none' }, 'http').method).toBe('none')
    expect(authOf({ method: 'key', header: 'bearer' })).toBe('bearer')
    expect(authOf({ method: 'key', header: 'custom' })).toBe('header')
    // sign-in at an API needs its own app: the client ID and both addresses
    expect(validate({ ...filled(), method: 'oauth' })).toMatchObject({ clientId: 'integrations.error.clientId', authUrl: 'integrations.error.url', tokenUrl: 'integrations.error.url' })
    expect(validate({ ...emptyForm('mcp'), name: 'Mail', url: 'https://mail.example.com/mcp', method: 'none' })).toEqual({})
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

describe('your own app at the service (sign-in where apps do not register themselves)', () => {
  const app = { clientId: 'app-1.apps.example', authorizationUrl: null, tokenUrl: null, scope: 'mail.read', hasSecret: true }
  const google = (o: Partial<Integration> = {}) => connection({ kind: 'mcp', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', auth: 'oauth', notes: null, oauthClient: app, ...o })
  test('an MCP server offers it behind a choice; an API always signs in with one, with its addresses', () => {
    const mcp = { ...emptyForm('mcp'), name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' }
    expect(usesApp(mcp)).toBe(false)
    expect(toInput(mcp)).not.toHaveProperty('oauthClient')
    const own = { ...mcp, ownApp: true, clientId: ' app-1 ', clientSecret: ' s3cret ', scope: ' a b ' }
    expect(validate(own)).toEqual({})
    expect(toInput(own).oauthClient).toEqual({ clientId: 'app-1', clientSecret: 's3cret', scope: 'a b' })
    expect(validate({ ...own, clientId: 'app 1' }).clientId).toBe('integrations.error.clientId')
    expect(validate({ ...own, authUrl: 'https://as.example/authorize' }).tokenUrl).toBe('integrations.error.url')
    const api = { ...filled(), method: 'oauth' as const, secret: '', clientId: 'works-app', clientSecret: 'x', authUrl: 'https://auth.example.com/oauth2/v2.0/authorize', tokenUrl: 'https://auth.example.com/oauth2/v2.0/token', scope: 'calendar' }
    expect(usesApp(api)).toBe(true)
    expect(validate(api)).toEqual({})
    const body = toInput(api)
    expect(body).toMatchObject({ auth: 'oauth', oauthClient: { clientId: 'works-app', authorizationUrl: api.authUrl, tokenUrl: api.tokenUrl, scope: 'calendar' } })
    expect(body).not.toHaveProperty('secret')
    expect(IntegrationInput.safeParse(body).success).toBe(true)
    expect(IntegrationInput.safeParse({ ...body, oauthClient: undefined }).success).toBe(false)
    expect(canSignIn(connection({ auth: 'oauth' }))).toBe(true)
  })
  test('editing: the stored secret is never in the form; the same app sends nothing; another one drops the sign-in', () => {
    const f = formFrom(google())
    expect(f).toMatchObject({ ownApp: true, clientId: app.clientId, clientSecret: '', scope: 'mail.read' })
    expect(toPatch(f, google())).toEqual({})
    expect(dropsSecret(f, google())).toBe(false)
    const scoped = { ...f, scope: 'mail.read mail.send' }
    expect(toPatch(scoped, google())).toEqual({ oauthClient: { clientId: app.clientId, scope: 'mail.read mail.send' } })
    expect(dropsSecret(scoped, google())).toBe(true)
    // a new secret only when typed after "replace"; another client ID needs its own
    expect(toPatch({ ...f, clientSecret: 'ignored' }, google())).toEqual({})
    expect(toPatch({ ...f, clientSecretAction: 'replace', clientSecret: 'new' }, google()).oauthClient).toMatchObject({ clientSecret: 'new' })
    expect(toPatch({ ...f, clientId: 'other', clientSecret: 'other-secret' }, google()).oauthClient).toMatchObject({ clientId: 'other', clientSecret: 'other-secret' })
    // back to the service's own registration
    expect(toPatch({ ...f, ownApp: false }, google())).toEqual({ oauthClient: null })
    expect(appPatch({ ...f, method: 'key' }, app)).toBeUndefined()
    expect(IntegrationPatch.safeParse(toPatch(scoped, google())).success).toBe(true)
    // a member's connection made from a template: the template's app, never theirs to change
    const member = connection({ kind: 'mcp', auth: 'oauth', templateId: 't1', oauthClient: null })
    expect(toPatch(formFrom(member), member)).toEqual({})
  })
  test('a stored secret stays only where it went before (the server\'s rule): another address asks for it again', () => {
    const f = formFrom(google())
    expect(storedSecretStays(f, app, google().url)).toBe(true)
    // another service address, token address or client ID
    expect(storedSecretStays({ ...f, url: 'https://other.example/mcp' }, app, google().url)).toBe(false)
    expect(storedSecretStays({ ...f, clientId: 'other' }, app, google().url)).toBe(false)
    const given = { ...app, authorizationUrl: 'https://as.example/a', tokenUrl: 'https://as.example/t' }
    const g = { ...f, authUrl: 'https://as.example/a', tokenUrl: 'https://as.example/t' }
    expect(storedSecretStays(g, given, google().url)).toBe(true)
    // with given addresses too: the people who sign in through the app send their tokens to the service address
    expect(storedSecretStays({ ...g, url: 'https://other.example/mcp' }, given, google().url)).toBe(false)
    expect(validate({ ...g, url: 'https://other.example/mcp' }, google({ oauthClient: given })).clientSecret).toBe('integrations.error.clientSecretAgain')
    expect(storedSecretStays({ ...g, tokenUrl: 'https://evil.example/t' }, given, google().url)).toBe(false)
    // there, a secret typed in the empty field goes with the change
    expect(toPatch({ ...g, tokenUrl: 'https://evil.example/t', clientSecret: 's2' }, google({ oauthClient: given })).oauthClient).toMatchObject({ clientSecret: 's2' })
    // moved where the stored secret does not follow: it is asked for again
    expect(validate({ ...f, url: 'https://other.example/mcp' }, google()).clientSecret).toBe('integrations.error.clientSecretAgain')
    expect(validate({ ...f, url: 'https://other.example/mcp', clientSecret: 'again' }, google())).toEqual({})
    expect(validate({ ...f, name: 'Gmail 2' }, google())).toEqual({})
    // MCP -> API -> MCP: the own app is not left chosen with nothing filled in
    expect(withKind(withKind(emptyForm('mcp'), 'http'), 'mcp').ownApp).toBe(false)
  })
  test('a template\'s app fills the form for the admin', () => {
    const t = { id: 't1', kind: 'http' as const, name: 'Works', url: 'https://www.worksapis.com/v1.0', auth: 'oauth' as const, authHeader: null, notes: null, access: { everyone: true, groups: [], users: [] },
      oauthClient: { clientId: 'works-app', authorizationUrl: 'https://auth.example.com/a', tokenUrl: 'https://auth.example.com/t', scope: 'calendar', hasSecret: true }, connected: 2, createdBy: null, createdAt: at, updatedAt: at }
    const f = formFromTemplate(t)
    expect(f).toMatchObject({ method: 'oauth', ownApp: true, clientId: 'works-app', authUrl: 'https://auth.example.com/a', tokenUrl: 'https://auth.example.com/t', scope: 'calendar', clientSecret: '' })
    expect(appPatch(f, t.oauthClient)).toBeUndefined()
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
  // Admin › Connectors: one chip after the name (components/integrations/IntegrationRow.tsx AudienceChip)
  test('in one chip: everyone, the first group and how many more, one person by name, or how many people; nothing for nobody', () => {
    const groups = [{ id: 'g1', name: 'Design' }, { id: 'g2', name: 'Finance' }]
    const users = [{ id: 'olga', name: 'Olga' }, { id: 'bob', name: 'Bob' }, { id: 'ann', name: 'Ann' }]
    expect(audienceOf({ everyone: true, groups: ['g1'], users: [] }, groups, users)).toEqual({ kind: 'everyone' })
    expect(audienceOf({ everyone: false, groups: ['g1'], users: [] }, groups, users)).toEqual({ kind: 'named', name: 'Design', more: 0, all: 'Design' })
    expect(audienceOf({ everyone: false, groups: ['g1', 'g2'], users: ['bob'] }, groups, users)).toEqual({ kind: 'named', name: 'Design', more: 2, all: 'Design, Finance, Bob' })
    expect(audienceOf({ everyone: false, groups: [], users: ['bob'] }, groups, users)).toEqual({ kind: 'named', name: 'Bob', more: 0, all: 'Bob' })
    expect(audienceOf({ everyone: false, groups: [], users: ['olga', 'bob', 'ann'] }, groups, users)).toEqual({ kind: 'people', n: 3, all: 'Olga, Bob, Ann' })
    expect(audienceOf({ everyone: false, groups: [], users: [] }, groups, users)).toBeNull()
    // a group deleted since: "?" as in the details, still counted, and a known name goes first
    expect(audienceOf({ everyone: false, groups: ['gone', 'g2'], users: [] }, groups, users)).toEqual({ kind: 'named', name: 'Finance', more: 1, all: '?, Finance' })
    expect(audienceOf({ everyone: false, groups: ['gone'], users: [] }, groups, users)).toEqual({ kind: 'named', name: '?', more: 0, all: '?' })
    expect(translate('en', 'integrations.audience.more', { name: 'Design', n: 2 })).toBe('Design +2')
    expect(translate('en', 'integrations.audience.people', { n: 3 })).toBe('3 people')
    expect(translate('es', 'integrations.audience.people', { n: 1 })).toBe('1 persona')
    expect(translate('ko', 'integrations.audience.people', { n: 3 })).toBe('3명')
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

describe('the tool list in Settings', () => {
  const tools = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, title: null, description: '', readOnly: false, enabled: true }))
  test('every tool the service lists is there: "186 tools", no "N of M"; a short list says why', () => {
    expect(toolsShortfall(connection({ kind: 'mcp', tools: tools(186) }))).toBeNull()
    // a list an older server cut at 100: checking again saves the rest
    expect(toolsShortfall(connection({ kind: 'mcp', tools: tools(100), toolsTotal: 150 }))).toBe('integrations.toolsStale')
    // over the server's ceiling
    expect(toolsShortfall(connection({ kind: 'mcp', tools: tools(INTEGRATION_TOOLS_MAX), toolsTotal: INTEGRATION_TOOLS_MAX + 200 }))).toBe('integrations.toolsCapped')
    // over the 4,000,000 characters with fewer than 1,000 tools: checking again would not help
    expect(toolsShortfall(connection({ kind: 'mcp', tools: tools(400), toolsTotal: 500 }))).toBe('integrations.toolsCapped')
    // the server stopped reading the list with pages left: "1,000 of more than 1,000", never "check again"
    expect(toolsShortfall(connection({ kind: 'mcp', tools: tools(INTEGRATION_TOOLS_MAX), toolsTotal: INTEGRATION_TOOLS_MAX, toolsTotalMore: true }))).toBe('integrations.toolsCappedMore')
    expect(toolsShortfall(connection({ kind: 'mcp', tools: tools(40), toolsTotal: 40, toolsTotalMore: true }))).toBe('integrations.toolsCappedMore')
    for (const d of Object.values(DICTS)) for (const k of ['integrations.toolsStale', 'integrations.toolsCapped', 'integrations.toolsCappedMore', 'integrations.tools', 'integrations.toolsOf', 'integrations.toolsOfMore'] as const) expect(d[k]).toBeTruthy()
    expect(DICTS.ko['integrations.toolsStale']).toContain('다시 확인')
  })
})

describe('a connection whose last check failed', () => {
  test('connected with a reason: the check failed for now and the AI keeps the list saved before; an error or a sign-in says it in the row', () => {
    const reason = 'The service did not answer within 30 seconds.'
    expect(lastCheckNote(connection({ kind: 'mcp' }))).toBeNull()
    expect(lastCheckNote(connection({ kind: 'mcp', status: 'connected', lastError: reason, toolsUpdatedAt: at }))).toEqual({ key: 'integrations.checkFailedKept', reason, date: at })
    expect(lastCheckNote(connection({ kind: 'mcp', status: 'connected', lastError: reason }))).toEqual({ key: 'integrations.lastCheckFailed', reason, date: null })
    expect(lastCheckNote(connection({ kind: 'mcp', status: 'error', lastError: reason, toolsUpdatedAt: at }))).toBeNull()
    expect(lastCheckNote(connection({ kind: 'mcp', status: 'needs_auth', lastError: reason, toolsUpdatedAt: at }))).toBeNull()
    for (const d of Object.values(DICTS)) for (const k of ['integrations.checkFailedKept', 'integrations.lastCheckFailed'] as const) expect(d[k]).toContain('{reason}')
    for (const d of Object.values(DICTS)) expect(d['integrations.checkFailedKept']).toContain('{date}')
  })
})

test('TC-020: why a sign-in failed, in words in every language; an unknown code is the plain "could not sign in", never the code', () => {
  expect(flowReasonKey('client')).toBe('integrations.signIn.reason.client')
  expect(flowReasonKey('client_template')).toBe('integrations.signIn.reason.clientTemplate')
  expect(flowReasonKey('denied')).toBe('integrations.signIn.reason.denied')
  expect(flowReasonKey('changed')).toBe('integrations.signIn.reason.changed')
  expect(flowReasonKey('superseded')).toBe('integrations.signIn.reason.superseded')
  expect(flowReasonKey('exchange')).toBe('integrations.signIn.reason.exchange')
  expect(flowReasonKey('invalid')).toBe('integrations.signIn.reason.exchange')
  expect(flowReasonKey('something_new')).toBe('integrations.signIn.failed')
  expect(flowReasonKey(null)).toBe('integrations.signIn.failed')
  // a refused Client ID or Secret says where to look: the Secret under Advanced (고급), in that screen's own words
  for (const l of Object.keys(DICTS) as (keyof typeof DICTS)[]) {
    const words = translate(l, 'integrations.signIn.reason.client')
    expect(words).toContain(translate(l, 'integrations.advanced'))
    expect(words).not.toMatch(/\b(client|exchange|invalid_client)\b/)
    // a template's app: the member cannot see it, so the words send them to whoever set it up, not to Advanced
    const theirs = translate(l, 'integrations.signIn.reason.clientTemplate')
    expect(theirs).not.toContain(translate(l, 'integrations.advanced'))
    expect(theirs).not.toMatch(/\b(client_template|invalid_client)\b/)
  }
})
