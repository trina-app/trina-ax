// A chat shared with people "with files" (docs/decisions/20261121-share-chat-files.md) keeps a copy of each file the
// chat made in its creator's own folder; the answers' text still names the original (users/<creator>/…). Inside that
// chat such a path means the chat's copy for everyone, the AI included (plan docs/AGENTS/plan/
// 20261122-0503-shared-chat-copy-paths.md):
//   mapCopyPaths   a tool call's path arguments that name a copied original become the copy's chat place path
//                  (chat:files/<id>/<name>, shared/src/places.ts), so a read opens the copy and an edit, write,
//                  edit_office or edit_pdf saves a new version of it (ChatFiles.putVersion), for whoever asks; the
//                  original is never opened. chat/tools.ts mapPaths runs it before every other step of a call
//   mapCopyText    an answer's text as a transcript gives it to the AI: every copied original path (as written, or
//                  URL-encoded) as the copy's chat place path (chat/shared.ts labelledTranscript)
// Only paths recorded as copied into this chat (chat-files-share.ts sharedCopyMap): any other team path keeps its team
// handling. Tools about the original itself (who can open it, sharing it, moving, renaming or deleting it) keep it.
import type { Attachment } from '@mycel/shared/api'
import { chatFilePath } from '@mycel/shared/places'
import { copyKey } from './chat-files-share'

/** Tools whose path names the team file itself (its place, its people, its name), never its content: kept as written */
export const KEEPS_ORIGINAL: ReadonlySet<string> = new Set([
  'delete_files', 'move_files', 'rename_file', 'rename_files', 'who_can_open', 'share_with_person', 'stop_sharing',
  'share_folder', 'folder_access', 'share_file', 'save_work_file',
])

/** The arguments mapped: the files a call reads or changes in place, never a destination (a folder, a new file's
 * place, `save_as`): rooms/ai-tools.ts PATH_ARGS without those, and merge_pdfs' `files` */
const SOURCE_ARGS: readonly string[] = ['file_path', 'path', 'source', 'template', 'from', 'file_paths', 'paths', 'sources', 'images', 'image', 'files', 'output']
/** `output` names the file changed in place only here (an existing chat file's path there is a new version of it:
 * chat/tools.ts officeVersionPlace) */
const IN_PLACE_OUTPUT: ReadonlySet<string> = new Set(['edit_pdf', 'edit_office'])

type Copies = ReadonlyMap<string, Pick<Attachment, 'id' | 'name'>>

/** The copy's chat place path for one path argument, or null when it names no copied original */
function placeOf(v: string, copies: Copies): string | null {
  let key = copyKey(v)
  let c = copies.get(key)
  if (!c && /%[0-9a-f]{2}/i.test(key)) { try { key = copyKey(decodeURI(key)); c = copies.get(key) } catch { /* not encoded */ } }
  return c ? chatFilePath(c.id, c.name) : null
}

/**
 * A tool call's arguments with every path that names a copied original as the copy's chat place path: the top-level
 * path arguments (one string or a list, a list of `{ path }` too) and the files inside edit_pdf's operations
 * (rooms/ai-tools.ts namedPaths). `mapped`: how many were replaced (0: `args` itself comes back).
 */
export function mapCopyPaths(tool: string, args: unknown, copies: Copies): { args: unknown; mapped: number } {
  if (!copies.size || KEEPS_ORIGINAL.has(tool) || !args || typeof args !== 'object' || Array.isArray(args)) return { args, mapped: 0 }
  let mapped = 0
  const one = (v: unknown): unknown => {
    if (typeof v === 'string') { const p = placeOf(v, copies); if (p) { mapped++; return p } return v }
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { path?: unknown }).path === 'string') {
      const p = placeOf((v as { path: string }).path, copies)
      if (p) { mapped++; return { ...v, path: p } }
    }
    return v
  }
  const a: Record<string, unknown> = { ...(args as Record<string, unknown>) }
  for (const k of SOURCE_ARGS) {
    if (k === 'files' && tool !== 'merge_pdfs') continue
    if (k === 'output' && !IN_PLACE_OUTPUT.has(tool)) continue
    if (!(k in a)) continue
    a[k] = Array.isArray(a[k]) ? (a[k] as unknown[]).map(one) : one(a[k])
  }
  if (tool === 'edit_pdf' && Array.isArray(a.operations)) {
    a.operations = (a.operations as unknown[]).map((op) => {
      if (!op || typeof op !== 'object') return op
      const o = { ...(op as Record<string, unknown>) }
      for (const [k, f] of [['insert_pdf', 'file'], ['stamp_image', 'image']] as const) {
        const inner = o[k] as Record<string, unknown> | undefined
        if (inner && typeof inner === 'object' && typeof inner[f] === 'string') { const p = placeOf(inner[f] as string, copies); if (p) { mapped++; o[k] = { ...inner, [f]: p } } }
      }
      return o
    })
  }
  return mapped ? { args: a, mapped } : { args, mapped: 0 }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * An answer's text with every copied original path in it as the copy's chat place path: as the text writes it (with
 * or without a "/" in front) and URL-encoded (a Markdown link's target). Only whole paths: one followed by more of a
 * path or name (a letter, digit, "-", "_", "/", or "." and more of a name) stays; a Korean particle or a sentence's
 * "." right after it does not stop it.
 */
export function mapCopyText(text: string, copies: Copies): string {
  if (!copies.size || !text) return text
  let out = text
  for (const [from, c] of copies) {
    const to = chatFilePath(c.id, c.name)
    // the URL-encoded form (a Markdown link's target) gets the copy's path encoded too, so the link stays one link
    for (const [form, put] of new Map([[from, to], [encodeURI(from), encodeURI(to)]])) {
      if (!out.includes(form)) continue
      // a "." right after it ends a sentence; one followed by more of a name ("a.pdf.bak") is another file
      out = out.replace(new RegExp(`(?<![\\w.\\-/])(?:\\.?/)?${escapeRe(form)}(?![\\w\\-/]|\\.[\\w\\-/])`, 'g'), () => put)
    }
  }
  return out
}
