// A tool call that ends in an error that is not a refusal (not Denied, ToolError, FileError or bad input): what the AI
// is told and what the server log keeps. Before 2026-11-28 the AI got only "Error: internal error" and the cause stayed
// in the audit summary, cut to 200 characters, with nothing in the server log (WSL QA: save_work_file, copy_files and
// make_file failed five times in a row, the log had no line, and the AI sent the user to Admin › System › Storage on a
// disk 1% used). Now every such error is logged once with the tool, the turn and a short reference, and the AI's text
// says whether it was a temporary problem of the server (busy, out of memory or processes, a locked database), what the
// team's storage is really like (only when it was measured), and to try once more before it tells the user.
import crypto from 'node:crypto'
import { silentLogger, type Logger } from '../log'
import { simpleRoom, storageSnapshot, storageState } from '../system/storage'

let sink: Logger = silentLogger
/** The server's logger (context.ts, at start). Tests leave it silent or pass their own. */
export function setInternalErrorLog(log: Logger): void { sink = log }

/** OS and SQLite errors that pass by themselves: the machine was short of memory, processes or file handles, a file
 * or the database was busy for a moment. */
const TRANSIENT = new Set(['EAGAIN', 'ENOMEM', 'EBUSY', 'EMFILE', 'ENFILE', 'ETXTBSY', 'EINTR', 'ETIMEDOUT', 'SQLITE_BUSY', 'SQLITE_LOCKED'])

/** The code of a temporary failure (EAGAIN, ENOMEM, SQLITE_BUSY, ...), or null. */
export function transientCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code === 'string') {
    const c = code.toUpperCase()
    if (TRANSIENT.has(c)) return c
    if (c.startsWith('SQLITE_BUSY')) return 'SQLITE_BUSY'
  }
  const m = String((e as Error | null)?.message ?? '')
  if (/database is locked|SQLITE_BUSY/i.test(m)) return 'SQLITE_BUSY'
  const errno = /\b(EAGAIN|ENOMEM|EBUSY|EMFILE|ENFILE|ETXTBSY)\b/.exec(m)
  return errno ? errno[1]! : null
}

/** What the team's storage is like now, in one sentence for the AI, only when it was measured; '' when it was not. */
export function storageLine(): string {
  try {
    if (storageState().writesRefused) return 'The team\'s storage is full, which may be the cause: an admin sees it in Admin > System. '
    if (!storageSnapshot(true)) return ''
    return simpleRoom(0) === false
      ? 'The server\'s disk is nearly full, which may be the cause: an admin sees it in Admin > System. '
      : 'The team\'s storage has room, so it is not a storage problem: do not send the user to storage settings. '
  } catch { return '' }
}

/** Log one internal error with its context; the short reference the AI may give the user. */
export function logInternalError(what: string, e: unknown, fields: { turnId?: string | null; userId?: string | null } = {}): string {
  const ref = crypto.randomBytes(4).toString('hex')
  const code = (e as { code?: unknown } | null)?.code
  try {
    sink.warn('a tool call failed with an internal error', {
      tool: what.slice(0, 200), ref, ...(fields.turnId ? { turnId: fields.turnId } : {}), ...(fields.userId ? { userId: fields.userId } : {}),
      ...(typeof code === 'string' ? { code } : {}), err: e instanceof Error ? e : String(e).slice(0, 500),
    })
  } catch { /* logging never breaks the answer */ }
  return ref
}

/** The reason of one item of a batch (copy_files, unzip_file, delete_files, query_data), logged. */
export function internalWhy(what: string, e: unknown, fields: { turnId?: string | null; userId?: string | null } = {}): string {
  const ref = logInternalError(what, e, fields)
  const code = transientCode(e)
  return code ? `a temporary problem on the server (${code}, ref ${ref}); try it again` : `internal error (ref ${ref})`
}

/** The whole call's error text for the AI, logged. */
export function internalErrorText(what: string, e: unknown, fields: { turnId?: string | null; userId?: string | null } = {}): string {
  const ref = logInternalError(what, e, fields)
  const code = transientCode(e)
  const kind = code ? `a temporary problem on the server (${code})` : 'an unexpected error on the server'
  return `Error: internal error: ${kind}, ref ${ref}. It was not about access or what you gave the tool. ${storageLine()}`
    + `Do not guess another cause. Try the same call once more; if it fails again, tell the user it failed on the server and that an admin can find ref ${ref} in the server log.`
}
