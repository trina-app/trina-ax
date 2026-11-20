// The demo's Google (demo/fakes/index.ts): Google's token, revoke and userinfo addresses and the Drive v3 calls this
// server makes (google-drive/read.ts: about, files list and search, a file's metadata, its bytes, a Google document's
// text export), answered in this process. It stands in for every GoogleTransport while the fakes are on
// (google-drive/client.ts setDemoGoogleFetch), so a Drive or Gmail sign-in, its refresh and its revoke never leave.
// The tokens it hands out live a year (tokens never run out during a demo). The file tree and its text come from
// drive.json in the demo's content folder, or the built-in one below.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { GOOGLE_APP_BROKER_SCOPES } from '@mycel/shared/cloud-protocol'
import { DRIVE_API, GOOGLE_REVOKE, GOOGLE_TOKEN, GOOGLE_USERINFO, type DriveFetch } from '../../integrations/google-drive/client'
import { DRIVE_SCOPE } from '../../integrations/google-drive/config'

export const DRIVE_FILE = 'drive.json'
/** what a demo token lives: a year (google-apps/tokens.ts tokensOf accepts at most that) */
export const DEMO_TOKEN_LIFE_S = 31_536_000
export const FOLDER = 'application/vnd.google-apps.folder'
export const GOOGLE_DOC = 'application/vnd.google-apps.document'

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)
const SeedFile = z.object({
  id: Id,
  name: z.string().min(1).max(300),
  /** default: text/plain (a folder: application/vnd.google-apps.folder; a Google document: application/vnd.google-apps.document) */
  mimeType: z.string().max(256).optional(),
  /** the folder it is in; default: "root" (My Drive) */
  parent: Id.optional(),
  /** the file's text (documents, notes, CSV); a folder has none */
  text: z.string().max(1_000_000).optional(),
  modifiedTime: z.string().max(64).optional(),
}).strict()
export const DriveContent = z.object({
  me: z.object({ name: z.string().min(1).max(200), email: z.string().min(3).max(320) }).strict(),
  files: z.array(SeedFile).max(5000),
}).strict()
export type DriveContent = z.infer<typeof DriveContent>

/** The built-in Drive: fictional company files only. */
export const DEFAULT_DRIVE: DriveContent = {
  me: { name: 'Mina Lee', email: 'mina.lee@steepling.example' },
  files: [
    { id: 'marketing', name: 'Marketing', mimeType: FOLDER },
    { id: 'launch', name: 'November launch', mimeType: FOLDER, parent: 'marketing' },
    { id: 'brief', name: 'November launch brief', mimeType: GOOGLE_DOC, parent: 'launch',
      text: 'November launch brief\n\nProduct: Winter Yuzu Ginger tea.\nLaunch: Monday, November 23.\nChannels: display banners (1200×628) through Fieldnote, Instagram square and story.\nTone: warm, simple, a little playful.\nOwner: Sara Jensen.' },
    { id: 'media-plan', name: 'Winter media plan.csv', mimeType: 'text/csv', parent: 'launch',
      text: 'channel,start,end,budget\nDisplay (Fieldnote),2026-11-23,2026-12-13,4000\nInstagram,2026-11-25,2026-12-20,2500\nNewsletter,2026-11-23,2026-11-23,0' },
    { id: 'brand-notes', name: 'Brand notes.md', mimeType: 'text/markdown', parent: 'marketing',
      text: '# Brand notes\n\n- Colours: deep green, warm cream, a touch of yuzu yellow.\n- Type: one sans serif, bold headlines.\n- Photos: natural light, real cups, no stock smiles.' },
    { id: 'contacts', name: 'Agency contacts', mimeType: GOOGLE_DOC, parent: 'marketing',
      text: 'Agency contacts\n\nFieldnote (media agency): Chris Walker, chris.walker@fieldnote.example\nPrintwell (print): orders@printwell.example' },
    { id: 'handbook', name: 'Team handbook', mimeType: GOOGLE_DOC,
      text: 'Team handbook\n\nWorking hours are flexible between 8 and 18. Lunch is at 12:30 on Fridays together. Ask Tom for anything about laptops and accounts.' },
    { id: 'recipes', name: 'Tea recipes.md', mimeType: 'text/markdown',
      text: '# Tea recipes\n\n## Iced Yuzu Ginger\nSteep 2 bags in 200 ml hot water for 4 minutes, add ice and a slice of yuzu.' },
  ],
}

export function loadDrive(content: string | null, warn: (m: string) => void): DriveContent {
  if (!content) return DEFAULT_DRIVE
  let raw: string
  try { raw = fs.readFileSync(path.join(content, DRIVE_FILE), 'utf8') } catch { return DEFAULT_DRIVE }
  try { return DriveContent.parse(JSON.parse(raw)) } catch (e) {
    warn(`demo fakes: ${DRIVE_FILE} is not a file tree (${String((e as Error).message).slice(0, 200)}); the built-in one is used`)
    return DEFAULT_DRIVE
  }
}

interface File { id: string; name: string; mimeType: string; parent: string; text: string; modifiedTime: string }

/** every scope a demo sign-in may ask for: Drive's and each Google app's */
const ALL_SCOPES = [...new Set([DRIVE_SCOPE, ...Object.values(GOOGLE_APP_BROKER_SCOPES).flat()])].join(' ')

export class FakeGoogleDrive {
  private files: Map<string, File>
  readonly me: DriveContent['me']
  /** the tokens handed out (any of them is accepted; the demo has no strangers) */
  private tokens = new Set<string>()
  /** what was asked of it, for tests: method and address without the query */
  calls: string[] = []
  constructor(content: DriveContent, start = Date.now()) {
    this.me = content.me
    this.files = new Map(content.files.map((f, i) => [f.id, {
      id: f.id, name: f.name, mimeType: f.mimeType ?? 'text/plain', parent: f.parent ?? 'root', text: f.text ?? '',
      modifiedTime: f.modifiedTime ?? new Date(start - (i + 1) * 86_400_000).toISOString(),
    }]))
  }

  private issue(kind: 'access' | 'refresh') {
    const t = `demo-${kind}-${crypto.randomBytes(12).toString('base64url')}`
    if (kind === 'access') this.tokens.add(t)
    return t
  }
  private item(f: File) {
    const folder = f.mimeType === FOLDER
    return { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, ...(folder || f.mimeType === GOOGLE_DOC ? {} : { size: String(Buffer.byteLength(f.text)) }),
      capabilities: { canDownload: !folder }, parents: [f.parent] }
  }

  /** the DriveFetch every GoogleTransport uses while the fakes are on */
  fetch: DriveFetch = async (raw, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const u = new URL(raw)
    this.calls.push(`${method} ${u.origin}${u.pathname}`)
    if (raw === GOOGLE_TOKEN && method === 'POST') {
      const body = new URLSearchParams(String(init.body ?? ''))
      const grant = body.get('grant_type')
      if (grant !== 'authorization_code' && grant !== 'refresh_token') return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
      return Response.json({ access_token: this.issue('access'), ...(grant === 'authorization_code' ? { refresh_token: this.issue('refresh') } : {}), expires_in: DEMO_TOKEN_LIFE_S, scope: ALL_SCOPES, token_type: 'Bearer' })
    }
    if (raw === GOOGLE_REVOKE) return new Response('', { status: 200 })
    if (raw === GOOGLE_USERINFO) return Response.json({ sub: `demo-${crypto.createHash('sha256').update(this.me.email).digest('hex').slice(0, 16)}`, name: this.me.name, email: this.me.email, email_verified: true })
    if (raw.startsWith(DRIVE_API)) {
      if (!/^Bearer \S+$/.test(new Headers(init.headers).get('authorization') ?? '')) return Response.json({ error: { code: 401 } }, { status: 401 })
      return this.drive(u.pathname.slice(new URL(DRIVE_API).pathname.length), u.searchParams)
    }
    return Response.json({ error: 'not in the demo' }, { status: 404 })
  }

  private drive(resource: string, q: URLSearchParams): Response {
    if (resource === 'about') return Response.json({ user: { permissionId: 'demo-me', displayName: this.me.name, emailAddress: this.me.email } })
    if (resource === 'files') {
      const query = q.get('q') ?? ''
      const unq = (s: string) => s.replace(/\\(.)/g, '$1')
      const words = /fullText contains '((?:[^'\\]|\\.)*)'/.exec(query)
      const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(query)
      let found = [...this.files.values()]
      if (words) {
        const w = unq(words[1]!).toLowerCase().split(/\s+/).filter(Boolean)
        found = found.filter((f) => w.every((x) => f.name.toLowerCase().includes(x) || f.text.toLowerCase().includes(x)))
      } else if (parent) {
        const p = unq(parent[1]!)
        found = found.filter((f) => f.parent === p)
      }
      found.sort((a, b) => Number(b.mimeType === FOLDER) - Number(a.mimeType === FOLDER) || a.name.localeCompare(b.name))
      const size = Math.max(1, Math.min(100, Number(q.get('pageSize')) || 20))
      const from = Math.max(0, Number(q.get('pageToken')) || 0)
      const page = found.slice(from, from + size)
      return Response.json({ files: page.map((f) => this.item(f)), ...(from + size < found.length ? { nextPageToken: String(from + size) } : {}), incompleteSearch: false })
    }
    const m = /^files\/([A-Za-z0-9_-]{1,256})(\/export)?$/.exec(resource)
    const f = m ? this.files.get(m[1]!) : undefined
    if (!m || !f) return Response.json({ error: { code: 404, message: 'File not found' } }, { status: 404 })
    if (m[2]) {
      if (f.mimeType !== GOOGLE_DOC || q.get('mimeType') !== 'text/plain') return Response.json({ error: { code: 403, message: 'Export not available in the demo' } }, { status: 403 })
      return new Response(f.text, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    if (q.get('alt') === 'media') {
      if (f.mimeType === FOLDER || f.mimeType.startsWith('application/vnd.google-apps.')) return Response.json({ error: { code: 403 } }, { status: 403 })
      return new Response(f.text, { headers: { 'content-type': f.mimeType } })
    }
    return Response.json(this.item(f))
  }
}
