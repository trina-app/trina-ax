// /downloads/*: the desktop app installers the owner put in <data>/downloads (index.json lists them; office mode:
// `teamax desktop add`, server/src/office/desktop.ts). Shown under Settings → Apps.
// - Signed-in people only, like every other page of the team's data: a session (cookie or bearer) is required and a
//   temporary password must be replaced first. Before this the folder was public, so anyone who knew the internet
//   address could fetch the clinic's kit build (it carries the team's address) and index.json.
// - Installers are 110–200 MB and often come through the Cloudflare tunnel: whole files go out as Bun.file (sendfile,
//   constant memory), a resumed download (Range: bytes=N- or N-<last byte>) as Bun.file().slice(N) to the end of the
//   file (measured: Bun 1.3.12 ends that body correctly, direct and when the body is read; only slices that stop
//   before the end lose their end), any other range from the bounded pull stream of team-files/download.ts.
// - Cache-Control: private, so Cloudflare (which caches .exe / .dmg by extension) never keeps a copy it could hand to
//   someone without a session; CORP same-origin like the API (sibling team addresses are the same site).
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from 'hono'
import type { AppEnv } from '../http/env'
import type { AppContext } from '../context'
import { contentDisposition, parseRange, rangeStream, RANGE_MAX } from '../team-files/download'
import { safeFile } from './web-static'

export const INSTALLER_TYPES: Record<string, string> = {
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dmg': 'application/x-apple-diskimage',
  '.json': 'application/json; charset=utf-8',
}

const text = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra } })

/** GET|HEAD /downloads/<file> for a signed-in person (route module "web"). */
export async function downloadRoute(c: Context<AppEnv>, ctx: AppContext, dir: string | null): Promise<Response> {
  let auth = null
  try { auth = await ctx.services.sessions.resolve(c.req.raw, c.get('info')) } catch (e) { c.get('log').error('session lookup failed', { err: e }) }
  if (!auth) return text(401, 'Sign in to Team AX first, then download the app from Settings → Apps.\n')
  if (auth.user.mustChangePassword) return text(403, 'Change your temporary password first.\n')
  return serveDownload(c.req.raw, c.req.path.slice('/downloads'.length), dir)
}

/** The file part (no auth check): tests and the route above. */
export function serveDownload(req: Request, sub: string, dir: string | null): Response {
  if (!dir || !fs.existsSync(dir)) return text(404, 'Not found\n')
  const file = safeFile(path.resolve(dir), sub)
  if (!file) return text(404, 'Not found\n')
  let st: fs.Stats
  try { st = fs.statSync(file) } catch { return text(404, 'Not found\n') }
  const name = path.basename(file)
  const size = st.size
  const etag = `"${st.ino.toString(36)}-${size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
  const lastModified = st.mtime.toUTCString()
  const headers = new Headers({
    'Content-Type': INSTALLER_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'private, no-cache',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'ETag': etag,
    'Last-Modified': lastModified,
  })
  if (name !== 'index.json') headers.set('Content-Disposition', contentDisposition('attachment', name))
  const inm = req.headers.get('if-none-match')
  if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) return new Response(null, { status: 304, headers })
  const head = req.method === 'HEAD'
  // If-Range: the copy the browser already has part of must be this exact file, else it gets the whole new one
  const ifRange = req.headers.get('if-range')
  const range = ifRange && ifRange !== etag && ifRange !== lastModified ? null : parseRange(req.headers.get('range'), size)
  if (range === 'bad') {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }
  if (!range) {
    headers.set('Content-Length', String(size))
    return new Response(head || size === 0 ? null : Bun.file(file), { status: 200, headers })
  }
  if (range.end === size - 1) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    headers.set('Content-Length', String(size - range.start))
    return new Response(head ? null : Bun.file(file).slice(range.start), { status: 206, headers })
  }
  const end = Math.min(range.end, range.start + RANGE_MAX - 1)
  headers.set('Content-Range', `bytes ${range.start}-${end}/${size}`)
  headers.set('Content-Length', String(end - range.start + 1))
  return new Response(head ? null : rangeStream(file, range.start, end), { status: 206, headers })
}
