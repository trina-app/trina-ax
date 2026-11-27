// A team file attached to what a connected service sends (a mail's attachment): docs/decisions/
// 20261116-mail-attach-team-file.md. A service's tool takes a file as base64 text in one of its arguments, and the AI
// can neither read a team file's bytes nor write that much text in one call. So the AI
// gives a handle instead, `team-file:<path in the team folder>`, as the whole value where the tool wants the content,
// and the server puts the file's base64 there:
//   - read as the person of the turn as they are now (read permission, a regular file, not held by the safety check);
//   - at most ATTACH_MAX_FILES files and ATTACH_MAX_BYTES together in one call, said plainly when over;
//   - shown first on the connection's own card (the file's name, its size and where it is), which is the consent for
//     the file leaving the team; the card's size limit counts the handle, not the bytes;
//   - checked again after the card (the account, its access, the file unchanged), then swapped in and sent;
//   - without a card (a connection that sends without asking for this person) only in a turn the person watches
//     from their own app.
// Nothing here decides whether the card is shown (tools.ts gate). Only a tool that changes something takes a handle,
// and only in a turn where someone can answer a card (never a scheduled run).
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import type { TurnToolContext } from '../../services'
import { Denied, ToolError } from '../../policy/errors'
import { placeWords } from '../../chat/place-words'
import { CallError } from './service'
import { completeRedactorFor } from './redact'
import { say } from './text'

export const TEAM_FILE_PREFIX = 'team-file:'
/** the files of one call together, in megabytes as mail services count them (1 MB = 1,000,000 bytes): base64 makes
 * 18 MB 24 MB, its line breaks (76 characters + CRLF) 24.6 MB, which with the mail's own text and headers stays under
 * what one mail takes (Gmail and Outlook.com: 25 MB; second limits audit N26: 10 MiB before) */
export const ATTACH_MAX_BYTES = 18_000_000
/** the card lists every file; the bytes above are the real limit */
export const ATTACH_MAX_FILES = 20
const DEPTH_MAX = 12
const PATH_MAX = 1000

/** One file to attach: the handle as the AI gave it, the file as it was read before the card. */
export interface AttachedFile { handle: string; rel: string; name: string; size: number; sha256: string; identity: string; bytes: Buffer }

/** sizes as a mail service shows them (1 MB = 1,000,000 bytes, like the limit) */
const human = (n: number) => (n < 1000 ? `${n} B` : n < 1_000_000 ? `${Math.round(n / 1000)} KB` : `${(n / 1_000_000).toFixed(1)} MB`)
/** a size next to the limit it is over: two decimals, so "18.00 MB" is never said to be over "18.0 MB" by rounding */
const exact = (n: number) => (n < 1_000_000 ? human(n) : `${(Math.ceil(n / 10_000) / 100).toFixed(2)} MB`)
const quote = (s: string) => s.replace(/[\u0000-\u001f\u007f"]/g, ' ').slice(0, 200)

/** The handles in a call's arguments: every text value that is `team-file:<path>` as a whole, each time it stands
 * there, in the call's order (a handle given twice is refused by readTeamFiles: the swap would send the file twice
 * while the card and the size cap counted it once). A handle inside a longer text is not one (it is sent as text). */
export function teamFileHandles(args: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (depth > DEPTH_MAX || out.length > 1000) return
    if (typeof v === 'string') { if (v.startsWith(TEAM_FILE_PREFIX)) out.push(v) }
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1)
    else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1)
  }
  walk(args, 0)
  return out
}

/** How a refusal reads for one caller: a connection's call (a mail's attachment) or the in-app browser's file_upload. */
export interface OutgoingWords {
  /** the first words of every refusal: "Nothing was sent" / "Nothing was attached" */
  nothing: string
  /** said after "too large": what the AI tells the user then */
  tooLarge: string
  /** "attached to one message" / "attached in one call" */
  per: string
  /** how the AI names a team file there */
  pathHint: string
}

/** One file named for an outgoing call: the value the AI gave, and the team path in it. */
export interface OutgoingName { handle: string; path: string }

/**
 * The team files behind the names, read as the person of this turn (team-file handles of a connection's call, and
 * file_upload's team paths): CallError (nothing leaves) for a file that is not there or not theirs to read (said
 * alike), a folder, a file held by the safety check, more than `maxFiles`, more than `maxBytes` together, the same file
 * twice, or a file that holds one of the person's stored connection keys (scanForStoredKeys). `before`: bytes other
 * files of the same call already take (file_upload's chat files).
 */
export function readOutgoingTeamFiles(ctx: AppContext, tc: TurnToolContext, names: OutgoingName[], o: { maxFiles: number; maxBytes: number; words: OutgoingWords; before?: { count: number; bytes: number } }): AttachedFile[] {
  const w = o.words
  const count = names.length + (o.before?.count ?? 0)
  if (count > o.maxFiles) throw new CallError(`${w.nothing}: one call can attach at most ${o.maxFiles} team files, and this one names ${count}. Send fewer at a time.`, 'refused (too many attachments)')
  if (new Set(names.map((n) => n.path)).size !== names.length) throw new CallError(`${w.nothing}: the same team file is named more than once in this call. Attach each file once.`, 'refused (attachment named twice)')
  const files: AttachedFile[] = []
  let total = o.before?.bytes ?? 0
  const others = () => files.length || (o.before?.count ?? 0)
  const tooLarge = (name: string, size: number) => new CallError(
    `${w.nothing}: "${quote(name)}" is ${exact(size)}${others() ? ` (${exact(total + size)} with the other files)` : ''}, and the files ${w.per} can be at most ${human(o.maxBytes)} together. ${w.tooLarge}`,
    'refused (attachment too large)')
  for (const n of names) {
    const input = n.path.trim()
    const notFound = () => new CallError(`${w.nothing}: there is no team file "${quote(input)}" that the user can read. ${w.pathHint}`, 'refused (attachment not found)')
    if (!input || input.length > PATH_MAX) throw notFound()
    let src: ReturnType<AppContext['files']['outgoingSource']>
    try { src = ctx.files.outgoingSource(tc.files, input, o.maxBytes - total) } catch (e) {
      if (e instanceof ToolError && e.code === 'is_folder') throw new CallError(`${w.nothing}: "${quote(input)}" is a folder; only a file can be attached.`, 'refused (attachment is a folder)')
      if (e instanceof ToolError && e.code === 'safe_ops_quarantined') throw new CallError(`${w.nothing}: "${quote(input)}" is held by the team's safety check, so it cannot be attached. Tell the user.`, 'refused (attachment held)')
      if (e instanceof Denied || e instanceof ToolError) throw notFound()
      throw e
    }
    const name = src.rel.split('/').pop()!
    if ('tooLarge' in src) throw tooLarge(name, src.tooLarge)
    total += src.bytes.length
    files.push({ handle: n.handle, rel: src.rel, name, size: src.bytes.length, sha256: src.hash, identity: src.identity, bytes: src.bytes })
  }
  scanForStoredKeys(ctx, tc.userId, files, w.nothing)
  return files
}

/**
 * A stored connection key inside a file would leave with it, where no card line shows it: as for base64 the AI writes
 * itself (hide-args.ts DATA_REFUSAL). The file's bytes as text (also as UTF-16, and with its white space taken out: a
 * key cut by a line break). Not looked into: compressed content (the inside of an Office file or a zip, a PDF's packed
 * streams). Fails closed when the keys cannot be read now.
 */
export function scanForStoredKeys(ctx: AppContext, userId: string, files: readonly { name: string; bytes: Buffer }[], nothing: string): void {
  if (!files.length) return
  const r = completeRedactorFor(ctx, userId)
  if (!r) throw new CallError(`${nothing}: one of the user's stored connection keys could not be read just now, so the file to attach could not be checked for it. Try again in a moment; if it keeps failing, tell the user.`, 'refused (stored keys could not be read)')
  if (r.withheld) throw new CallError(`${nothing}: one of the user's stored connection keys could not be checked just now, so the file to attach could not be checked for it. Try again in a moment; if it keeps failing, tell the user.`, 'refused (stored keys could not be read)')
  if (!r.res.length) return
  for (const f of files) {
    const text = f.bytes.toString('latin1')
    const flat = text.replace(/\s+/g, '')
    const wide = f.bytes.toString('utf16le')
    if (r.hide(text) !== text || r.hide(flat) !== flat || r.hide(wide) !== wide) throw new CallError(`${nothing}: the file "${quote(f.name)}" holds one of the user's stored connection keys, and a file cannot be sent with the key taken out. Tell the user; do not try it another way.`, 'refused (a stored key in the attachment)')
  }
}

/**
 * The files behind the handles of a connection's call, read as the person of this turn (readOutgoingTeamFiles with a
 * mail's limits and words).
 */
export function readTeamFiles(ctx: AppContext, tc: TurnToolContext, connection: string, handles: string[]): AttachedFile[] {
  return readOutgoingTeamFiles(ctx, tc, handles.map((h) => ({ handle: h, path: h.slice(TEAM_FILE_PREFIX.length) })), {
    maxFiles: ATTACH_MAX_FILES, maxBytes: ATTACH_MAX_BYTES,
    words: { nothing: 'Nothing was sent', per: 'attached to one message', pathHint: `After "${TEAM_FILE_PREFIX}" give the file's path in the team folder, as glob or list shows it.`, tooLarge: `Tell the user in plain words that the file is too large to attach here; offer to send a link to the file instead, or they can attach it themselves in ${connection}.` },
  })
}

/** The files as the card's first lines, in the person's language: "첨부할 팀 파일  견적서.pdf (124 KB)\n부서 › 영업 › 견적서".
 * The name is the file's own in the team folder; the name the receiver sees is the tool's own argument, on its line. */
export function attachedLines(ctx: AppContext, files: AttachedFile[], L: Locale, me: string): { name: string; value: string }[] {
  return files.map((f) => {
    const folder = f.rel.split('/').slice(0, -1).join('/')
    return { name: say('attachedFile', L), value: `${f.name} (${human(f.size)})\n${placeWords(ctx.db, folder, L, me)}` }
  })
}

/** After the card, right before the call (synchronous): the account, its access now and each file's identity. */
export function recheckTeamFiles(ctx: AppContext, tc: TurnToolContext, files: AttachedFile[]): void {
  for (const f of files) {
    try { ctx.files.recheckOutgoing(tc.files, { rel: f.rel, identity: f.identity }) } catch (e) {
      if (e instanceof Denied || e instanceof ToolError) throw new CallError(`Nothing was sent: the file "${quote(f.name)}" changed, or the user's access to it changed, while the user was asked. Try again.`, 'refused (attachment changed)')
      throw e
    }
  }
}

/** The call's arguments with each handle replaced by its file's base64 (standard, no line breaks). */
export function withTeamFiles(args: unknown, files: AttachedFile[]): unknown {
  const by = new Map(files.map((f) => [f.handle, f]))
  const data = new Map<string, string>()
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > DEPTH_MAX) return v
    if (typeof v === 'string') {
      const f = by.get(v)
      if (!f) return v
      let b = data.get(v)
      if (b === undefined) { b = f.bytes.toString('base64'); data.set(v, b) }
      return b
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, depth + 1)]))
    return v
  }
  return walk(args, 0)
}

/** For the audit line (tool_events.summary): which files left, by path, size and hash; never their content. */
export const attachedSummary = (files: AttachedFile[]) => files.map((f) => `${f.rel.length > 160 ? '…' + f.rel.slice(-159) : f.rel} ${f.size} B sha256 ${f.sha256.slice(0, 16)}`).join(', ').slice(0, 700)

/** How the AI attaches a team file: one line of its instructions about connected services (tools.ts). */
export const ATTACH_HOW = `To attach a team file to what a service sends (a mail's attachment): where the tool takes the file's content as base64 text, give "${TEAM_FILE_PREFIX}<the file's path in the team folder>" as that whole value (for example {"filename": "quote.pdf", "content": "${TEAM_FILE_PREFIX}shared/quotes/quote.pdf"}), and the file's name where the tool takes one. The server puts the file itself there after the user's OK on the card; never read a file to write its base64 yourself. At most ${ATTACH_MAX_FILES} files and ${human(ATTACH_MAX_BYTES)} together in one call; if a file is larger, say so plainly and offer a link instead. Not in a scheduled run. Apps on the user's computer (Aside, ego lite: their tools take code or a task) cannot attach one, a web mail opened there included: say so before you start, never promise it, and offer a connected mail service that takes attachments, the desktop app's browser (its file_upload, where offered), a link to each file, or the user attaching them.`
