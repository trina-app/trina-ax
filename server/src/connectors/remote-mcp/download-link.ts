// App connectors: create_download_link + GET /connector-downloads/<token>, the mirror of create_upload_link
// (upload-link.ts). A connected client that can run shell commands (Claude Code) fetches a team file's exact bytes with
// curl, changes it with local tools and puts it back with create_upload_link (overwrite). `read` gives numbered lines
// for the model, which cannot be written to a file as they are.
//
// A link is bound to the connection (grant), the person, the path as authorized and the file's version at link time
// (inode, size, mtime). It works for LINK_MS and at most DOWNLOAD_LIMITS.uses times (a retry or a resumed download).
// Making the link runs the read tool's check (authorize 'read' with the current folder rules: a folder the person may
// not see, a link, a quarantined output and a missing file are all refused), and so does every GET, with the grant as
// it is then. Any refusal on the GET is the same 404: unknown, used, expired, changed, access lost, connection ended.
// Only the token's sha256 is stored; the token is never logged (http/middleware.ts loggablePath) or audited.
import type { AppContext } from '../../context'
import type { Principal } from '../../policy/access'
import { z } from 'zod'
import { authorize } from '../../policy/authorize'
import { Denied, ToolError } from '../../policy/errors'
import { audit } from '../../admin/audit'
import { touchActivity } from '../../system/activity'
import { streamFile } from '../../team-files/download'
import { HttpError } from '../../http/errors'
import { hash, OAuthError, secret } from './policy'
import { remoteOAuthOf, type Grant, type RemoteOAuth } from './oauth'
import { fail, type UploadOutcome } from './upload'

/** Public path of the download links (outside /api: no cookie session; the token is the auth). */
export const DOWNLOAD_PATH = '/connector-downloads/'
export const DOWNLOAD_MS = 10 * 60_000
/** uses: GETs one link answers (a retry, a resumed download). Tests lower the values. */
export const DOWNLOAD_LIMITS = { uses: 3, perGrantPerMinute: 10, openPerGrant: 20 }
const TOKEN = /^tax_dl_[A-Za-z0-9_-]{43}$/

export const CreateDownloadLinkInput = z.object({
  path: z.string().min(1).max(1000).describe('The team file to download, relative to the team root, e.g. "shared/report.md".'),
}).strict()

const schema = z.toJSONSchema(CreateDownloadLinkInput, { target: 'draft-7' }) as Record<string, unknown>
delete schema.$schema
export const downloadLinkTool = {
  name: 'create_download_link',
  description: 'Get a short-lived HTTPS link to download a team file (any type, any size) as its exact bytes to this computer. ' +
    'Use it when you can run shell commands (for example in Claude Code) and want to work on the file with local tools: download, change it locally, ' +
    'then put it back with create_upload_link (overwrite: true). The result has the URL and a command: run curl -o "<local file>" "<url>". ' +
    `The link is for this file as it is now, for 10 minutes, and works at most ${DOWNLOAD_LIMITS.uses} times; it stops working when the file changes or the person loses access. ` +
    'The permissions are checked now and again at download time. Do not show or share the URL: anyone with it can download the file. Without a shell (claude.ai, Claude Desktop) this tool does not help: use read.',
  inputSchema: schema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}

type LinkRow = { hash: string; grant_id: string; user_id: string; path: string; ino: string; size: number; mtime_ms: number; created_at: number; expires_at: number; uses: number; max_uses: number }

/** The read check of the read tool: the folder rules now, an existing regular file, never through a link. Throws. */
function readable(ctx: AppContext, user: Principal, filePath: string) {
  const r = authorize(ctx.files.fx, ctx.files.rules(), user, filePath, 'read')
  if (r.st!.isDirectory()) throw new ToolError(`'${r.rel}' is a folder; download its files one by one`, 'is_folder')
  if (!r.st!.isFile() || r.st!.nlink > 1) throw new Denied(`not found or no access: '${filePath}'`)
  return r
}

/** create_download_link: the scope check ran in RemoteTools.call. `join`: puts the authorized path into the session's
 * read scope (tools.ts), as a read does, before the link exists; its refusal (a full scope) is the answer. */
export function createDownloadLink(ctx: AppContext, oauth: RemoteOAuth, grant: Grant, user: Principal, args: unknown, join: (rel: string) => string | null): UploadOutcome {
  const input = CreateDownloadLinkInput.safeParse(args ?? {})
  if (!input.success) return fail('Invalid tool input: send path.')
  const filePath = input.data.path
  try { oauth.rate('download-link-grant', grant.id, DOWNLOAD_LIMITS.perGrantPerMinute) } catch (e) {
    if (e instanceof OAuthError) return fail('Too many download links for this connection; retry in a minute.')
    throw e
  }
  const now = oauth.now()
  const open = ctx.db.query('SELECT count(*) AS n FROM remote_mcp_download_links WHERE grant_id=? AND uses<max_uses AND expires_at>?').get(grant.id, now) as { n: number }
  if (open.n >= DOWNLOAD_LIMITS.openPerGrant) return fail('Too many open download links for this connection; use them or wait 10 minutes.')
  let r: ReturnType<typeof readable>
  try { r = readable(ctx, user, filePath) } catch (e) {
    if (e instanceof Denied || e instanceof ToolError) return fail(`Cannot make a download link: ${e.message}`, { path: filePath.slice(0, 500), reason: e instanceof Denied ? 'denied' : e.code })
    throw e
  }
  const full = join(r.rel)
  if (full) return fail(full, { path: r.rel, reason: 'scope_full' })
  const st = r.st!, token = secret('tax_dl_'), expires = now + DOWNLOAD_MS
  ctx.db.query('INSERT INTO remote_mcp_download_links(hash,grant_id,user_id,path,ino,size,mtime_ms,created_at,expires_at,uses,max_uses) VALUES(?,?,?,?,?,?,?,?,?,0,?)')
    .run(hash(token), grant.id, user.id, r.rel, String(st.ino), st.size, st.mtimeMs, now, expires, DOWNLOAD_LIMITS.uses)
  const url = oauth.enabled() + DOWNLOAD_PATH + token, expiresAt = new Date(expires).toISOString()
  const out = {
    url, method: 'GET', path: r.rel, size: st.size, uses: DOWNLOAD_LIMITS.uses, expiresAt,
    command: `curl --fail -o "<local file>" "${url}"`,
    note: 'Replace <local file> with a local file path. Put a changed file back with create_upload_link (overwrite: true). Do not show the URL to anyone.',
  }
  // The audit row never holds the token or its hash.
  return { text: JSON.stringify(out), audit: { path: r.rel, size: st.size, expiresAt } }
}

const noStore = { 'cache-control': 'no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer' }
const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...noStore } })
const gone = () => reply({ error: 'invalid_link', message: 'This download link is unknown, used, expired or no longer valid (the file changed or access ended). Ask for a new link with create_download_link.' }, 404)

/**
 * GET /connector-downloads/<token>. The token is the only auth. One use is taken in one statement before anything else;
 * then the grant (revoked, expired, session ended, mcp:read, the same person), the person's current read permission
 * on the link's path and the file's version are checked. The bytes come from the one descriptor of the very file the
 * check saw (team-files/download.ts streamFile: never through a link). Every GET is audited (remote_mcp.download).
 */
export async function linkDownload(ctx: AppContext, request: Request, token: string, ip: string | null, o: { via?: string } = {}, oauth: RemoteOAuth = remoteOAuthOf(ctx)): Promise<Response> {
  try {
    const origin = request.headers.get('origin')
    // a live link is the auth: it is not counted with anonymous traffic, so a flood cannot stop it
    const liveLink = TOKEN.test(token) && (origin ?? oauth.origin) === oauth.origin && !!ctx.db.query('SELECT 1 FROM remote_mcp_download_links WHERE hash=? AND uses<max_uses AND expires_at>?').get(hash(token), oauth.now())
    oauth.ingress('download', ip, { shared: !liveLink })
    // curl sends no Origin. A page on another site must not read a link it saw.
    if (origin !== null && origin !== oauth.origin) return reply({ error: 'access_denied' }, 403)
    if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405)
    if (!TOKEN.test(token)) return gone()
    const now = oauth.now()
    const link = ctx.db.query('UPDATE remote_mcp_download_links SET uses=uses+1 WHERE hash=? AND uses<max_uses AND expires_at>? RETURNING *').get(hash(token), now) as LinkRow | null
    if (!link) return gone()
    const record = (ok: boolean, detail: Record<string, unknown>) => audit(ctx.db, { actor: link.user_id, action: 'remote_mcp.download', target: link.grant_id, detail: { via: 'connector_link', ok, path: link.path, use: link.uses, ...detail } })
    let grant: Grant
    try { grant = oauth.grant(link.grant_id) } catch { record(false, { reason: 'connection' }); return gone() }
    if (grant.user_id !== link.user_id || !(JSON.parse(grant.scopes) as string[]).includes('mcp:read')) { record(false, { reason: 'connection' }); return gone() }
    let user: Principal
    try { user = ctx.files.principal(grant.user_id) } catch { record(false, { reason: 'connection' }); return gone() }
    let r: ReturnType<typeof readable>
    try { r = readable(ctx, user, link.path) } catch (e) {
      if (e instanceof Denied || e instanceof ToolError) { record(false, { reason: 'access' }); return gone() }
      throw e
    }
    const st = r.st!
    if (r.rel !== link.path || String(st.ino) !== link.ino || st.size !== link.size || st.mtimeMs !== link.mtime_ms) { record(false, { reason: 'changed' }); return gone() }
    // a download through a live link is use of the team (system/activity.ts)
    touchActivity()
    let res: Response
    try {
      res = await streamFile({ abs: r.abs, seen: st, name: r.segs[r.segs.length - 1]!, req: request, disposition: 'attachment', via: o.via })
    } catch (e) {
      // the file was swapped between the check and the open (place.ts openChecked), or a bad Range
      if (e instanceof Denied || e instanceof ToolError) { record(false, { reason: 'changed' }); return gone() }
      throw e
    }
    for (const [k, v] of Object.entries(noStore)) res.headers.set(k, v)
    record(true, { size: st.size, status: res.status })
    return res
  } catch (e) {
    if (e instanceof OAuthError) return reply({ error: e.code }, e.status)
    if (e instanceof HttpError && e.status === 416) return reply({ error: 'range_not_satisfiable' }, 416)
    ctx.log.warn('connector download failed', { err: e instanceof Error ? e.name : 'error' })
    return reply({ error: 'server_error' }, 500)
  }
}
