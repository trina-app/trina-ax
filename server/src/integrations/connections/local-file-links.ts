// A team file for an app on the person's computer (docs/decisions/20261128-local-app-team-file-links.md). Aside's repl
// and exec, ego lite's script: these tools take code or a task, never a file's content, so a team file cannot be
// swapped in as base64 (team-attach.ts). Instead the AI writes the handle "team-file:<path>" in quotes where the code
// or task downloads a file, for example fetch("team-file:shared/quotes/quote.pdf"), and the server puts a one-time
// download link there:
//   - the file is read and checked as the person of the turn with a mail attachment's checks (readOutgoingTeamFiles),
//     shown on the connection's card, checked again after it (tools.ts), as for any attachment;
//   - the link holds the exact bytes that were checked, in memory: 32 random bytes, one download, gone after
//     LINK_TTL_MS or when the turn ends, whichever is first, and checked again (access now, unchanged, not held) before
//     the bytes go;
//   - the link is never shown to the AI: the call it sees keeps the handle, and the app's answer gets the handle back
//     in place of the link.
// The address is the team page's own origin of the desktop window the call goes to (the computer reaches the server
// there), else the first configured public origin.
import { randomBytes } from 'node:crypto'
import type { AppContext } from '../../context'
import { audit } from '../../admin/audit'
import { TEAM_FILE_PREFIX } from './team-attach'

export const LOCAL_LINK_PATH = '/team-file-links/'
/** how long a link lives at most (it also ends with the turn) */
export const LINK_TTL_MS = 10 * 60_000
/** bytes waiting in links on the whole server at most (one call is at most ATTACH_MAX_BYTES) */
export const LINKS_MAX_PENDING_BYTES = 200_000_000
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const DEPTH_MAX = 12
/** a handle in quotes inside code or a task: "team-file:<path>", 'team-file:<path>' or `team-file:<path>` */
const QUOTED = /(["'`])team-file:([^"'`\r\n]{1,1000})\1/g

/**
 * The team files a call to an app on the computer names: `content`, a whole value where its tool takes a file's content
 * (sent as base64, team-attach.ts); `links`, a handle in quotes inside any other text, or the whole value of another
 * argument (a one-time link goes there). `loose`: a handle that is neither (in the middle of a text without quotes):
 * the call is refused with how to write it. `isContent(key)`: whether that argument takes a file's content.
 */
export function localTeamFiles(args: unknown, isContent: (key: string | null) => boolean): { content: string[]; links: string[]; loose: boolean } {
  const content: string[] = [], links: string[] = []
  let loose = false
  const walk = (v: unknown, key: string | null, depth: number) => {
    if (depth > DEPTH_MAX) { loose = true; return }
    if (typeof v === 'string') {
      if (!v.includes(TEAM_FILE_PREFIX)) return
      if (v.startsWith(TEAM_FILE_PREFIX) && !/[\r\n"'`]/.test(v)) { (isContent(key) ? content : links).push(v); return }
      for (const m of v.matchAll(QUOTED)) links.push(TEAM_FILE_PREFIX + m[2])
      if (v.replace(QUOTED, '').includes(TEAM_FILE_PREFIX)) loose = true
    } else if (Array.isArray(v)) for (const x of v) walk(x, key, depth + 1)
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1)
  }
  walk(args, null, 0)
  return { content, links, loose }
}

/** The call's arguments with each link handle replaced by its address (whole values and quoted ones alike); content
 * handles are left for withTeamFiles. */
export function withLinks(args: unknown, urls: ReadonlyMap<string, string>, isContent: (key: string | null) => boolean): unknown {
  const walk = (v: unknown, key: string | null, depth: number): unknown => {
    if (depth > DEPTH_MAX) return v
    if (typeof v === 'string') {
      if (!v.includes(TEAM_FILE_PREFIX)) return v
      if (v.startsWith(TEAM_FILE_PREFIX) && !/[\r\n"'`]/.test(v)) return isContent(key) ? v : (urls.get(v) ?? v)
      return v.replace(QUOTED, (all, q: string, path: string) => { const u = urls.get(TEAM_FILE_PREFIX + path); return u ? `${q}${u}${q}` : all })
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key, depth + 1))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k, depth + 1)]))
    return v
  }
  return walk(args, null, 0)
}

/** What the app answered with each link put back as its handle: the AI never sees a link. */
export function unlinked<T>(answer: T, urls: ReadonlyMap<string, string>): T {
  if (!urls.size) return answer
  const back = [...urls].map(([handle, url]) => [url, handle] as const)
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 40) return v
    if (typeof v === 'string') { let s = v; for (const [url, handle] of back) if (s.includes(url)) s = s.split(url).join(handle); return s }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, depth + 1)]))
    return v
  }
  return walk(answer, 0) as T
}

export interface LinkInput {
  userId: string
  /** the team path, for the audit line */
  rel: string
  name: string
  bytes: Buffer
  sha256: string
  /** checked right before the bytes go: false (or a throw) when the person may no longer send the file */
  recheck: () => boolean | void
}
interface Link extends LinkInput { token: string; expiresAt: number }

/** The one-time links waiting on this server (in memory: nothing is written to disk, a restart ends them all). */
export class LocalFileLinks {
  private links = new Map<string, Link>()
  private pending = 0
  constructor(private now: () => number = Date.now) {}

  get pendingBytes(): number { this.sweep(); return this.pending }

  /** One link per file, all or none (null: over LINKS_MAX_PENDING_BYTES). `signal`: the turn; its end ends them. */
  issue(files: LinkInput[], signal?: AbortSignal, ttlMs = LINK_TTL_MS): string[] | null {
    this.sweep()
    const total = files.reduce((n, f) => n + f.bytes.length, 0)
    if (this.pending + total > LINKS_MAX_PENDING_BYTES) return null
    const expiresAt = this.now() + ttlMs
    const tokens = files.map((f) => {
      const token = randomBytes(32).toString('base64url')
      this.links.set(token, { ...f, token, expiresAt })
      this.pending += f.bytes.length
      return token
    })
    if (signal) {
      const end = () => { for (const t of tokens) this.drop(t) }
      if (signal.aborted) end()
      else signal.addEventListener('abort', end, { once: true })
    }
    return tokens
  }

  /** The bytes behind a token, once; null for every failure alike (unknown, used, expired, the recheck failed). */
  take(token: string): (LinkInput & { token: string }) | null {
    this.sweep()
    if (!TOKEN.test(token)) return null
    const l = this.links.get(token)
    if (!l) return null
    this.drop(token)
    let ok = false
    try { ok = l.recheck() !== false } catch { ok = false }
    return ok ? l : null
  }

  private drop(token: string) {
    const l = this.links.get(token)
    if (l && this.links.delete(token)) this.pending -= l.bytes.length
  }

  private sweep() {
    const now = this.now()
    for (const l of [...this.links.values()]) if (l.expiresAt <= now) this.drop(l.token)
  }
}

/** The address a link is reached at from the person's computer: the window's team page origin, else the first
 * configured public origin; null when neither is known. */
export function linkBase(ctx: Pick<AppContext, 'config'>, windowOrigin: string | null): string | null {
  for (const o of [windowOrigin, ...ctx.config.publicOrigins]) {
    if (!o) continue
    try {
      const u = new URL(o)
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password) return u.origin
    } catch { /* next */ }
  }
  return null
}

const noStore = { 'cache-control': 'no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
const TYPES: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', hwp: 'application/x-hwp', hwpx: 'application/hwp+zip' }
/** the type a web page's file field shows for the file (a mail service decides by it), from the extension */
export const typeOf = (name: string) => TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/**
 * GET /team-file-links/<token>: the token is the only auth (an app on the computer has no sign-in of the team page).
 * Every failure is the same 404; a GET is audited (local_app.file_link) with the path, size and hash, never the token.
 */
export function linkResponse(ctx: AppContext, links: LocalFileLinks, request: Request, token: string): Response {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: noStore })
  const l = links.take(token)
  if (!l) return new Response(JSON.stringify({ error: 'invalid_link' }), { status: 404, headers: { 'content-type': 'application/json', ...noStore } })
  audit(ctx.db, { actor: l.userId, action: 'local_app.file_link', target: null, detail: { path: l.rel, size: l.bytes.length, sha256: l.sha256.slice(0, 16) } })
  const ascii = l.name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return new Response(l.bytes as unknown as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      'content-type': typeOf(l.name), 'content-length': String(l.bytes.length),
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(l.name)}`,
      'content-security-policy': 'sandbox', ...noStore,
    },
  })
}
