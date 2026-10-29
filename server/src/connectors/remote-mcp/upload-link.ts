import fs from 'node:fs'
import crypto from 'node:crypto'
import { z } from 'zod'
import { SMALL_UPLOAD_MAX } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import type { Principal } from '../../policy/access'
import type { ReadSource } from '../../chat/read-scope'
import { audit } from '../../admin/audit'
import { boundedBody } from '../../http/route'
import { HttpError } from '../../http/errors'
import { hash, OAuthError, secret } from './policy'
import { remoteOAuthOf, type Grant, type RemoteOAuth } from './oauth'
import { checkUploadTarget, fail, isOutcome, placeConnectorUpload, uploadFailure, uploadTmp, type UploadOutcome } from './upload'

/** Public path of the one-time upload links (outside /api: no cookie session, no CSRF header; the token is the auth). */
export const LINK_PATH = '/connector-uploads/'
export const LINK_MS = 10 * 60_000
/**
 * Limits of the upload links. maxBytes: 200 MiB or the server's largest request body (SMALL_UPLOAD_MAX, 50 MiB, set
 * by Bun's maxRequestBodySize in main.ts), whichever is lower. Tests lower the values.
 */
export const LINK_LIMITS = { maxBytes: Math.min(200 * 1024 * 1024, SMALL_UPLOAD_MAX), perGrantPerMinute: 10, openPerGrant: 20 }
const TOKEN = /^tax_up_[A-Za-z0-9_-]{43}$/
const mib = (n: number) => Math.round(n / 1024 / 1024)

export const CreateUploadLinkInput = z.object({
  path: z.string().min(1).max(1000).describe('Target file path relative to the team root, e.g. "groups/sales/video.mp4". Missing folders are created when you may write there.'),
  overwrite: z.boolean().optional().describe('Replace an existing file at path. The old file is kept as a version. Default false: a name clash saves the upload as "name (2).ext".'),
  size: z.number().int().min(0).optional().describe('Expected file size in bytes (optional). A file that is too large is refused now, not after the upload.'),
}).strict()

const schema = z.toJSONSchema(CreateUploadLinkInput, { target: 'draft-7' }) as Record<string, unknown>
delete schema.$schema
export const uploadLinkTool = {
  name: 'create_upload_link',
  description: 'Get a one-time HTTPS link to upload a large local file (over about 50 KB, any type) to the team drive. ' +
    'Use this instead of upload_file when you can run shell commands (for example in Claude Code): you do not type the bytes. ' +
    'The permissions are checked now and again at upload time. The result has the URL and a command: run curl -T "<local file>" "<url>". ' +
    `The link works once, for this path only, for 10 minutes, for at most ${mib(LINK_LIMITS.maxBytes)} MiB. ` +
    'The upload answers with JSON: the saved path, the size, and conflictCopy (true when the file was saved as "name (2).ext"). ' +
    'Do not show or share the URL: anyone with it can upload once. Without a shell (claude.ai, Claude Desktop) this tool does not help.',
  inputSchema: schema,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}

type LinkRow = { hash: string; grant_id: string; user_id: string; path: string; overwrite: number; max_bytes: number; created_at: number; expires_at: number; used_at: number | null }

/** create_upload_link: the scope check ran in RemoteTools.call. The write checks run now; the PUT runs them again. */
export function createUploadLink(ctx: AppContext, oauth: RemoteOAuth, grant: Grant, user: Principal, args: unknown): UploadOutcome {
  const input = CreateUploadLinkInput.safeParse(args ?? {})
  if (!input.success) return fail('Invalid tool input: send path (and optionally overwrite and size in bytes).')
  const { path: filePath, size } = input.data, overwrite = input.data.overwrite === true
  if (size !== undefined && size > LINK_LIMITS.maxBytes) return fail(`File too large: an upload link takes at most ${mib(LINK_LIMITS.maxBytes)} MiB.`)
  try { oauth.rate('upload-link-grant', grant.id, LINK_LIMITS.perGrantPerMinute) } catch (e) {
    if (e instanceof OAuthError) return fail('Too many upload links for this connection; retry in a minute.')
    throw e
  }
  const now = oauth.now()
  const open = ctx.db.query('SELECT count(*) AS n FROM remote_mcp_upload_links WHERE grant_id=? AND used_at IS NULL AND expires_at>?').get(grant.id, now) as { n: number }
  if (open.n >= LINK_LIMITS.openPerGrant) return fail('Too many unused upload links for this connection; use them or wait 10 minutes.')
  let rel = filePath.slice(0, 500)
  try {
    const target = checkUploadTarget(ctx, user, filePath, JSON.parse(grant.sources) as ReadSource[], size ?? null)
    if (isOutcome(target)) return target
    rel = target.rel
  } catch (e) {
    return uploadFailure(ctx, user, rel, e, 'create_upload_link')
  }
  const token = secret('tax_up_'), expires = now + LINK_MS
  ctx.db.query('INSERT INTO remote_mcp_upload_links(hash,grant_id,user_id,path,overwrite,max_bytes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(hash(token), grant.id, user.id, rel, overwrite ? 1 : 0, LINK_LIMITS.maxBytes, now, expires)
  const url = oauth.enabled() + LINK_PATH + token, expiresAt = new Date(expires).toISOString()
  const out = {
    url, method: 'PUT', path: rel, overwrite, maxBytes: LINK_LIMITS.maxBytes, expiresAt,
    command: `curl --fail-with-body -T "<local file>" "${url}"`,
    note: 'Replace <local file> with the local file path. The link works once. Do not show the URL to anyone.',
  }
  // The audit row never holds the token or its hash.
  return { text: JSON.stringify(out), audit: { path: rel, overwrite, maxBytes: LINK_LIMITS.maxBytes, expiresAt } }
}

const noStore = { 'cache-control': 'no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer' }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...noStore } })
const scopesOf = (g: Grant) => JSON.parse(g.scopes) as string[]

/**
 * PUT /connector-uploads/<token>. The token is the only auth. It is consumed in one statement before the body is
 * read, so a link works once. The body streams to a private temp file with the link's size cap. After the body, the
 * grant (revoked, expired, session ended, mcp:write) and the person's current permissions are checked again, then
 * the file goes through the same placeUpload path as upload_file. The token is never logged or audited.
 */
export async function linkUpload(ctx: AppContext, request: Request, token: string, ip: string | null, oauth: RemoteOAuth = remoteOAuthOf(ctx)): Promise<Response> {
  let tmp: string | null = null
  try {
    oauth.ingress('upload', ip)
    const origin = request.headers.get('origin')
    // curl sends no Origin. A browser page on another site must not use a link it saw.
    if (origin !== null && origin !== oauth.origin) return reply({ error: 'access_denied' }, 403)
    const gone = () => reply({ error: 'invalid_link', message: 'This upload link is unknown, used or expired. Ask for a new link with create_upload_link.' }, 404)
    if (!TOKEN.test(token)) return gone()
    const link = ctx.db.query('UPDATE remote_mcp_upload_links SET used_at=? WHERE hash=? AND used_at IS NULL AND expires_at>? RETURNING *').get(oauth.now(), hash(token), oauth.now()) as LinkRow | null
    if (!link) return gone()
    const record = (ok: boolean, detail: Record<string, unknown>) => audit(ctx.db, { actor: link.user_id, action: 'remote_mcp.upload', target: link.grant_id, detail: { via: 'connector_link', ok, path: link.path, ...detail } })
    const live = (): Grant | null => {
      try { const g = oauth.grant(link.grant_id); return g.user_id === link.user_id && scopesOf(g).includes('mcp:write') ? g : null } catch { return null }
    }
    const ended = () => { record(false, { reason: 'connection' }); return reply({ error: 'access_denied', message: 'The connection that made this link has ended or has no write permission. Reconnect and ask for a new link.' }, 403) }
    if (!live()) return ended()
    const tooLarge = (size?: number) => { record(false, { reason: 'too_large', ...(size === undefined ? {} : { size }) }); return reply({ error: 'too_large', message: `File too large: an upload link takes at most ${mib(link.max_bytes)} MiB.` }, 413) }
    const length = request.headers.get('content-length')
    if (length !== null && Number(length) > link.max_bytes) return tooLarge(Number(length))
    // Stream to disk: never more than one network read in memory.
    tmp = uploadTmp(ctx)
    const sha = crypto.createHash('sha256'), fh = await fs.promises.open(tmp, 'wx', 0o600)
    let size = 0
    try {
      for await (const ch of boundedBody(request, link.max_bytes)) {
        let off = 0
        while (off < ch.byteLength) { const { bytesWritten } = await fh.write(ch, off, ch.byteLength - off); off += bytesWritten }
        sha.update(ch); size += ch.byteLength
      }
    } catch (e) {
      if (e instanceof HttpError && e.status === 413) return tooLarge()
      throw e
    } finally { await fh.close() }
    // The upload may take minutes: check the connection and the permissions as they are now.
    const grant = live()
    if (!grant) return ended()
    let user: Principal
    try { user = ctx.files.principal(grant.user_id) } catch { return ended() }
    const out = await placeConnectorUpload(ctx, user, { path: link.path, sources: JSON.parse(grant.sources) as ReadSource[], tmp, size, sha: sha.digest('hex'), overwrite: link.overwrite === 1, tool: 'upload_link' })
    if (out.isError) { record(false, { ...out.audit, size, reason: 'refused' }); return reply({ error: 'refused', message: out.text }, 403) }
    record(true, out.audit)
    return reply(JSON.parse(out.text))
  } catch (e) {
    if (e instanceof OAuthError) return reply({ error: e.code }, e.status)
    ctx.log.warn('connector upload failed', { err: e instanceof Error ? e.name : 'error' })
    return reply({ error: 'server_error' }, 500)
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true })
  }
}
