// Team folder (file screen), chat attachments, chunked uploads. Owner: C (server/src/routes/files.ts).
// Every path is team-relative and goes through the policy function; "no access" and "not found" look the same.
import { z } from 'zod'
import { HwpPreviewPage, HwpPreviewQuery } from '../hwp'
import { Uuid7 } from '../ids'
import { Access, IsoTime, PageQuery, QueryBool, RelPath, SMALL_UPLOAD_MAX, UPLOAD_CHUNK_SIZE, UPLOAD_SESSION_MAX, page } from './common'
import { binary, endpoint, empty, multipart, stream } from './endpoint'
import { Attachment, FileEntry, FileHistoryEvent, FileVersion, SourceLoc, TrashItem, UploadSession, UploadTarget, UserRef } from './entities'

export const PathQuery = z.object({ path: RelPath })

/** Files and folders that an operating system makes (Finder, Windows Explorer): never a person's document. The folder
 * upload skips them (web/src/lib/folderUpload.ts) and a team folder's document count leaves them out
 * (server/src/skills/examples.ts). Other dot files are a project's own (.gitignore). */
const SYSTEM_NAMES = new Set(['.ds_store', '.apdisk', '.appledouble', '.fseventsd', '.spotlight-v100', '.temporaryitems', '.trashes', '__macosx', 'icon\r', 'thumbs.db', 'ehthumbs.db', 'desktop.ini', '$recycle.bin', 'system volume information'])
export const isSystemName = (name: string) => name.startsWith('._') || SYSTEM_NAMES.has(name.toLowerCase())


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
  preview: QueryBool.optional(),
  /** the HTML file whose preview puts this file into its page: refused (403, reason embed_narrower) unless everyone who
   * can read that page can read this file too (server/src/team-files/embed.ts) */
  embedIn: RelPath.optional(),
})

/** The file's size as the sender read it, in decimal digits (a form field): a file part of another size is refused before
 * it is stored. Senders that name none are served as before. */
const SentSize = z.string().regex(/^\d+$/).transform(Number).optional()

export const UploadFields = z.object({
  /** target folder */
  folder: RelPath,
  /** file name (defaults to the part's filename) */
  name: z.string().min(1).max(255).optional(),
  onExists: z.enum(['fail', 'replace', 'rename']).default('rename'),
  size: SentSize,
})
export const MkdirBody = z.object({ path: RelPath })
/**
 * confirm: moving an ordinary item into the caller's own users/<me>/ that other people can read now answers 409
 * conflict {params: {reason:'audience_narrowed', lostViewers}} unless confirm is true (design tab 4 move).
 * Folders that are or contain group / project / rule folders (a folders row) move only for admins, never under users/.
 * skillsOk: a project's folder moved to projects/<name> from elsewhere turns on the skills in its skills/ folder (in that
 * project's chats): 409 conflict {params: {reason:'project_skills_on', skills (their names, one per line, at most 20),
 * count}} unless skillsOk is true (docs/DECISIONS.md "Project skills").
 */
export const MoveBody = z.object({ from: RelPath, to: RelPath, onExists: z.enum(['fail', 'rename']).default('fail'), confirm: z.boolean().default(false), skillsOk: z.boolean().default(false) })
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
  /** the content as it is now and who saved it (author null: not known, e.g. changed outside the app); null: the file
   * does not exist. `version`: the number it has in the list (one above the newest stored version). */
  current: z.object({
    version: z.number().int().positive(),
    sha256: z.string(),
    size: z.number().int().nonnegative(),
    author: UserRef.nullable(),
    turnId: Uuid7.nullable(),
    at: IsoTime.nullable(),
  }).nullable().optional(),
  /** created / edited / moved / renamed / copied / restored, by whom and in which AI turn (newest first) */
  events: z.array(FileHistoryEvent).optional(),
})
export type HistoryResponse = z.infer<typeof HistoryResponse>
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
// '(' and ')' are encoded too (encodeURIComponent keeps them): a Markdown link to 'Report (final).pptx' or a
// conflict copy then has no bare parenthesis that a renderer or a model can cut the URL at.
const urlPart = (s: string) => encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29')
export function fileShareUrl(path: string, mode: 'preview' | 'download', at?: SourceLoc | null): string {
  const q = 'path=' + urlPart(path)
  return mode === 'preview' ? `${FILE_VIEW_PATH}?${q}${at ? locQuery(at) : ''}` : `/api/files/download?${q}&disposition=attachment`
}

/** The place in the file as query parameters of a preview link: &page=12, &sheet=…&range=A1:F40, &slide=3 (a heading
 * has none: Word and Hangul previews open at the top). */
export function locQuery(at: SourceLoc): string {
  switch (at.kind) {
    case 'page': return `&page=${at.page}`
    case 'slide': return `&slide=${at.slide}`
    case 'sheet': return `&sheet=${urlPart(at.sheet)}${at.range ? `&range=${at.range}` : ''}`
    default: return ''
  }
}

/** The place a preview link names (locQuery), or null. Anything malformed is ignored, never guessed. */
export function locFromQuery(q: URLSearchParams): SourceLoc | null {
  const n = (v: string | null) => (v && /^\d{1,7}$/.test(v) && Number(v) > 0 ? Number(v) : null)
  const page = n(q.get('page'))
  if (page) return { kind: 'page', page }
  const slide = n(q.get('slide'))
  if (slide) return { kind: 'slide', slide }
  const sheet = q.get('sheet')
  if (sheet && sheet.length <= 200) {
    const range = q.get('range')
    return SourceLoc.safeParse({ kind: 'sheet', sheet, ...(range ? { range } : {}) }).data ?? { kind: 'sheet', sheet }
  }
  return null
}

// ---------------- attachments + upload sessions ----------------
export const AttachmentUploadFields = z.object({ chatId: Uuid7, name: z.string().min(1).max(255).optional(), size: SentSize })
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

// ---------------- team files in chats (the composer's "Add from team files") ----------------
/** Attach a team-folder file to an own chat by reference (no copy). Files the caller cannot read, server folders,
 * other people's users/<id>/ and odd paths all answer the same 404 as a file that does not exist. */
export const AttachTeamFileBody = z.object({ chatId: Uuid7, path: RelPath })
/** A chip taken out of the box before sending. `trashed`: the file it attached was the person's computer upload into a
 * shared project chat, still unchanged in the project folder, and went to the team trash (restorable from Files > Trash). */
export const DiscardAttachmentResult = z.object({ trashed: z.boolean() })
/** Name search over the files the caller can read (the same check as the file screen's tree). */
export const FindFilesQuery = z.object({
  q: z.string().trim().min(1).max(200),
  /** optional folder to search under (default: the whole team folder) */
  path: RelPath.default(''),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
/** Content search for people (the file screen, R2-ETC-02): the query is literal text, never a pattern. */
export const FILE_SEARCH_QUERY_MAX = 200
export const FILE_SEARCH_LIMIT_MAX = 100
export const SearchFileContentsQuery = z.object({
  /** literal text on one line (ripgrep searches line by line, so a line break is refused; a NUL would cut the query
   * where it goes to ripgrep, so all control characters but a tab are refused) */
  q: z.string().trim().min(1).max(FILE_SEARCH_QUERY_MAX).refine((s) => !/\p{Cc}/u.test(s.replace(/\t/g, ' ')), 'one line of text only, no control characters'),
  /** optional folder to search under (default: the whole team folder) */
  path: RelPath.default(''),
  limit: z.coerce.number().int().min(1).max(FILE_SEARCH_LIMIT_MAX).default(50),
})
/** One matching line. `snippet` is a short part of the line around the first match (plain text, not HTML). */
export const FileContentHit = z.object({
  path: z.string(),
  name: z.string(),
  line: z.number().int().positive(),
  snippet: z.string(),
})
export type FileContentHit = z.infer<typeof FileContentHit>
/** One document the knowledge graph found for the query (docs/KNOWLEDGE-GRAPH.md): `snippet` is a short part of its best
 * passage (plain text, not HTML), `loc` that passage's place (page, sheet, slide or heading; null when not known). */
export const FileContentDocument = z.object({
  path: z.string(),
  name: z.string(),
  loc: SourceLoc.nullable(),
  snippet: z.string(),
})
export type FileContentDocument = z.infer<typeof FileContentDocument>
export const FileContentHits = z.object({
  items: z.array(FileContentHit),
  /** documents the knowledge graph found, one row per document, best first: only files the caller can open now, under
   * the folder searched. Absent when the documents part of the knowledge graph is off (and from older servers). */
  documents: z.array(FileContentDocument).optional(),
  /** more lines matched than the limit; the person should narrow the search */
  truncated: z.boolean(),
  /** the time limit stopped the search; the list can be incomplete */
  timedOut: z.boolean(),
  /** office documents that were not searched because their text is not made yet, and that the background indexer
   * has in its queue or extracts now; a later search can find more */
  indexing: z.number().int().nonnegative(),
  /** office documents that were not searched because their text is not made yet, and that the background queue did
   * not take (the person already has the most files in the queue); a later search adds them */
  notQueued: z.number().int().nonnegative(),
  /** office documents that were not searched because reading their text took too long (a busy server, a very complex
   * file: a converter stopped by its limit); a search a few minutes later reads them again (files/search.ts OFFICE_RETRY_MAX) */
  retryLater: z.number().int().nonnegative(),
  /** matching lines that were skipped because their ripgrep record was longer than 64 K characters (a very long line,
   * or a long line with very many matches) */
  longSkipped: z.number().int().nonnegative(),
})
export type FileContentHits = z.infer<typeof FileContentHits>
export const RecentFilesQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) })
export const FileList = z.object({ items: z.array(FileEntry), truncated: z.boolean() })
export type FileList = z.infer<typeof FileList>

/** The file preview's "PDF로 저장" of an .html file (server/src/team-files/html-pdf-save.ts): the page printed by the
 * server's headless browser, saved next to it. `blocked`: references it did not load (web addresses, files not
 * everyone who can read the page can read); `scripts`: the page has scripts, which do not run when printing. */
export const HtmlPdfSaved = z.object({ entry: FileEntry, pages: z.number().int().min(1), blocked: z.number().int().min(0), scripts: z.boolean() })
export type HtmlPdfSaved = z.infer<typeof HtmlPdfSaved>

export const FILES = {
  tree: endpoint({ method: 'GET', path: '/api/files/tree', auth: 'user', owner: 'C', query: TreeQuery, response: TreeResponse, summary: 'List a folder (only what the caller may see; ancestors of visible folders shown for navigation).' }),
  content: endpoint({ method: 'GET', path: '/api/files/content', auth: 'user', owner: 'C', query: ContentQuery, response: FileContent, summary: 'Text content for preview / editing.' }),
  saveContent: endpoint({ method: 'PUT', path: '/api/files/content', auth: 'user', owner: 'C', body: SaveContentBody, response: SaveResult, summary: 'Save a text file from the file screen (hash-based conflict copy, version history).' }),
  download: endpoint({ method: 'GET', path: '/api/files/download', auth: 'user', owner: 'C', query: DownloadQuery, response: stream(true), summary: 'Stream a file (Range supported, never loaded whole into memory).' }),
  hwpPreview: endpoint({ method: 'GET', path: '/api/files/hwp-preview', auth: 'user', owner: 'C', query: HwpPreviewQuery.extend({ path: RelPath }), response: HwpPreviewPage, summary: 'Authorized HWP/HWPX raster page. Pages are 1-based. Original download stays available.' }),
  preview: endpoint({ method: 'GET', path: '/api/files/preview', auth: 'user', owner: 'C', query: PathQuery, response: stream(false), summary: 'JPEG preview of a HEIC / HEIF photo (converted on the server, cached). No converter or a failed conversion: 503 unavailable with params.reason no_preview.' }),
  saveHtmlPdf: endpoint({ method: 'POST', path: '/api/files/html-pdf', auth: 'user', owner: 'C', status: 201, body: PathQuery, response: HtmlPdfSaved, summary: 'Print an .html file to PDF on the server (as a browser prints it; no network, no scripts) and save it next to the page, named like the page with .pdf (" (2)" when taken). Read access to the page, write access to its folder (403 read-only otherwise). No browser on the server: 503 unavailable with params.reason unavailable; busy: reason busy.' }),
  downloadHtmlPdf: endpoint({ method: 'GET', path: '/api/files/html-pdf', auth: 'user', owner: 'C', query: PathQuery, response: stream(false), summary: 'The same PDF of an .html file as an attachment; nothing is saved (read access to the page).' }),
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

  uploadAttachment: endpoint({ method: 'POST', path: '/api/uploads', auth: 'user', owner: 'C', status: 201, body: multipart(AttachmentUploadFields, SMALL_UPLOAD_MAX), response: Attachment, summary: 'Attach a file (≤ 50 MB) to an own chat: stored in users/<me>/.attachments/<chatId>/. In a shared project chat the caller sees: saved in the project\'s chat attachments folder (named in the team\'s language, made when missing; a taken name gets " (2)") and attached as a team file (source team); 403 shared_upload_read_only without write access there.' }),
  attachmentThumbnail: endpoint({ method: 'GET', path: '/api/uploads/:id/thumbnail', auth: 'user', owner: 'C', response: stream(false), summary: 'Small JPEG/PNG thumbnail of an image attachment (a team file: the image itself, up to 2 MB, while the caller can read it).' }),
  attachTeamFile: endpoint({ method: 'POST', path: '/api/attachments/team-file', auth: 'user', owner: 'C', status: 201, body: AttachTeamFileBody, response: Attachment, summary: 'Attach a team-folder file the caller can read to an own chat, as a reference (re-checked on every send and turn).' }),
  discardAttachment: endpoint({ method: 'DELETE', path: '/api/attachments/:id', auth: 'user', owner: 'C', response: DiscardAttachmentResult, summary: 'Take an unsent team-file attachment of the caller out of its chat. A file they uploaded from their computer into a shared project chat, never sent and unchanged in its place, goes to the team trash (trashed: true); anything else stays where it is.' }),
  findFiles: endpoint({ method: 'GET', path: '/api/files/find', auth: 'user', owner: 'C', query: FindFilesQuery, response: FileList, summary: 'Files whose name contains q, among the files the caller can read (newest first).' }),
  searchFileContents: endpoint({ method: 'GET', path: '/api/files/search', auth: 'user', owner: 'C', query: SearchFileContentsQuery, response: FileContentHits, summary: 'Lines that contain q (literal text, any case) in the files the caller can read, office documents through their text cache; with the knowledge graph\'s documents part on, also the documents it finds (documents: one row each, its best passage and place). Rate limited per person.' }),
  recentFiles: endpoint({ method: 'GET', path: '/api/files/recent', auth: 'user', owner: 'C', query: RecentFilesQuery, response: FileList, summary: 'Recently changed files the caller can read (for the attach picker).' }),
  createUploadSession: endpoint({ method: 'POST', path: '/api/upload-sessions', auth: 'user', owner: 'C', status: 201, body: CreateUploadSessionBody, response: UploadSession, summary: `Start a chunked upload (${UPLOAD_CHUNK_SIZE / 1024 / 1024} MB chunks). Expires after 24 h.` }),
  uploadChunk: endpoint({ method: 'PUT', path: '/api/upload-sessions/:id/chunks/:n', auth: 'user', owner: 'C', body: binary(UPLOAD_CHUNK_SIZE), response: ChunkResult, summary: 'Store chunk n (0-based). Re-sending a stored chunk is a no-op.' }),
  getUploadSession: endpoint({ method: 'GET', path: '/api/upload-sessions/:id', auth: 'user', owner: 'C', response: UploadSession, summary: 'Which chunks arrived (to resume after a disconnect).' }),
  completeUploadSession: endpoint({ method: 'POST', path: '/api/upload-sessions/:id/complete', auth: 'user', owner: 'C', response: UploadComplete, summary: 'Verify sha256 and move the file into place.' }),
  cancelUploadSession: endpoint({ method: 'DELETE', path: '/api/upload-sessions/:id', auth: 'user', owner: 'C', response: empty, status: 204, summary: 'Drop an unfinished upload.' }),
} as const
