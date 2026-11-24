// The Office safety check where a file the AI built leaves its run (docs/decisions/20261124-doc-skills.md): a Word,
// PowerPoint or Excel file copied out of the work folder (save_work_file, copy_files, a chat attachment, a new version of
// a chat file) or written straight into a team folder by a run (devenv/track.ts). The same scan as make_file's
// (office-links-check.ts, in the office worker): no file: or \\host\share link (it hands the reader's Windows sign-in to
// that host), no embedded or linked object, no linked picture, no field that runs something, no macro project. An edit
// keeps what the file it came from already had, so a company template with its own links still works: only items the
// earlier versions did not hold are refused.
import { officeWorkerWrite } from './extract'
import { OFFICE_EXIT_MODE } from './office-links-check'

const KINDS: Record<string, 'docx' | 'pptx' | 'xlsx'> = {
  docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx',
  pptx: 'pptx', pptm: 'pptx', potx: 'pptx', potm: 'pptx', ppsx: 'pptx', ppsm: 'pptx',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', xltm: 'xlsx',
}
/** earlier versions given to the check, at most (bytes in all) */
export const OFFICE_EXIT_EARLIER_MAX = 64 * 1024 * 1024

/** the kind of an Office file by its name, or null */
export function officeKind(name: string): 'docx' | 'pptx' | 'xlsx' | null {
  const i = name.lastIndexOf('.')
  return i > 0 ? KINDS[name.slice(i + 1).toLowerCase()] ?? null : null
}

/** The file checked: its bytes to save (an attached template taken out), or a ToolError (code office_unsafe or the
 * worker's) naming what is not allowed. `earlier`: versions it may keep items from. */
export async function officeExitCheck(name: string, bytes: Uint8Array, earlier: Uint8Array[], signal?: AbortSignal): Promise<Uint8Array> {
  const kind = officeKind(name)
  if (!kind) return bytes
  let room = OFFICE_EXIT_EARLIER_MAX
  const kept = earlier.filter((e) => { if (e.length > room) return false; room -= e.length; return true })
  const head = new TextEncoder().encode(JSON.stringify({ kind, sizes: [bytes.length, ...kept.map((e) => e.length)] }))
  const req = new Uint8Array(4 + head.length + bytes.length + kept.reduce((n, e) => n + e.length, 0))
  new DataView(req.buffer).setUint32(0, head.length)
  req.set(head, 4)
  let at = 4 + head.length
  for (const part of [bytes, ...kept]) { req.set(part, at); at += part.length }
  return new Uint8Array(await officeWorkerWrite(OFFICE_EXIT_MODE, req, signal))
}
