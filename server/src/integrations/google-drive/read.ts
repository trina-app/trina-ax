import { z } from 'zod'
import { DriveId, DriveListInput, DriveReadInput, DriveSearchInput } from '@mycel/shared'
import { extractText, type Tools } from '../../files/extract'
import { readMaxBytes } from '../../system/limits'
import { GoogleDrive } from './oauth'
import { DriveError } from './store'
import { checkAbort } from './client'

const Item = z.object({
  id: DriveId, name: z.string().max(4096), mimeType: z.string().max(256), modifiedTime: z.string().max(100).optional(),
  size: z.string().max(32).optional(), capabilities: z.object({ canDownload: z.boolean().optional() }).optional(),
  shortcutDetails: z.object({ targetId: DriveId }).optional(),
})
const fields = 'id,name,mimeType,modifiedTime,size,capabilities(canDownload),shortcutDetails(targetId)'
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300)
const escapeQ = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
function parse<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  try { return schema.parse(JSON.parse(new TextDecoder().decode(bytes))) } catch { throw new DriveError('invalid_provider_response', 502) }
}
const publicItem = (v: z.infer<typeof Item>) => ({ id: v.id, name: clean(v.name), mimeType: v.mimeType, ...(v.modifiedTime ? { modifiedTime: v.modifiedTime } : {}), webViewLink: `https://drive.google.com/file/d/${v.id}/view` })
export async function listDrive(svc: GoogleDrive, user: string, a: z.output<typeof DriveSearchInput> | z.output<typeof DriveListInput>, signal?: AbortSignal) {
  const clause = 'query' in a ? `fullText contains '${escapeQ(a.query)}'` : `'${escapeQ(a.folderId)}' in parents`
  const q = { q: `trashed=false and (${clause})`, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', spaces: 'drive',
    corpora: a.driveId ? 'drive' : 'user', ...(a.driveId ? { driveId: a.driveId } : {}), ...(a.pageToken ? { pageToken: a.pageToken } : {}),
    pageSize: String(a.pageSize), fields: 'nextPageToken,incompleteSearch,files(' + fields + ')' }
  const r = await svc.api(user, 'files', q, 1_048_576, signal)
  const body = parse(r.bytes, z.object({ files: z.array(Item).max(100), nextPageToken: z.string().max(4096).optional(), incompleteSearch: z.boolean().optional() }))
  r.assertCurrent()
  return { files: body.files.slice(0, a.pageSize).map(publicItem), nextPageToken: body.nextPageToken ?? null, incompleteSearch: body.incompleteSearch ?? false }
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
export async function readDrive(svc: GoogleDrive, user: string, a: z.output<typeof DriveReadInput>, tools: Tools, signal?: AbortSignal) {
  let id = a.fileId
  const visited = new Set<string>()
  for (let depth = 0; depth < 5; depth++) {
    if (visited.has(id)) throw new DriveError('shortcut_loop')
    visited.add(id)
    const m = await svc.api(user, `files/${id}`, { supportsAllDrives: 'true', fields }, 32_768, signal)
    const item = parse(m.bytes, Item)
    if (item.id !== id) throw new DriveError('invalid_provider_response', 502)
    if (item.mimeType === 'application/vnd.google-apps.shortcut') {
      if (!item.shortcutDetails) throw new DriveError('invalid_provider_response', 502)
      id = item.shortcutDetails.targetId; continue
    }
    if (item.capabilities?.canDownload !== true) throw new DriveError('not_downloadable', 403)
    const ex = EXPORTS[item.mimeType]
    if (!ex && item.mimeType.startsWith('application/vnd.google-apps.')) throw new DriveError('unsupported_format')
    const max = Math.min(readMaxBytes(), 32 * 1024 * 1024, ex ? 10 * 1024 * 1024 : Infinity)
    if (item.size && Number(item.size) > max) throw new DriveError('too_large', 413)
    const r = await svc.api(user, `files/${id}${ex ? '/export' : ''}`, ex ? { mimeType: ex.mime } : { alt: 'media', supportsAllDrives: 'true' }, max, signal)
    let text: string
    const ext = ex?.ext ?? DOWNLOAD_EXT[item.mimeType]
    try { checkAbort(signal); text = await extractText(ext ? `document.${ext}` : item.name, r.bytes, tools, signal) }
    catch (e) { if (signal?.aborted) throw new DriveError('cancelled', 409); throw new DriveError('conversion_failed') }
    r.assertCurrent(); checkAbort(signal)
    return { ...publicItem(item), text: text.slice(0, a.maxChars), truncated: text.length > a.maxChars }
  }
  throw new DriveError('shortcut_loop')
}
