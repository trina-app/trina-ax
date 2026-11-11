// A Gmail attachment the AI reads (docs/GOOGLE-APPS.md "Attachments", owner decision 8): the library hands its bytes back
// inline as base64 (get_gmail_attachment_content with return_base64, its stateless mode keeps nothing on disk); Trina
// turns them into what the AI can use with the same readers as drive_read (tools/drive.ts: PDF text layer, Hangul and
// Office files through files/extract.ts, pictures through the vision converter) and never hands the model base64.
// A copy goes into the team files only when the person asks: a PDF or a picture is kept for this chat like any
// connection's file (connections/media.ts) and saved with save_url; other kinds are saved from their text with the file
// tools.
import type { AppContext } from '../../context'
import type { TurnToolContext } from '../../services'
import { extractText, looksScanned } from '../../files/extract'
import { sniffKind } from '../../tools/sniff'
import { putMedia, MEDIA_PREFIX } from '../connections/media'

/** the library's base64 block (gmail_tools.py _format_base64_content_block) */
const BLOCK = /\n*📦 Base64 content \(\d+ chars, standard base64\):\n([A-Za-z0-9+/=\r\n]+)/u
/** the stateless mode's short preview of the same bytes, left out too */
const PREVIEW = /\n*Base64-encoded content \(first 100 characters shown\):\n[^\n]*/u
/** what files/extract.ts reads as text */
const READABLE = new Set(['pdf', 'docx', 'pptx', 'odt', 'xlsx', 'xls', 'ods', 'hwp', 'hwpx', 'txt', 'csv', 'md', 'json', 'xml', 'html', 'htm', 'eml', 'ics', 'vcf'])
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tiff', 'bmp'])
const MAX_TEXT = 30_000
/** the largest attachment one answer can carry: its base64 (4/3 of it) and the rest of the answer must fit in
 * MCP_CALL_MAX_BYTES (25 MB), or the answer comes back cut off */
export const ATTACHMENT_MAX_BYTES = 18 * 1024 * 1024
/** what the AI is told about an attachment too large to read */
export const tooLargeMessage = (name: string | null) => `The attachment${name ? ` "${name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200)}"` : ''} is larger than about 18 MB, so it was not read. Tell the user to open it in Gmail.`

/** the reader for these bytes: the file's own first bytes for PDFs and pictures, else the name the message listed */
export function readerExt(bytes: Uint8Array, fileName: string | null): string | null {
  const k = sniffKind(bytes)
  if (k && (k.image || k.name === 'pdf')) return k.ext
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(fileName ?? '')
  const ext = m ? m[1]!.toLowerCase() : null
  // a name that says PDF, PNG, JPEG, GIF or WebP over bytes that are not: not read as that (the others' bytes are
  // checked by their converter)
  if (!ext || ext === 'pdf' || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return null
  return READABLE.has(ext) || IMAGES.has(ext) ? ext : null
}

export interface ReadAttachment { text: string; images: { type: 'image'; data: string; mimeType: string }[] }

/**
 * The tool result's text with the base64 replaced by what the attachment says. `text`: the library's answer as the
 * MCP client gave it (secrets hidden already). Unchanged when it holds no attachment bytes.
 */
export async function readAttachment(ctx: AppContext, tc: TurnToolContext, o: { chatId: string; integrationId: string }, text: string, fileName: string | null): Promise<ReadAttachment> {
  // the size the answer declares (its base64 length) before the bytes are decoded
  const declared = /📦 Base64 content \((\d+) chars/u.exec(text)
  if (declared && Number(declared[1]) > Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4) return { text: tooLargeMessage(fileName), images: [] }
  const m = BLOCK.exec(text)
  if (!m) return { text: text.replace(PREVIEW, ''), images: [] }
  const rest = text.replace(BLOCK, '').replace(PREVIEW, '')
  const bytes = Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64')
  const name = fileName ? fileName.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : null
  const lines: string[] = [rest.trim(), '', `--- ATTACHMENT${name ? ` "${name}"` : ''} (${bytes.length} bytes) ---`]
  const images: ReadAttachment['images'] = []
  if (bytes.length > ATTACHMENT_MAX_BYTES) return { text: tooLargeMessage(name), images: [] }
  if (!bytes.length) {
    lines.push('It is empty.')
    return { text: lines.join('\n'), images }
  }
  const ext = readerExt(bytes, name)
  const kind = sniffKind(bytes)
  try {
    if (ext && IMAGES.has(ext)) {
      const shown = await ctx.files.imageForModel(tc.files, `attachment.${ext}`, bytes, tc.signal)
      lines.push(shown.text)
      if (shown.jpeg) images.push({ type: 'image', mimeType: 'image/jpeg', data: shown.jpeg.toString('base64') })
    } else if (ext) {
      const t = await extractText(`attachment.${ext}`, bytes, { pandoc: ctx.engineConfig.pandoc, pdftotext: ctx.engineConfig.pdftotext, ocr: ctx.engineConfig.ocr, quarantine: ctx.files.quarantine, textLayerOnly: true }, tc.signal)
      lines.push(t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n(cut to ${MAX_TEXT} characters)` : t)
      if (ext === 'pdf' && looksScanned(t)) lines.push('Some pages have no text layer (scans or pictures), so their content is not in this text.')
    } else lines.push(`This kind of file cannot be read here${name ? ` (${name})` : ''}.`)
  } catch (e) {
    if (tc.signal.aborted) throw e
    lines.push('It could not be read as text.')
  }
  lines.push('--- END OF ATTACHMENT ---')
  // a PDF or a picture: kept for this chat, so it can be saved when the person asks (save_url, into their own folder
  // unless they name another one); other kinds are saved from their text with the file tools
  let handle: string | null = null
  if (kind && (kind.image || kind.name === 'pdf')) {
    try {
      const meta = putMedia(ctx.engineConfig.dataDir, { chatId: o.chatId, userId: tc.userId, integrationId: o.integrationId, bytes, declared: kind.mime })
      if (meta) handle = `${MEDIA_PREFIX}${meta.id}`
    } catch (e) { ctx.log.warn('attachment not kept', { err: e }) }
  }
  lines.push(handle
    ? `Only if the user asks to keep it in the team files: save_url with "${handle}", into the user's own folder unless they name another one.`
    : 'Only if the user asks to keep it in the team files: write its text into a file in the user\'s own folder unless they name another one.')
  return { text: lines.join('\n'), images }
}

/** Attachments of a Gmail send or draft given by web address or file path: the library would fetch the address or
 * read a file on this server. Only attachments whose content (base64) comes with the call are sent. */
export function addressedAttachments(args: unknown): boolean {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>).attachments : undefined
  if (a === undefined || a === null) return false
  if (!Array.isArray(a)) return true
  return a.some((x) => !x || typeof x !== 'object' || 'url' in x || 'path' in x || 'display_url' in x || '_resolved_bytes' in x)
}
