// Stand-ins for Gmail, Calendar, Docs and Sheets tests (server/src/integrations/google-apps/): Google's token, userinfo
// and revoke addresses as an in-process fetch (it can only answer those fixed addresses), and the Google Workspace MCP
// library as a small MCP server on 127.0.0.1 (MYCEL_GOOGLE_APPS_LIBRARY_URL points the server at it). Fake data only.
import crypto from 'node:crypto'
import { GOOGLE_APP_BROKER_SCOPES } from '../../shared/src/cloud-protocol/drive-broker'
import { GOOGLE_REVOKE, GOOGLE_TOKEN, GOOGLE_USERINFO, type DriveFetch } from '../../server/src/integrations/google-drive/client'
import { catalog } from '../../server/src/integrations/google-apps/catalog'
import type { GoogleAppId } from '@mycel/shared/api'

export const APP_CLIENT = { clientId: 'acme-apps.apps.googleusercontent.com', clientSecret: 'CANARY-apps-client-secret-Zq81' }

/** Google's addresses for these tests. The access tokens it hands out are the ones the fake library accepts. */
export class FakeGoogle {
  codes = new Map<string, { challenge: string; who: string; scope: string }>()
  refreshTokens = new Map<string, string>()
  tokenCalls: URLSearchParams[] = []
  revoked: string[] = []
  invalidRefresh = false
  /** the scopes Google grants (default: all the sign-in asked for) */
  grant: ((asked: string) => string) | null = null
  n = 0
  constructor(readonly library: FakeLibrary) {}
  /** the person's consent: the code Google sends back with the state */
  authorize(url: string, who = 'alice') {
    const u = new URL(url), code = 'code-' + crypto.randomBytes(8).toString('hex')
    const asked = u.searchParams.get('scope') ?? ''
    this.codes.set(code, { challenge: u.searchParams.get('code_challenge')!, who, scope: this.grant ? this.grant(asked) : asked })
    return { code, state: u.searchParams.get('state')! }
  }
  issue(who: string) {
    const access = `CANARY-gapp-access-${who}-${++this.n}`
    this.library.tokens.set(access, who)
    return access
  }
  fetch: DriveFetch = async (raw, init = {}) => {
    if (raw === GOOGLE_TOKEN) {
      const body = new URLSearchParams(String(init.body))
      this.tokenCalls.push(body)
      if (body.get('client_id') !== APP_CLIENT.clientId || body.get('client_secret') !== APP_CLIENT.clientSecret) return Response.json({ error: 'invalid_client' }, { status: 401 })
      if (body.get('grant_type') === 'authorization_code') {
        const c = this.codes.get(body.get('code') ?? '')
        this.codes.delete(body.get('code') ?? '')
        if (!c || crypto.createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 })
        const refresh = `CANARY-gapp-refresh-${c.who}-${++this.n}`
        this.refreshTokens.set(refresh, c.who)
        return Response.json({ access_token: this.issue(c.who), refresh_token: refresh, expires_in: 3600, scope: c.scope, token_type: 'Bearer' })
      }
      const who = this.refreshTokens.get(body.get('refresh_token') ?? '')
      if (!who || this.invalidRefresh) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return Response.json({ access_token: this.issue(who), expires_in: 3600, token_type: 'Bearer' })
    }
    if (raw === GOOGLE_USERINFO) {
      const who = this.library.tokens.get(new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? '')
      if (!who) return Response.json({ error: 'denied' }, { status: 401 })
      return Response.json({ sub: `sub-${who}`, name: `${who} Kim`, email: `${who}@acme.example` })
    }
    if (raw === GOOGLE_REVOKE) { this.revoked.push(new URLSearchParams(String(init.body)).get('token') ?? ''); return new Response('') }
    throw new Error('the fake Google refuses ' + raw)
  }
}

export interface LibraryCall { name: string; args: Record<string, any>; token: string; who: string | null }

/** The Google Workspace MCP server as Trina sees it: all four apps' tools (and some it must never offer), every call
 * with a Google access token it checks (unknown: 401). */
export class FakeLibrary {
  tokens = new Map<string, string>()
  calls: LibraryCall[] = []
  requests: { auth: string; method: string }[] = []
  server: ReturnType<typeof Bun.serve> | null = null
  /** an attachment's bytes (get_gmail_attachment_content) */
  attachment = Buffer.from('Quarterly numbers for acme: revenue 42, costs 17.\n')
  /** answer 401 to every token, valid or not (the library's own userinfo check with Google failed: a timeout, Google busy) */
  refuseAll = false
  get url() { return `http://127.0.0.1:${this.server!.port}/mcp` }
  start() {
    this.server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => this.handle(req) })
    return this
  }
  stop() { this.server?.stop(true); this.server = null }
  tools() {
    const apps: GoogleAppId[] = ['gmail', 'calendar', 'docs', 'sheets']
    const out: Record<string, unknown>[] = []
    for (const a of apps) for (const t of catalog(a)) {
      const props: Record<string, unknown> = { user_google_email: { type: 'string' } }
      if (t.name === 'send_gmail_message' || t.name === 'draft_gmail_message') Object.assign(props, { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, attachments: { type: 'array', items: { type: 'object' } } })
      if (t.name === 'get_gmail_attachment_content') Object.assign(props, { message_id: { type: 'string' }, attachment_id: { type: 'string' }, return_base64: { type: 'boolean' } })
      // the library marks the attachment tool as not read-only (it saves a copy in its other modes)
      out.push({ name: t.name, title: t.title, description: `${t.title}.`, inputSchema: { type: 'object', properties: props }, annotations: { readOnlyHint: t.name === 'get_gmail_attachment_content' ? false : !t.changes } })
    }
    // what Trina must never offer: a Drive tool, the library's own sign-in, the full-Drive comment tools
    for (const name of ['search_drive_files', 'start_google_auth', 'manage_document_comment', 'manage_spreadsheet_comment'])
      out.push({ name, description: name, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } })
    return out
  }
  private async handle(req: Request): Promise<Response> {
    const auth = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    const msg = await req.json() as { id?: string; method: string; params?: any }
    this.requests.push({ auth, method: msg.method })
    if (this.refuseAll || !this.tokens.has(auth)) return new Response('unauthorized', { status: 401 })
    if (!msg.id) return new Response(null, { status: 202 })
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: msg.id, result }, { headers: { 'mcp-session-id': 'fake-session' } })
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-workspace', version: '1' } })
    if (msg.method === 'tools/list') return reply({ tools: this.tools() })
    if (msg.method === 'tools/call') {
      const name = msg.params?.name as string, args = (msg.params?.arguments ?? {}) as Record<string, any>
      this.calls.push({ name, args, token: auth, who: this.tokens.get(auth) ?? null })
      if (name === 'get_gmail_attachment_content') {
        const text = ['Attachment downloaded successfully!', `Message ID: ${args.message_id}`, `Size: 0.1 KB (${this.attachment.length} bytes)`, '\n⚠️ Stateless mode: File storage disabled.',
          '\nBase64-encoded content (first 100 characters shown):', `${this.attachment.toString('base64').slice(0, 100)}...`,
          ...(args.return_base64 ? [`\n📦 Base64 content (${this.attachment.toString('base64').length} chars, standard base64):`, this.attachment.toString('base64')] : [])].join('\n')
        return reply({ content: [{ type: 'text', text }] })
      }
      if (name === 'search_gmail_messages') return reply({ content: [{ type: 'text', text: `Found 1 message for ${this.tokens.get(auth)}: "Lunch on Friday" from bob@acme.example` }] })
      return reply({ content: [{ type: 'text', text: `${name} done` }] })
    }
    return Response.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } })
  }
}

/** a person's sign-in session row (the sign-in is bound to it) */
export function sessionRow(db: import('bun:sqlite').Database, user: string, id = `${user}-session`) {
  const now = new Date().toISOString(), later = new Date(Date.now() + 3600_000).toISOString()
  db.query("INSERT OR IGNORE INTO sessions(id,user_id,token_hash,client,created_at,last_seen_at,expires_at) VALUES(?,?,?,'web',?,?,?)").run(id, user, id + '-hash', now, now, later)
  return id
}

export const ALL_SCOPES = (app: GoogleAppId) => GOOGLE_APP_BROKER_SCOPES[app].join(' ')
