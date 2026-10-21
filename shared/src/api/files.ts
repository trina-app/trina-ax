// Team folder (file screen), chat attachments, chunked uploads. Owner: C (server/src/routes/files.ts).
// Every path is team-relative and goes through the policy function; "no access" and "not found" look the same.
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { Access, IsoTime, PageQuery, QueryBool, RelPath, SMALL_UPLOAD_MAX, UPLOAD_CHUNK_SIZE, UPLOAD_SESSION_MAX, page } from './common'
import { binary, endpoint, empty, multipart, stream } from './endpoint'
import { Attachment, FileEntry, FileVersion, TrashItem, UploadSession, UploadTarget } from './entities'

export const PathQuery = z.object({ path: RelPath })

export const TreeQuery = PageQuery.extend({ path: RelPath.default('') })
export const TreeResponse = z.object({
  path: RelPath,
  /** caller's access to this folder */
  access: Access,
  /** folders first, then files, by name (locale-aware); paged for very large folders */
  entries: z.array(FileEntry),
  nextCursor: z.string().nullable(),
})
export type TreeResponse = z.infer<typeof TreeResponse>

/** Text preview/editing. Office/PDF/images are rendered by the client from /download. */
export const ContentQuery = z.object({ path: RelPath, maxBytes: z.coerce.number().int().min(1).max(10 * 1024 * 1024).optional() })
export const FileContent = z.object({
  path: RelPath,
  size: z.number().int().nonnegative(),
  mtime: IsoTime,
  sha256: z.string(),
  mime: z.string().nullable(),
  /** true for non-text files: content is null, render from /api/files/download instead */
  binary: z.boolean(),
  content: z.string().nullable(),
  truncated: z.boolean(),
  access: Access,
})
export type FileContent = z.infer<typeof FileContent>
/** Save from the file screen. baseSha256 = sha256 the editor loaded; if the file changed since, a conflict copy is saved. */
export const SaveContentBody = z.object({ path: RelPath, content: z.string().max(10 * 1024 * 1024), baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable() })
export const SaveResult = z.object({
  /** where the content ended up: the path itself, or the conflict copy */
  path: RelPath,
  conflict: z.boolean(),
  entry: FileEntry,
})
export type SaveResult = z.infer<typeof SaveResult>

export const DownloadQuery = z.object({
  path: RelPath,
  /** inline (preview, images in answers) or attachment (save as) */
  disposition: z.enum(['inline', 'attachment']).default('attachment'),
})

export const UploadFields = z.object({
  /** target folder */
  folder: RelPath,
  /** file name (defaults to the part's filename) */
  name: z.string().min(1).max(255).optional(),
  onExists: z.enum(['fail', 'replace', 'rename']).default('rename'),
})
export const MkdirBody = z.object({ path: RelPath })
/**
 * confirm: moving an ordinary item into the caller's own users/<me>/ that other people can read now answers 409
 * conflict {params: {reason:'audience_narrowed', lostViewers}} unless confirm is true (design tab 4 move).
 * Folders that are or contain group / project / rule folders (a folders row) move only for admins, never under users/.
 */
export const MoveBody = z.object({ from: RelPath, to: RelPath, onExists: z.enum(['fail', 'rename']).default('fail'), confirm: z.boolean().default(false) })
export const MoveResult = z.object({ entry: FileEntry })
/**
 * Share by copying (design tab 2 rule 3, tab 4): a file the caller can read -> `to` in a folder the caller can write.
 * Files only, up to 2 GB. onExists like upload (rename by default; replace keeps the old one as a version, or saves a
 * conflict copy when baseSha256 no longer matches). dryRun: nothing is copied, answers how many more people would see
 * the copy than see the original (people counted, never named).
 */
export const CopyBody = z.object({
  from: RelPath,
  to: RelPath,
  baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  dryRun: z.boolean().default(false),
  onExists: z.enum(['fail', 'replace', 'rename']).default('rename'),
})
export const CopyResult = z.union([
  z.object({ path: RelPath, sha256: z.string() }),
  z.object({ viewersAdded: z.number().int().nonnegative() }),
])
export type CopyResult = z.infer<typeof CopyResult>
export const DeleteResult = z.object({ trashId: Uuid7, purgeAt: IsoTime })
export const HistoryResponse = z.object({
  path: RelPath,
  items: z.array(FileVersion),
  /** sha256 of the file as it is now (null: it does not exist any more); a version with this sha256 is the current
   * content, so restoring it changes nothing */
  currentSha256: z.string().nullable().optional(),
  /** the caller may restore versions (write access to the path; the same check POST /api/files/restore makes) */
  canRestore: z.boolean().optional(),
})
/** Restore an old version of a file (the current content becomes a new version first). */
export const RestoreVersionBody = z.object({ path: RelPath, versionId: Uuid7 })
/** mine: only items the caller deleted */
export const TrashQuery = PageQuery.extend({ mine: QueryBool.optional() })

/** Response header of GET /api/files/content: sha256 of the whole file (send it back as baseSha256 when saving). */
export const CONTENT_SHA_HEADER = 'x-content-sha256'

/**
 * Links the AI hands out with share_file (design tab 3). Both are team-server relative URLs; whoever opens them is
 * checked again with their own session, so a link never grants access by itself.
 * - preview: the web app's file viewer route (component D renders it from /api/files/content or /download)
 * - download: the download endpoint itself
 */
export const FILE_VIEW_PATH = '/files/view'
export function fileShareUrl(path: string, mode: 'preview' | 'download'): string {
  const q = 'path=' + encodeURIComponent(path)
  return mode === 'preview' ? `${FILE_VIEW_PATH}?${q}` : `/api/files/download?${q}&disposition=attachment`
}

// ---------------- attachments + upload sessions ----------------
export const AttachmentUploadFields = z.object({ chatId: Uuid7, name: z.string().min(1).max(255).optional() })
export const CreateUploadSessionBody = z.object({
  target: UploadTarget,
  size: z.number().int().nonnegative().max(UPLOAD_SESSION_MAX),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export const ChunkResult = z.object({ received: z.array(z.number().int().nonnegative()) })
/** complete: the server checks sha256, then moves the file into place through the policy function */
export const UploadComplete = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), entry: FileEntry }),
  z.object({ kind: z.literal('attachment'), attachment: Attachment }),
  /** transcribe target: the job that was started */
  z.object({ kind: z.literal('transcribe'), jobId: Uuid7 }),
])
export type UploadComplete = z.infer<typeof UploadComplete>

export const FILES = {
  tree: endpoint({ method: 'GET', path: '/api/files/tree', auth: 'user', owner: 'C', query: TreeQuery, response: TreeResponse, summary: 'List a folder (only what the caller may see; ancestors of visible folders shown for navigation).' }),
  content: endpoint({ method: 'GET', path: '/api/files/content', auth: 'user', owner: 'C', query: ContentQuery, response: FileContent, summary: 'Text content for preview / editing.' }),
  saveContent: endpoint({ method: 'PUT', path: '/api/files/content', auth: 'user', owner: 'C', body: SaveContentBody, response: SaveResult, summary: 'Save a text file from the file screen (hash-based conflict copy, version history).' }),
  download: endpoint({ method: 'GET', path: '/api/files/download', auth: 'user', owner: 'C', query: DownloadQuery, response: stream(true), summary: 'Stream a file (Range supported, never loaded whole into memory).' }),
  upload: endpoint({ method: 'POST', path: '/api/files/upload', auth: 'user', owner: 'C', status: 201, body: multipart(UploadFields, SMALL_UPLOAD_MAX), response: FileEntry, summary: 'Upload one file up to 50 MB into a folder (write access).' }),
  mkdir: endpoint({ method: 'POST', path: '/api/files/mkdir', auth: 'user', owner: 'C', status: 201, body: MkdirBody, response: FileEntry, summary: 'Create a folder (name rules + collision check).' }),
  move: endpoint({ method: 'POST', path: '/api/files/move', auth: 'user', owner: 'C', body: MoveBody, response: MoveResult, summary: 'Move / rename (write access at both ends; folders.path follows). Group / project / rule folders: admin or owner only, never into users/ (400). Into users/<me>/ when others lose sight of it: 409 audience_narrowed unless confirm.' }),
  copy: endpoint({ method: 'POST', path: '/api/files/copy', auth: 'user', owner: 'C', status: 201, body: CopyBody, response: CopyResult, summary: 'Copy a readable file into a writable folder (sharing a personal file). dryRun: {viewersAdded} only (also 201).' }),
  remove: endpoint({ method: 'DELETE', path: '/api/files', auth: 'user', owner: 'C', query: PathQuery, response: DeleteResult, summary: 'Move a file or folder to the trash (30 days). Group / project / rule folders: admin or owner only.' }),
  history: endpoint({ method: 'GET', path: '/api/files/history', auth: 'user', owner: 'C', query: PathQuery, response: HistoryResponse, summary: 'Version history of a file.' }),
  versionDownload: endpoint({ method: 'GET', path: '/api/files/history/:versionId/download', auth: 'user', owner: 'C', response: stream(true), summary: 'Download an old version (read access to its path).' }),
  restoreVersion: endpoint({ method: 'POST', path: '/api/files/restore', auth: 'user', owner: 'C', body: RestoreVersionBody, response: SaveResult, summary: 'Restore an old version of a file.' }),
  trash: endpoint({ method: 'GET', path: '/api/files/trash', auth: 'user', owner: 'C', query: TrashQuery, response: page(TrashItem), summary: 'Trash items the caller could restore (write access to the original path).' }),
  restoreTrash: endpoint({ method: 'POST', path: '/api/files/trash/:id/restore', auth: 'user', owner: 'C', response: MoveResult, summary: 'Put a trashed item back (write access to the original path; " (restored)", in the team language, is added when the name is taken).' }),
  purgeTrash: endpoint({ method: 'DELETE', path: '/api/files/trash/:id', auth: 'admin', owner: 'C', response: empty, status: 204, summary: 'Delete a trashed item for good (admin or owner).' }),

  uploadAttachment: endpoint({ method: 'POST', path: '/api/uploads', auth: 'user', owner: 'C', status: 201, body: multipart(AttachmentUploadFields, SMALL_UPLOAD_MAX), response: Attachment, summary: 'Attach a file (≤ 50 MB) to an own chat: stored in users/<me>/.attachments/<chatId>/.' }),
  attachmentThumbnail: endpoint({ method: 'GET', path: '/api/uploads/:id/thumbnail', auth: 'user', owner: 'C', response: stream(false), summary: 'Small JPEG/PNG thumbnail of an image attachment.' }),
  createUploadSession: endpoint({ method: 'POST', path: '/api/upload-sessions', auth: 'user', owner: 'C', status: 201, body: CreateUploadSessionBody, response: UploadSession, summary: `Start a chunked upload (${UPLOAD_CHUNK_SIZE / 1024 / 1024} MB chunks). Expires after 24 h.` }),
  uploadChunk: endpoint({ method: 'PUT', path: '/api/upload-sessions/:id/chunks/:n', auth: 'user', owner: 'C', body: binary(UPLOAD_CHUNK_SIZE), response: ChunkResult, summary: 'Store chunk n (0-based). Re-sending a stored chunk is a no-op.' }),
  getUploadSession: endpoint({ method: 'GET', path: '/api/upload-sessions/:id', auth: 'user', owner: 'C', response: UploadSession, summary: 'Which chunks arrived (to resume after a disconnect).' }),
  completeUploadSession: endpoint({ method: 'POST', path: '/api/upload-sessions/:id/complete', auth: 'user', owner: 'C', response: UploadComplete, summary: 'Verify sha256 and move the file into place.' }),
  cancelUploadSession: endpoint({ method: 'DELETE', path: '/api/upload-sessions/:id', auth: 'user', owner: 'C', response: empty, status: 204, summary: 'Drop an unfinished upload.' }),
} as const
