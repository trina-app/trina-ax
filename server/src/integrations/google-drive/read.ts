import { z } from 'zod'
import { DriveId, DriveListInput, DriveReadInput, DriveSearchInput } from '@mycel/shared'
import type { DriveShareFolder } from '@mycel/shared/api'
import { extractText, looksScanned, type Tools } from '../../files/extract'
import { readMaxBytes } from '../../system/limits'
import type { DriveConn } from './oauth'
import { DriveError } from './store'
import { checkAbort } from './client'

const Item = z.object({
  id: DriveId, name: z.string().max(4096), mimeType: z.string().max(256), modifiedTime: z.string().max(100).optional(),
  size: z.string().max(32).optional(), capabilities: z.object({ canDownload: z.boolean().optional() }).optional(),
  shortcutDetails: z.object({ targetId: DriveId }).optional(),
  parents: z.array(DriveId).max(50).optional(), driveId: DriveId.optional(),
})
const fields = 'id,name,mimeType,modifiedTime,size,capabilities(canDownload),shortcutDetails(targetId),parents,driveId'
const FOLDER = 'application/vnd.google-apps.folder'
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300)
const escapeQ = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
function parse<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  try { return schema.parse(JSON.parse(new TextDecoder().decode(bytes))) } catch { throw new DriveError('invalid_provider_response', 502) }
}
const publicItem = (v: z.infer<typeof Item>) => ({ id: v.id, name: clean(v.name), mimeType: v.mimeType, ...(v.modifiedTime ? { modifiedTime: v.modifiedTime } : {}), webViewLink: `https://drive.google.com/file/d/${v.id}/view` })

/** The folders a team share gives access to (shares.ts), everything below them included, or its whole Drive. Decided
 * here on the server for every listing, search result and read; nothing the model or the browser sends widens it. */
export interface FolderScope { whole: boolean; ids: Set<string>; drives: Set<string>; roots: DriveShareFolder[] }
export const scopeOf = (folders: DriveShareFolder[], whole: boolean): FolderScope =>
  ({ whole, ids: new Set(folders.map((f) => f.id)), drives: new Set(folders.filter((f) => f.kind === 'drive').map((f) => f.id)), roots: folders })
const Parents = z.object({ id: DriveId, parents: z.array(DriveId).max(50).optional(), driveId: DriveId.optional() })
/** Google lookups one call may make to place files; past it, a file not yet placed counts as outside (fail closed). */
const MAX_LOOKUPS = 200

/** Is a file inside the scope? It is a shared folder itself, is in a shared drive, or one of its parents is inside,
 * all the way up (any parent: a file in two folders is inside when either is). Each folder is looked up once a call. */
export class Ancestry {
  lookups = 0
  exhausted = false
  private memo = new Map<string, z.infer<typeof Parents> | null>()
  constructor(readonly conn: DriveConn, readonly scope: FolderScope, readonly signal?: AbortSignal) {}
  async meta(id: string) {
    if (this.memo.has(id)) return this.memo.get(id)!
    if (++this.lookups > MAX_LOOKUPS) { this.exhausted = true; return null }
    let v: z.infer<typeof Parents> | null = null
    try {
      const r = await this.conn.api(`files/${id}`, { supportsAllDrives: 'true', fields: 'id,parents,driveId' }, 32_768, this.signal)
      v = parse(r.bytes, Parents)
      if (v.id !== id) v = null
    } catch (e) { if (!(e instanceof DriveError) || e.reason !== 'not_found') throw e }
    this.memo.set(id, v)
    return v
  }
  async inside(item: { id: string; parents?: string[]; driveId?: string }): Promise<boolean> {
    const s = this.scope
    if (s.whole) return true
    if (s.ids.has(item.id) || (item.driveId && s.drives.has(item.driveId))) return true
    const seen = new Set<string>([item.id])
    let frontier = [...(item.parents ?? [])]
    for (let depth = 0; depth < 64 && frontier.length; depth++) {
      const next: string[] = []
      for (const p of frontier) {
        if (seen.has(p)) continue
        seen.add(p)
        if (s.ids.has(p)) return true
        const m = await this.meta(p)
        if (!m) continue
        if (m.driveId && s.drives.has(m.driveId)) return true
        next.push(...(m.parents ?? []))
      }
      frontier = next
    }
    return false
  }
}
const rootItem = (f: DriveShareFolder) => ({ id: f.id, name: clean(f.name), mimeType: FOLDER, webViewLink: `https://drive.google.com/drive/folders/${f.id}` })

/** Search or list. With a scope (a team share): a list of the shared folders at the top, a folder only when it is
 * inside, a shared drive only when it is one of the share's, and only results inside. */
export async function listDrive(conn: DriveConn, a: z.output<typeof DriveSearchInput> | z.output<typeof DriveListInput>, signal?: AbortSignal, scope?: FolderScope) {
  const search = 'query' in a
  const limited = !!scope && !scope.whole
  if (limited && a.driveId && !scope!.drives.has(a.driveId)) throw new DriveError('not_found', 404)
  if (limited && !search && a.folderId === 'root' && !a.driveId) return { files: scope!.roots.map(rootItem), nextPageToken: null, incompleteSearch: false }
  const anc = scope ? new Ancestry(conn, scope, signal) : null
  const folderId = !search ? (a.folderId === 'root' && a.driveId ? a.driveId : a.folderId) : null
  if (anc && limited && folderId) {
    const m = scope!.ids.has(folderId) ? null : await anc.meta(folderId)
    if (!scope!.ids.has(folderId) && (!m || !(await anc.inside(m)))) throw new DriveError('not_found', 404)
  }
  const clause = search ? `fullText contains '${escapeQ(a.query)}'` : `'${escapeQ(folderId!)}' in parents`
  const q = { q: `trashed=false and (${clause})`, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', spaces: 'drive',
    corpora: a.driveId ? 'drive' : limited ? 'allDrives' : 'user', ...(a.driveId ? { driveId: a.driveId } : {}), ...(a.pageToken ? { pageToken: a.pageToken } : {}),
    pageSize: String(a.pageSize), fields: 'nextPageToken,incompleteSearch,files(' + fields + ')' }
  const r = await conn.api('files', q, 1_048_576, signal)
  const body = parse(r.bytes, z.object({ files: z.array(Item).max(100), nextPageToken: z.string().max(4096).optional(), incompleteSearch: z.boolean().optional() }))
  let files = body.files.slice(0, a.pageSize)
  if (anc && limited) {
    const kept: typeof files = []
    // a listed folder was checked above: its children are inside; anything else is placed by its parents
    for (const f of files) if ((folderId && f.parents?.includes(folderId)) || await anc.inside(f)) kept.push(f)
    files = kept
  }
  r.assertCurrent()
  return { files: files.map(publicItem), nextPageToken: body.nextPageToken ?? null, incompleteSearch: (body.incompleteSearch ?? false) || !!anc?.exhausted }
}
const EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'text/plain', ext: 'txt' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
}
// Drive permits names without extensions. Known document MIME types still select the existing converter.
const DOWNLOAD_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/hwp+zip': 'hwpx',
}
/** Drive images the model sees as images (files/vision.ts), by MIME type -> the extension the converter goes by */
const IMAGE_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/tiff': 'tiff', 'image/bmp': 'bmp',
}
export type DriveImage = (name: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<{ jpeg?: Buffer; text: string }>
/** A PDF's pages without a text layer: a Drive read gives text only (no OCR, docs/DECISIONS.md "AI sees images and PDF pages"). */
const SCANNED_NOTE = 'Some pages have no text layer (scans or pictures), so their content is not in this text. To see them, ask the person to attach the file in the chat or add it to the team folder, then read it with pages.'

/** Read a file. With a scope (a team share), only a file inside: a shortcut is judged by its target, and a file
 * outside answers as if it were not there. */
export async function readDrive(conn: DriveConn, a: z.output<typeof DriveReadInput>, tools: Tools, signal?: AbortSignal, image?: DriveImage, scope?: FolderScope) {
  let id = a.fileId
  const anc = scope ? new Ancestry(conn, scope, signal) : null
  const visited = new Set<string>()
  for (let depth = 0; depth < 5; depth++) {
    if (visited.has(id)) throw new DriveError('shortcut_loop')
    visited.add(id)
    const m = await conn.api(`files/${id}`, { supportsAllDrives: 'true', fields }, 32_768, signal)
    const item = parse(m.bytes, Item)
    if (item.id !== id) throw new DriveError('invalid_provider_response', 502)
    if (item.mimeType === 'application/vnd.google-apps.shortcut') {
      if (!item.shortcutDetails) throw new DriveError('invalid_provider_response', 502)
      id = item.shortcutDetails.targetId; continue
    }
    if (anc && !(await anc.inside(item))) throw new DriveError('not_found', 404)
    if (item.capabilities?.canDownload !== true) throw new DriveError('not_downloadable', 403)
    const ex = EXPORTS[item.mimeType]
    if (!ex && item.mimeType.startsWith('application/vnd.google-apps.')) throw new DriveError('unsupported_format')
    const max = Math.min(readMaxBytes(), 32 * 1024 * 1024, ex ? 10 * 1024 * 1024 : Infinity)
    if (item.size && Number(item.size) > max) throw new DriveError('too_large', 413)
    const r = await conn.api(`files/${id}${ex ? '/export' : ''}`, ex ? { mimeType: ex.mime } : { alt: 'media', supportsAllDrives: 'true' }, max, signal)
    const imageExt = IMAGE_MIME[item.mimeType]
    if (imageExt && image && !ex) {
      let shown: { jpeg?: Buffer; text: string }
      try { checkAbort(signal); shown = await image(`image.${imageExt}`, r.bytes, signal) }
      catch (e) { if (signal?.aborted) throw new DriveError('cancelled', 409); throw new DriveError('conversion_failed') }
      r.assertCurrent(); checkAbort(signal)
      return { ...publicItem(item), text: shown.text.slice(0, a.maxChars), truncated: shown.text.length > a.maxChars, ...(shown.jpeg ? { image: shown.jpeg } : {}) }
    }
    let text: string
    const ext = ex?.ext ?? DOWNLOAD_EXT[item.mimeType]
    try { checkAbort(signal); text = await extractText(ext ? `document.${ext}` : item.name, r.bytes, tools, signal) }
    catch (e) { if (signal?.aborted) throw new DriveError('cancelled', 409); throw new DriveError('conversion_failed') }
    r.assertCurrent(); checkAbort(signal)
    const scanned = ext === 'pdf' && looksScanned(text)
    return { ...publicItem(item), text: text.slice(0, a.maxChars), truncated: text.length > a.maxChars, ...(scanned ? { note: SCANNED_NOTE } : {}) }
  }
  throw new DriveError('shortcut_loop')
}
