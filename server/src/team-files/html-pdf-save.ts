// The file preview's "PDF로 저장" for an .html file (web FilePanel): the same server print as make_file's HTML source
// (tools/make-file.ts printTeamHtml, files/html-pdf.ts), done for the person who looks at the page.
// - What goes in: the page and only those of its pictures, stylesheets and fonts that everyone who can read the page can
//   read (team-files/embed.ts, the rule of the page's own preview), each read with the person's access. So the PDF
//   shows what the preview shows, and it can sit next to the page without anyone seeing more than before.
// - Where it goes: next to the page, "<name>.pdf", never over a file ("<name> (2).pdf", as an upload), when the person may
//   write that folder (read-only: 403, the panel then offers the download below). The file event says it was made
//   from the page (action create, detail via html_pdf). The team disk check of uploads applies.
// - Download: the same PDF as an attachment, nothing saved (a read-only folder, or the person's choice).
import fs from 'node:fs'
import path from 'node:path'
import type { FileEntry } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { sourceOf, widening } from '../chat/read-scope'
import { sha256 } from '../files/store'
import { authorize } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { assertStorageRoom } from '../system/storage'
import { HTML_SOURCE_EXT, printTeamHtml, type PrintedHtml } from '../tools/make-file'
import { embedNarrower } from './embed'
import { fileError } from './errors'
import { writeTemp } from './place'
import type { TeamFiles } from './service'

const extOf = (n: string) => /\.([^./]+)$/.exec(n)?.[1]?.toLowerCase() ?? ''
/** "견적서.html" -> "견적서.pdf" */
export const pdfNameOf = (page: string) => page.replace(/\.[^./]+$/, '') + '.pdf'

/** The page printed for `userId` with the preview's rule for its files; HtmlPdf ToolErrors become localized FileErrors. */
async function print(ctx: AppContext, files: TeamFiles, userId: string, page: string, signal?: AbortSignal): Promise<PrintedHtml> {
  const me = files.principal(userId)
  const rules = files.rules()
  const r = authorize(files.fx, rules, me, page, 'read')
  if (r.st!.isDirectory()) fileError('validation', 'isFolder', { path: page })
  if (!HTML_SOURCE_EXT.has(extOf(r.rel))) fileError('validation', 'htmlPdfNotHtml', { path: page })
  try {
    return await printTeamHtml(ctx, files, me, r.rel, { signal, embedOnly: (pageSegs, fileSegs) => !embedNarrower(ctx.db, rules, pageSegs, fileSegs) })
  } catch (e) {
    if (!(e instanceof ToolError) || !e.code.startsWith('html_pdf_')) throw e
    const code = e.code.slice('html_pdf_'.length)
    if (code === 'unavailable') fileError('unavailable', 'htmlPdfUnavailable', undefined, { reason: 'unavailable' })
    if (code === 'busy') fileError('unavailable', 'htmlPdfBusy', undefined, { reason: 'busy' })
    if (code === 'pages') fileError('payload_too_large', 'htmlPdfPages', undefined, { reason: 'pages' })
    if (code === 'too_large' || code === 'html_too_large' || code === 'memory') fileError('payload_too_large', 'htmlPdfTooLarge', undefined, { reason: code })
    if (code === 'timeout') fileError('unavailable', 'htmlPdfTimeout', undefined, { reason: 'timeout' })
    fileError('unavailable', 'htmlPdfFailed', undefined, { reason: code })
  }
}

export interface SavedHtmlPdf { entry: FileEntry; pages: number; blocked: number; scripts: boolean }

/** Print `page` and save the PDF next to it (see the top of this file). */
export async function saveHtmlPdf(ctx: AppContext, files: TeamFiles, userId: string, page: string, signal?: AbortSignal): Promise<SavedHtmlPdf> {
  const me = files.principal(userId)
  const src = authorize(files.fx, files.rules(), me, page, 'read')
  const folder = src.segs.slice(0, -1)
  // before the print: a read-only folder is refused at once (the panel offers the download instead)
  authorize(files.fx, files.rules(), me, folder.join('/'), 'write', { mustExist: true })
  const printed = await print(ctx, files, userId, src.rel, signal)
  assertStorageRoom(printed.pdf.length)
  const name = pdfNameOf(src.segs[src.segs.length - 1]!)
  // nobody may read the PDF who could not read every file in it: true by construction (the page's folder, the preview's
  // rule for its files); checked again here, so a change of that construction cannot widen silently
  const rules = files.rules()
  if (widening(ctx.db, null, [...folder, name], printed.sources.map((p) => sourceOf(ctx.db, rules, p)))) fileError('forbidden', 'embedNarrower', undefined, { reason: 'embed_narrower' })
  const tmp = await writeTemp(path.join(ctx.config.dataDir, 'uploads', 'tmp'), printed.pdf)
  try {
    const entry = await files.placeUpload(userId, folder.join('/'), name, tmp, 'rename', sha256(printed.pdf), { action: 'create', detail: { via: 'html_pdf', from: printed.source, pages: printed.pages, files: printed.sources.slice(1, 51), fileCount: printed.sources.length - 1 } })
    return { entry, pages: printed.pages, blocked: printed.blockedCount, scripts: printed.scripts }
  } finally { fs.rmSync(tmp, { force: true }) }
}

/** Print `page` for a download: the PDF and its file name; nothing is saved. */
export async function htmlPdfDownload(ctx: AppContext, files: TeamFiles, userId: string, page: string, signal?: AbortSignal): Promise<{ pdf: Buffer; name: string }> {
  const printed = await print(ctx, files, userId, page, signal)
  return { pdf: printed.pdf, name: pdfNameOf(printed.source.split('/').pop()!) }
}
