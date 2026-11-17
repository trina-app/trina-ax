// QA TC-4770 (2026-11-17): Atlassian signed in on qa.trina.app, then its connection said "The address answered, but not
// like a connector" and chat said a saved key could not be read. Atlassian answered like any MCP server (the answers
// below are recorded from mcp.atlassian.com/v1/mcp with a working sign-in, cut to two tools). What failed was ours: the
// pattern that hides a connection's tokens (hide.ts) spells out every character in all its forms, and long OAuth tokens
// (Atlassian's v2 sign-in, plus the earlier tokens a server keeps hiding after refreshes) made it larger than Bun's
// regular expressions allow ("regular expression too large"). The check's hider threw (shown as not_mcp) and the
// person's redactor failed with it. Now the hider stays under MAX_PATTERN_CHARS.
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import crypto from 'node:crypto'
import { adminAllowsDomains } from '@mycel/shared'
import { clearSecretCache, errorForLog, HIDDEN, LONG_SECRET, MAX_GROUP_CHARS, secretHider, secretRegexes, SecretTooLarge } from '../../server/src/integrations/connections/hide'
import { McpClient } from '../../server/src/integrations/connections/mcp'
import type { NetRequest, NetResponse } from '../../server/src/integrations/connections/net'
import { RedactingText, redactorFor, redactorOf } from '../../server/src/integrations/connections/redact'
import * as service from '../../server/src/integrations/connections/service'
import type { AppContext } from '../../server/src/context'

/** recorded 2026-11-17 (headers cut to what the client reads; serverInfo's icon left out) */
const INITIALIZE = 'event: message\ndata: {"result":{"protocolVersion":"2025-06-18","capabilities":{"logging":{},"tools":{"listChanged":true}},"serverInfo":{"name":"atlassian-mcp-server","version":"1.0.0"}},"jsonrpc":"2.0","id":"ID"}\n\n'
const TOOLS = '[{"name":"atlassianUserInfo","description":"Get current user info","inputSchema":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{}},"annotations":{"title":"Get current user info","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false},"execution":{"taskSupport":"forbidden"}},{"name":"getJiraIssue","description":"Get issue details. Use getTeamworkGraphContext to get linked deployments, PRs, builds, branches, commits, designs, issues, confluence whiteboards, feature flags, vulnerabilities, sprints and remote links to Jira Issues.","inputSchema":{"type":"object","properties":{"cloudId":{"type":"string","description":"Cloud ID (UUID or site URL)"},"issueIdOrKey":{"type":"string","description":"Issue ID or key (e.g., PROJ-123 or 10000)"},"fields":{"type":"array","items":{"type":"string"},"description":"Issue fields to return. When omitted or empty, defaults to: summary, description, status, issuetype, priority, labels, components, assignee, reporter, created, updated, resolution, project. Pass \\"*all\\" to return every field (including custom fields). Include \\"comment\\" to fetch issue comments in fields.comment.comments."},"fieldsByKeys":{"type":"boolean","description":"Whether fields in the request are referenced by field keys instead of IDs."},"expand":{"type":"string","description":"Additional issue details to expand in the response (for example, renderedFields or names)."},"properties":{"type":"array","items":{"type":"string"},"description":"Issue property keys to include in the response."},"updateHistory":{"type":"boolean","description":"Whether to update the user\'s recently viewed projects/history for this issue request."},"failFast":{"type":"boolean","description":"Whether to fail quickly when some fields cannot be loaded instead of partially returning data."},"responseContentFormat":{"type":"string","enum":["markdown","adf"],"description":"Content format for body content. Use \\"markdown\\" for simplified plain text. Use \\"adf\\" (Atlassian Document Format, JSON) for full programmatic fidelity. Defaults vary by tool when omitted."},"actionSource":{"type":"string","enum":["jira_mcp_card","model_tool_call"],"description":"Invocation attribution. Set to jira_mcp_card when called from a Jira MCP Widget UI; omit or set to model_tool_call for model/tool-loop calls."}},"required":["cloudId","issueIdOrKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"},"annotations":{"title":"Get issue","readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false},"execution":{"taskSupport":"forbidden"}}]'
const TOOLS_LIST = `event: message\ndata: {"result":{"tools":${TOOLS}},"jsonrpc":"2.0","id":"ID"}\n\n`
const SSE = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'mcp-session-id': 'r4-00000000-0000-4000-8000-000000000000' }

/** Atlassian's answers to the client's requests, as recorded */
async function atlassian(_url: string, r: NetRequest): Promise<NetResponse> {
  const m = JSON.parse(r.body!.toString())
  if (!('id' in m)) return { status: 202, headers: {}, body: Buffer.alloc(0), truncated: false }
  const body = m.method === 'initialize' ? INITIALIZE : m.method === 'tools/list' ? TOOLS_LIST : ''
  return { status: 200, headers: SSE, body: Buffer.from(body.replace('"id":"ID"', `"id":${JSON.stringify(m.id)}`)), truncated: false }
}

const b64url = (n: number) => crypto.randomBytes(n).toString('base64url')
/** a JWT-shaped token about 3,300 characters long */
const jwt = () => `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${b64url(2200)}.${b64url(256)}`
/** what one connection's hider holds after a day of refreshes: 16 values (service.ts RECENT_SECRETS), access and refresh
 * tokens of the v2 sign-in */
const tokens = Array.from({ length: 16 }, jwt)

const basic = (t: string) => Buffer.from(`user:${t}`).toString('base64')
/** the token's base64 is hidden: HIDDEN is there, and nothing past the bytes that share a group with "user:" */
const hidesBasic = (hide: (s: string) => string, t: string) => { const out = hide(basic(t)); return out.includes(HIDDEN) && !out.includes(basic(t).slice(12, 60)) }

describe('long OAuth tokens (QA TC-4770)', () => {
  afterEach(() => clearSecretCache())

  test("one connection's 16 tokens: patterns in groups under the limit, each token in every kept form", () => {
    const res = secretRegexes(tokens)
    expect(res.length).toBeGreaterThan(0)
    for (const re of res) expect(re.source.length).toBeLessThanOrEqual(MAX_GROUP_CHARS)
    const hide = secretHider(tokens)
    for (const t of tokens) expect(hidesBasic(hide, t)).toBe(true)
  })

  test("a check of Atlassian's recorded answers reads its tools with a hider of those tokens", async () => {
    const auth = async (): Promise<[string, string][]> => [['Authorization', `Bearer ${tokens.at(-1)}`]]
    const client = new McpClient('https://mcp.atlassian.com/v2/mcp', auth, {}, () => secretHider(tokens), atlassian)
    const listed = await client.listTools()
    expect(listed.tools.map((t) => t.name)).toEqual(['atlassianUserInfo', 'getJiraIssue'])
    expect(listed.tools[1]!.inputSchema.required).toEqual(['cloudId', 'issueIdOrKey'])
    expect(client.sessionId).toBe(SSE['mcp-session-id'])
    expect(client.version).toBe('2025-06-18')
  })

  test('the long tokens are still hidden as written, as Bearer, JSON-escaped and in base64; a short key keeps every form', () => {
    const short = 'CANARY/echo+key=7731&x'
    expect(short.length).toBeLessThan(LONG_SECRET)
    const hide = secretHider([...tokens, short])
    const t = tokens[3]!
    for (const form of [t, `Bearer ${t}`, JSON.stringify({ t }).replace(/\//g, '\\/'), Buffer.from(t).toString('base64'), basic(t), encodeURIComponent(t)]) {
      const out = hide(`a ${form} b`)
      expect(out).toContain(HIDDEN)
      expect(out).not.toContain(t.slice(40, 80))
    }
    // the short key is matched in all its forms, its letters %-escaped too (c-integrations-echo.test.ts)
    expect(hide([...short].map((c) => '%' + c.charCodeAt(0).toString(16)).join(''))).toBe(HIDDEN)
    expect(hide('ordinary words stay')).toBe('ordinary words stay')
  })

  test('10 connections x 16 tokens of 3,314 characters: it builds, and basic-auth base64 of every token is hidden', () => {
    const many = Array.from({ length: 160 }, jwt)
    expect(many.every((t) => t.length === 3314)).toBe(true)
    const t0 = performance.now()
    const hide = secretHider(many)
    const cold = performance.now() - t0
    const missed = many.filter((t) => !hidesBasic(hide, t))
    expect(missed.length).toBe(0)
    // the same values again: the built chain is kept
    const t1 = performance.now()
    secretHider([...many].reverse())
    expect(performance.now() - t1).toBeLessThan(Math.max(50, cold / 10))
  })

  test("the protection of one token does not depend on the others", () => {
    const t = tokens[0]!
    const alone = secretRegexes([t]).map((r) => r.source).join('|')
    const crowd = secretRegexes([...tokens, ...Array.from({ length: 64 }, jwt)]).map((r) => r.source).join('|')
    expect(crowd).toContain(alone)
  })

  test('one 500,000-character value: SecretTooLarge naming only its length; the person\'s redactor withholds', () => {
    const huge = b64url(375_000)
    expect(huge.length).toBe(500_000)
    let err: unknown
    try { secretHider([huge]) } catch (e) { err = e }
    expect(err).toBeInstanceOf(SecretTooLarge)
    expect((err as Error).message).toBe('a stored secret of 500000 characters is too large to hide')
    expect((err as Error).message).not.toContain(huge.slice(0, 20))
    expect(() => redactorOf([huge])).toThrow(SecretTooLarge)
    // a long token-like run in an error message never reaches the log
    expect(errorForLog(new SyntaxError(`Unexpected identifier "${tokens[0]!.slice(0, 60)}"`))).toBe('SyntaxError: Unexpected identifier "[…]"')
  })

  test('redactorFor with a value that is too large returns a withholding redactor, never one that lets text out', () => {
    const huge = b64url(375_000)
    const warned: unknown[] = []
    const ctx = { db: { query: () => ({ get: () => ({ 1: 1 }) }) }, log: { warn: (...a: unknown[]) => warned.push(a) } } as unknown as AppContext
    const spy = spyOn(service, 'integrationsOf').mockReturnValue({ secretsFor: () => [huge, tokens[0]!] } as unknown as service.Integrations)
    try {
      const r = redactorFor(ctx, 'alice')
      expect(r.withheld).toBe(true)
      expect(r.hide(`a ${huge} b`)).toBe(service.WITHHELD)
      expect(r.hide('anything at all')).toBe(service.WITHHELD)
      expect(r.hide('')).toBe('')
      // the stream lets out the marker once, nothing of the text
      const s = new RedactingText(() => r)
      const out = [s.push('hello '), s.push(huge.slice(0, 50)), s.flush()].join('')
      expect(out).toBe(service.WITHHELD)
      expect(JSON.stringify(warned)).toContain('SecretTooLarge')
      expect(JSON.stringify(warned)).not.toContain(huge.slice(0, 20))
    } finally { spy.mockRestore() }
  })

  test('the stream redactor hides a token split across pieces, with the tokens in several groups', () => {
    const many = Array.from({ length: 24 }, jwt)
    const r = redactorOf(many)
    expect(r.res.length).toBeGreaterThan(1)
    for (const t of [many[0]!, many.at(-1)!]) {
      for (const form of [t, basic(t)]) {
        const text = `before ${form} after`
        for (const n of [97, 500, 3000]) {
          const s = new RedactingText(() => r)
          const pieces: string[] = []
          for (let i = 0; i < text.length; i += n) pieces.push(s.push(text.slice(i, i + n)))
          pieces.push(s.flush())
          expect(pieces.join('')).toBe(r.hide(text))
          expect(pieces.join('')).toContain(HIDDEN)
          for (const p of pieces) expect(p).not.toContain(form.slice(-24))
        }
      }
    }
  }, 60_000)
})

describe("Atlassian's blocked-domain page (QA TC-4770)", () => {
  test('the sign-in wait explains it for both official Atlassian addresses only', () => {
    expect(adminAllowsDomains('https://mcp.atlassian.com/v2/mcp')).toBe(true)
    expect(adminAllowsDomains('https://mcp.atlassian.com/v1/mcp/')).toBe(true)
    expect(adminAllowsDomains('https://mcp.notion.com/mcp')).toBe(false)
    expect(adminAllowsDomains('https://mcp.atlassian.com.evil.example/v2/mcp')).toBe(false)
    expect(adminAllowsDomains('not a url')).toBe(false)
  })
})
