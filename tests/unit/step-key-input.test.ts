// The key input a step line shows after a tool's name (shared/src/step-key-input.ts; docs/decisions/
// 20261124-step-key-input.md): chosen by what each argument is called and the tool's schema, never by tool or service,
// and never a secret, an id or an address's query.
import { describe, expect, test } from 'bun:test'
import { choiceArg, keyInputSuffix, opaqueValue, secretArgName, stepKeyInput, stepLabel, stepUrl } from '../../shared/src'

const NO_BROWSER = new Set<string>()

describe('the item, never the verb (QA: Google Calendar · 일정 관리 · "create")', () => {
  // workspace-mcp manage_event: `action` is required and first, the event's title is `summary`
  const manageEvent = { type: 'object', properties: { action: { type: 'string' }, summary: { type: 'string' }, start_time: { type: 'string' }, event_id: { type: 'string' } }, required: ['action'] }
  test('an event created: its title, not the action', () => {
    expect(keyInputSuffix({ action: 'create', summary: 'QA 카드 확인2', start_time: '2026-11-27T15:00:00', timezone: 'Asia/Seoul' }, manageEvent)).toBe(' · "QA 카드 확인2"')
  })
  test('an event deleted by its id only: nothing, not "delete"', () => {
    expect(keyInputSuffix({ action: 'delete', event_id: 'abc123def456ghi789jkl012' }, manageEvent)).toBe('')
  })
  test('any tool: a required choice argument is never the key input, by its name or its schema', () => {
    for (const k of ['action', 'operation', 'mode', 'op', 'method', 'sheet_action', 'labelType', 'kind', 'format'])
      expect(stepKeyInput({ [k]: 'update' }, { properties: { [k]: { type: 'string' } }, required: [k] })).toBeNull()
    // an enum (or a oneOf of consts) of any name is a choice too
    expect(stepKeyInput({ what: 'append' }, { properties: { what: { type: 'string', enum: ['append', 'replace'] } }, required: ['what'] })).toBeNull()
    expect(stepKeyInput({ what: 'append' }, { properties: { what: { anyOf: [{ const: 'append' }, { const: 'replace' }, { type: 'null' }] } }, required: ['what'] })).toBeNull()
    // the next required argument that is a name still shows
    expect(stepKeyInput({ mode: 'append', dataset: 'linkedin_people' }, { properties: { mode: { type: 'string' }, dataset: { type: 'string' } }, required: ['mode', 'dataset'] })?.text).toBe('linkedin_people')
    // an issue's summary (Jira) and a headline are titles
    expect(stepKeyInput({ project: 'QA', summary: 'Card shows the verb' })?.text).toBe('Card shows the verb')
    expect(stepKeyInput({ headline: 'Launch' })?.text).toBe('Launch')
  })
  test('choiceArg', () => {
    expect(choiceArg('action')).toBe(true)
    expect(choiceArg('event_action')).toBe(true)
    expect(choiceArg('summary')).toBe(false)
    expect(choiceArg('dataset', { properties: { dataset: { type: 'string' } } })).toBe(false)
    expect(choiceArg('dataset', { properties: { dataset: { type: 'string', enum: ['a', 'b'] } } })).toBe(true)
  })
})

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
    // one long run without a space, dot or slash is no words: never shown
    expect(stepKeyInput({ query: 'CANARY-' + 'k'.repeat(60) })).toBeNull()
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

describe('secrets come out before the cut (review of #513)', () => {
  const noPart = (text: string | undefined, secret: string) => { for (let n = 6; n <= secret.length; n++) for (let i = 0; i + n <= secret.length; i += 3) expect(text ?? '').not.toContain(secret.slice(i, i + n)) }
  test('a key that straddles the 60-character cut leaves no part of itself', () => {
    const gh = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    for (let pad = 30; pad <= 62; pad += 4) {
      const k = stepKeyInput({ query: 'find the founders '.padEnd(pad, '.') + ' please: ' + gh })
      noPart(k?.text, gh)
    }
    const bearer = 'abcDEF1234567890xyzXYZ7788'
    for (let pad = 20; pad <= 60; pad += 5) noPart(stepKeyInput({ command: `curl -s https://api.example.com/${'v'.repeat(pad)} -H "Authorization: Bearer ${bearer}"` })?.text, bearer)
    const aws = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    for (let pad = 20; pad <= 60; pad += 5) noPart(stepKeyInput({ text: `${'set the key '.padEnd(pad, '.')} aws_secret_access_key=${aws}` })?.text, aws)
  })

  test('short passwords after a flag, a session id in a path, file: and other schemes, invisible characters', () => {
    expect(stepKeyInput({ command: 'mysql -u root -pS3cr3t! shop' })?.text).toBe('mysql -u root -p… shop')
    expect(stepKeyInput({ command: 'tool --password=hunter2 --user bob' })?.text).toBe('tool --password=… --user bob')
    expect(stepKeyInput({ command: 'tool --token abc123 run' })?.text).toBe('tool --token … run')
    expect(stepKeyInput({ command: 'mkdir -p out' })?.text).toBe('mkdir -p out')
    expect(stepUrl('https://shop.example.com/cart;jsessionid=A1B2C3D4/view')).toBe('shop.example.com/cart/view')
    expect(stepKeyInput({ name: 'file:///Users/alice/.ssh/id_rsa' })).toBeNull()
    expect(stepKeyInput({ query: 'data:text/html;base64,PHNjcmlwdD4=' })).toBeNull()
    expect(stepKeyInput({ query: 'Note: plain words' })?.text).toBe('Note: plain words')
    expect(stepKeyInput({ query: 'invoice \u202Egpj.exe\u200B list' })?.text).toBe('invoice gpj.exe list')
  })
})

describe('re-review of #513: AWS keys, -u user:password, -p only where it is a password, addresses only', () => {
  test('an AWS access key id and its secret key with no label', () => {
    const k = stepKeyInput({ query: 'AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' })
    expect(k).toBeNull()
    const t = stepKeyInput({ query: 'use AKIAIOSFODNN7EXAMPLE and wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY for the bucket' })!.text
    expect(t).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(t).not.toContain('wJalrXUtnFEMI')
    expect(t).toContain('for the bucket')
    expect(stepKeyInput({ query: 'ASIAY34FZKBOKMUTVV7A temp' })?.text).not.toContain('ASIAY34FZKBOKMUTVV7A')
  })
  test('curl -u / --user: the password after the colon', () => {
    expect(stepKeyInput({ command: 'curl -u admin:hunter2 https://api.example.com/x' })?.text).toBe('curl -u admin:… https://api.example.com/x')
    expect(stepKeyInput({ command: 'curl --user=admin:hunter2 https://api.example.com' })?.text).toBe('curl --user=admin:… https://api.example.com')
    expect(stepKeyInput({ command: 'curl -u admin https://api.example.com' })?.text).toBe('curl -u admin https://api.example.com')
  })
  test('-p<password> only for the clients that take one there; -print and -pthread stay', () => {
    expect(stepKeyInput({ command: 'find . -name "*.md" -print' })?.text).toBe('find . -name "*.md" -print')
    expect(stepKeyInput({ command: 'gcc -pthread -o app main.c' })?.text).toBe('gcc -pthread -o app main.c')
    expect(stepKeyInput({ command: 'mysqldump -u root -pS3cr3t! shop > a.sql' })?.text).toBe('mysqldump -u root -p… shop > a.sql')
    expect(stepKeyInput({ command: 'cd db && mysql -uroot -phunter2 shop' })?.text).toBe('cd db && mysql -uroot -p… shop')
    expect(stepKeyInput({ command: 'sshpass -p hunter2 ssh a@b' })?.text).toBe('sshpass -p … ssh a@b')
    expect(stepKeyInput({ command: 'mysql -p shop' })?.text).toBe('mysql -p shop')
  })
  test('a scheme is an address only with no space after it', () => {
    expect(stepKeyInput({ query: 'javascript: closures tutorial' })?.text).toBe('javascript: closures tutorial')
    expect(stepKeyInput({ query: 'javascript:alert(1)' })).toBeNull()
    expect(stepKeyInput({ name: 'file:///Users/alice/.ssh/id_rsa' })).toBeNull()
  })
})

describe('code is never the key input (owner 2026-11-24: people are not developers)', () => {
  test('an argument that holds code: its address at most', () => {
    expect(stepKeyInput({ script: 'await page.goto("https://example.com/pricing") // $(id)' })?.text).toBe('example.com/pricing')
    expect(stepKeyInput({ code: 'print(1 + 1)' })).toBeNull()
    expect(stepKeyInput({ javascript: 'document.title' }, { required: ['javascript'] })).toBeNull()
    expect(stepKeyInput({ expression: 'a && b' })).toBeNull()
    expect(stepKeyInput({ source: 'def f(): return 1' }, { required: ['source'] })).toBeNull()
    // the other arguments still show
    expect(stepKeyInput({ script: 'x()', name: 'Pricing check' })?.text).toBe('Pricing check')
  })
  test('a value that looks like code, under any name: its address at most', () => {
    expect(stepKeyInput({ query: 'SELECT * FROM users' })).toBeNull()
    expect(stepKeyInput({ text: 'page.click("#buy")' })).toBeNull()
    expect(stepKeyInput({ query: 'fetch("https://api.example.com/v1/x").then(r => r.json())' })?.text).toBe('api.example.com/v1/x')
    expect(stepKeyInput({ query: 'YC Korea founders (2025)' })?.text).toBe('YC Korea founders (2025)')
  })
  test('a shell command still shows, as in Claude Code', () => {
    expect(stepKeyInput({ command: 'npm run build && npm test' })?.text).toBe('npm run build && npm test')
  })
})

