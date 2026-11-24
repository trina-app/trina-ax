// The key input a step line shows after a tool's name (shared/src/step-key-input.ts; docs/decisions/
// 20261124-step-key-input.md): chosen by what each argument is called and the tool's schema, never by tool or service,
// and never a secret, an id or an address's query.
import { describe, expect, test } from 'bun:test'
import { keyInputSuffix, opaqueValue, secretArgName, stepKeyInput, stepLabel, stepUrl } from '../../shared/src'

const NO_BROWSER = new Set<string>()

describe('which argument', () => {
  test('a query first, then an address, a path, a command, a name', () => {
    expect(stepKeyInput({ engine: 'google', query: 'YC Korea founders 2025', cursor: '2' })).toEqual({ text: 'YC Korea founders 2025', quoted: true, more: 0 })
    expect(stepKeyInput({ url: 'https://www.linkedin.com/in/jane-doe/?trk=abc', format: 'markdown' })?.text).toBe('linkedin.com/in/jane-doe')
    expect(stepKeyInput({ title: 'Plan', file_path: 'shared/notes/plan.md' })?.text).toBe('shared/notes/plan.md')
    expect(stepKeyInput({ name: 'deploy', command: 'npm run build\nnpm test' })).toEqual({ text: 'npm run build', quoted: false, more: 0 })
    expect(stepKeyInput({ subject: 'Hello', limit: 5 })).toEqual({ text: 'Hello', quoted: true, more: 0 })
    // by the last word of the name, in any spelling
    expect(stepKeyInput({ searchQuery: 'a b' })?.text).toBe('a b')
    expect(stepKeyInput({ 'page-url': 'https://example.com/x' })?.text).toBe('example.com/x')
    // "search_type" is a kind of search, not the search
    expect(stepKeyInput({ search_type: 'web' })).toBeNull()
  })

  test('the schema: required first, then its order; else its first required string', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' }, name: { type: 'string' } }, required: ['name'] }
    expect(stepKeyInput({ title: 'T', name: 'N' }, schema)?.text).toBe('N')
    expect(stepKeyInput({ dataset: 'linkedin_people', limit: 3 }, { properties: { dataset: { type: 'string' } }, required: ['dataset'] })?.text).toBe('linkedin_people')
    // without a schema, an argument no name says anything about stays out
    expect(stepKeyInput({ dataset: 'linkedin_people' })).toBeNull()
  })

  test('a list: its first and how many more', () => {
    expect(stepKeyInput({ urls: ['https://a.example/x', 'https://b.example/y', 'https://c.example/z'] })).toEqual({ text: 'a.example/x', quoted: false, more: 2 })
    expect(keyInputSuffix({ urls: ['https://a.example/x', 'https://b.example/y'] })).toBe(' · a.example/x +1')
  })

  test('nothing to show', () => {
    expect(stepKeyInput(null)).toBeNull()
    expect(stepKeyInput('query')).toBeNull()
    expect(stepKeyInput({ query: '   ' })).toBeNull()
    expect(stepKeyInput({ limit: 10, deep: true })).toBeNull()
    expect(keyInputSuffix({})).toBe('')
  })
})

describe('never a secret', () => {
  test('arguments named like a secret, whatever their value', () => {
    for (const k of ['token', 'api_key', 'apiKey', 'x-api-key', 'password', 'auth', 'authorization', 'auth_header', 'cookie', 'session_id', 'client_secret', 'access_token', 'refreshToken', 'private_key', 'key', 'signature', 'otp'])
      expect([k, secretArgName(k)]).toEqual([k, true])
    for (const k of ['query', 'url', 'path', 'name', 'title', 'keyword']) expect([k, secretArgName(k)]).toEqual([k, false])
    // a secret-named argument that is also "best named" is skipped, the next one shows
    expect(stepKeyInput({ query_token: 'abc def', url: 'https://example.com/a' })?.text).toBe('example.com/a')
    expect(stepKeyInput({ name: 'Report', password: 'hunter22' })?.text).toBe('Report')
    expect(stepKeyInput({ password: 'hunter22' }, { required: ['password'] })).toBeNull()
  })

  test('values that look like a secret or a random id', () => {
    expect(stepKeyInput({ query: 'sk-ant-api03-AbCdEf0123456789xyz' })).toBeNull()
    expect(stepKeyInput({ query: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' })).toBeNull()
    expect(stepKeyInput({ name: '5c6de5a19f3b4e7d8a9b0c1d2e3f4a5b' })).toBeNull()
    expect(stepKeyInput({ name: '0b3a1f2e-5c4d-4e6f-8a7b-9c0d1e2f3a4b' })).toBeNull()
    // the words around a secret stay, the secret goes
    const k = stepKeyInput({ query: 'find leads token=Ab3dE9fG2hJ7kL1mN0pQ' })
    expect(k?.text).toContain('find leads')
    expect(k?.text).not.toContain('Ab3dE9fG2hJ7kL1mN0pQ')
    expect(stepKeyInput({ command: 'curl -H "Authorization: Bearer abcDEF1234567890xyzXYZ" https://api.example.com' })?.text).not.toContain('abcDEF1234567890xyzXYZ')
    expect(opaqueValue('report-2026-10-28-final')).toBe(false)
    // a page's slug is words, not an id (real-app check: the second scraped address showed as "example.com/…/1")
    expect(stepUrl('https://example.com/seoul-ai-startup-founders-seed-2025/1')).toBe('example.com/seoul-ai-startup-founders-seed-2025/1')
    expect(opaqueValue('YC Korea founders 2025')).toBe(false)
  })

  test('an address: host and path only; an id or key in the path as …', () => {
    expect(stepUrl('https://user:pw@www.example.com/a/b?api_key=SECRET123abc#frag')).toBe('example.com/a/b')
    expect(stepUrl('https://mcp.example.com/s/0b3a1f2e-5c4d-4e6f-8a7b-9c0d1e2f3a4b/mcp')).toBe('mcp.example.com/s/…/mcp')
    expect(stepUrl('https://hooks.example.com/T00000/aZ8kQ2xL9mP4vR7tY1wE3nB6/run')).toBe('hooks.example.com/T00000/…/run')
    expect(stepUrl('javascript:alert(1)')).toBeNull()
    expect(stepUrl('not a url')).toBeNull()
    expect(stepKeyInput({ url: 'file:///etc/passwd' })).toBeNull()
  })
})

describe('cut to fit', () => {
  test('words at their end, a path at its start, one line', () => {
    const long = 'word '.repeat(40)
    const k = stepKeyInput({ query: long })!
    expect(k.text.length).toBeLessThanOrEqual(60)
    expect(k.text.endsWith('…')).toBe(true)
    const p = stepKeyInput({ path: 'shared/' + 'deep/'.repeat(20) + 'final-report.md' })!
    expect(p.text.startsWith('…')).toBe(true)
    expect(p.text.endsWith('final-report.md')).toBe(true)
    expect(stepKeyInput({ query: 'a\n\nb\tc' })?.text).toBe('a b c')
    expect(stepUrl('https://example.com/' + 'segment/'.repeat(20))!.length).toBeLessThanOrEqual(60)
  })
})

describe('step lines', () => {
  test("a tool without words of its own: its name and its key input, like Claude Code", () => {
    expect(stepLabel('search_engine', { query: 'YC Korea founders 2025' }, 'en', NO_BROWSER)).toBe('Search engine · "YC Korea founders 2025"')
    expect(stepLabel('scrape_as_markdown', { url: 'https://www.linkedin.com/in/jane-doe' }, 'en', NO_BROWSER)).toBe('Scrape as markdown · linkedin.com/in/jane-doe')
    expect(stepLabel('do_thing', { api_key: 'x' }, 'en', NO_BROWSER)).toBe('Do thing')
  })

  test('built-in tools keep their own lines', () => {
    expect(stepLabel('read', { file_path: 'a/b.md' }, 'en', NO_BROWSER)).toBe('Read · a/b.md')
    expect(stepLabel('grep', { pattern: 'invoice', path: 'finance' }, 'en', NO_BROWSER)).toBe('Search "invoice" · finance')
    // a tool of ours whose line is its words alone stays so (a Drive file by its id means nothing)
    expect(stepLabel('drive_read', { file_id: 'abc', name: 'x' }, 'en', NO_BROWSER)).toBe(stepLabel('drive_read', {}, 'en', NO_BROWSER))
  })
})
