// QA TC-4770 (2026-11-17): Atlassian signed in on qa.trina.app, then its connection said "The address answered, but not
// like a connector" and chat said a saved key could not be read. Atlassian answered like any MCP server (the answers
// below are recorded from mcp.atlassian.com/v1/mcp with a working sign-in, cut to two tools). What failed was ours: the
// pattern that hides a connection's tokens (hide.ts) spells out every character in all its forms, and long OAuth tokens
// (Atlassian's v2 sign-in, plus the earlier tokens a server keeps hiding after refreshes) made it larger than Bun's
// regular expressions allow ("regular expression too large"). The check's hider threw (shown as not_mcp) and the
// person's redactor failed with it. Now the hider stays under MAX_PATTERN_CHARS.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { adminAllowsDomains } from '@mycel/shared'
import { HIDDEN, MAX_PATTERN_CHARS, secretHider, secretRegex } from '../../server/src/integrations/connections/hide'
import { McpClient } from '../../server/src/integrations/connections/mcp'
import type { NetRequest, NetResponse } from '../../server/src/integrations/connections/net'
import { redactorOf } from '../../server/src/integrations/connections/redact'

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

describe('long OAuth tokens (QA TC-4770)', () => {
  test('the old way to build the pattern is past what Bun allows for these tokens', () => {
    // the size the full forms of the tokens would take: about 200 pattern characters per token character
    expect(tokens.reduce((n, t) => n + t.length, 0) * 200).toBeGreaterThan(1_500_000)
    expect(() => secretRegex(tokens)).not.toThrow()
    expect(secretRegex(tokens)!.source.length).toBeLessThanOrEqual(MAX_PATTERN_CHARS)
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
    const hide = secretHider([...tokens, short])
    const t = tokens[3]!
    for (const form of [t, `Bearer ${t}`, JSON.stringify({ t }).replace(/\//g, '\\/'), Buffer.from(t).toString('base64'), Buffer.from(`user:${t}`).toString('base64'), encodeURIComponent(t)]) {
      const out = hide(`a ${form} b`)
      expect(out).toContain(HIDDEN)
      expect(out).not.toContain(t.slice(40, 80))
    }
    // the short key is matched in all its forms, its letters %-escaped too (c-integrations-echo.test.ts)
    expect(hide([...short].map((c) => '%' + c.charCodeAt(0).toString(16)).join(''))).toBe(HIDDEN)
    expect(hide('ordinary words stay')).toBe('ordinary words stay')
  })

  test("the person's redactor of many connections builds, and hides each one's tokens", () => {
    const others = Array.from({ length: 40 }, () => b64url(90))
    const r = redactorOf([...tokens, ...others])
    expect(r.re).not.toBeNull()
    expect(r.hide(`x ${others[7]} y ${tokens[0]} z`)).toBe(`x ${HIDDEN} y ${HIDDEN} z`)
  })
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
