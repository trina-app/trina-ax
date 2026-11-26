// file_upload on the server (docs/decisions/20261126-browser-file-upload.md): the AI names team files (a team path, or
// "team-file:<path>") and files sent in this chat ("chat:files/<name>"); the server reads each as the person of the turn,
// with the checks of a mail attachment (integrations/connections/team-attach.ts: read permission, no folder, the safety
// check, the same file twice, at most BROWSER_UPLOAD_MAX_FILES and _BYTES, the person's stored keys), and the desktop
// app gets a single-use ticket per file (realtime/browser-uploads.ts) instead of the path. No card of its own: the page
// is a site the person already allowed (the desktop's site permit), the person may read the file, and the hard blocks
// stay. A shared chat: the file-read card of a shared chat (turn.ts confirmSharedAttach) for the team files, as for a
// mail attachment there.
import { BROWSER_UPLOAD_MAX_BYTES, BROWSER_UPLOAD_MAX_FILES, type BrowserResult } from '@mycel/shared/api'
import { stepText } from '@mycel/shared'
import { parsePlace } from '@mycel/shared/places'
import { CallError } from '../integrations/connections/service'
import { readOutgoingTeamFiles, scanForStoredKeys, TEAM_FILE_PREFIX, type OutgoingWords } from '../integrations/connections/team-attach'
import { readRegular } from '../files/store'
import { chatFilesOf, seesChatFiles } from './chat-files'
import { chatFileRef } from './chat-file-tool'
import { toolContext } from './tools'
import type { TurnExec } from './turn'

export const UPLOAD_WORDS: OutgoingWords = {
  nothing: 'Nothing was attached',
  per: 'attached in one call',
  pathHint: 'Give the file\'s path in the team folder as glob or list shows it, or chat:files/<name> for a file sent in this chat.',
  tooLarge: 'Tell the user in plain words that the files are too large to attach in one go; attach fewer at a time, or offer that the user attaches the rest in the page themselves.',
}

/** What the old desktop app answers a tool it does not know (main.ts bridge:browser-run, shared parseBrowserToolInput) */
const OLD_APP = /^(Malformed browser call\.|Unknown browser tool|Invalid input for file_upload)/
export const UPDATE_APP_TEXT = 'Nothing was attached: the desktop app on this computer is too old to attach files to a page. Tell the user in plain words to update the desktop app (it updates itself when restarted, or from Settings › Apps), then ask again; meanwhile they can attach the files in the page themselves.'

/** One file ready to go: the bytes as checked, and the check again right before they are served. */
export interface UploadFileReady {
  name: string
  bytes: Buffer
  sha256: string
  /** for the audit line: the team path, or chat:files/<name> */
  where: string
  recheck: () => boolean
}

const quote = (s: string) => s.replace(/[\u0000-\u001f\u007f"]/g, ' ').slice(0, 200)

/**
 * The files of one file_upload call, read and checked as the person of this turn, or the refusal for the AI (nothing
 * is attached then). `step`: the call's step (a shared chat's "not attached" line goes there).
 */
export async function prepareBrowserUpload(exec: TurnExec, args: Record<string, unknown>, step: string): Promise<{ refused: string; summary: string } | { files: UploadFileReady[] }> {
  const { rt, spec } = exec
  const raw = Array.isArray(args.files) ? args.files : null
  const no = (text: string, summary: string) => ({ refused: text, summary: `file_upload -> ${summary}` })
  if (!raw || !raw.length || raw.some((f) => typeof f !== 'string' || !f.trim() || f.length > 1200)) return no(`${UPLOAD_WORDS.nothing}: files must be a list of 1 to ${BROWSER_UPLOAD_MAX_FILES} team file paths (as glob or list shows them) or chat:files/<name>.`, 'refused (bad files)')
  if (raw.length > BROWSER_UPLOAD_MAX_FILES) return no(`${UPLOAD_WORDS.nothing}: one call can attach at most ${BROWSER_UPLOAD_MAX_FILES} files, and this one names ${raw.length}. Attach fewer at a time.`, 'refused (too many attachments)')
  const names = (raw as string[]).map((f) => f.trim())
  const chatRefs = names.filter((n) => parsePlace(n)?.kind === 'chatFiles')
  const team = names.filter((n) => parsePlace(n)?.kind !== 'chatFiles').map((n) => ({ handle: n, path: n.startsWith(TEAM_FILE_PREFIX) ? n.slice(TEAM_FILE_PREFIX.length) : n }))
  const out: UploadFileReady[] = []
  /** where each file stands in the AI's list: they go to the page in that order */
  const at = new Map<UploadFileReady, number>()
  try {
    // files sent in this chat: through the one filtered list, as chat_file reads them (chat-file-tool.ts readChatFile)
    const store = chatFilesOf(rt.ctx)
    const seen = new Set<string>()
    let bytes = 0
    for (const ref of chatRefs) {
      const notFound = new CallError(`${UPLOAD_WORDS.nothing}: no file "${quote(ref)}" was sent in this chat. ${UPLOAD_WORDS.pathHint}`, 'refused (chat file not found)')
      if (!seesChatFiles(rt.db, spec.userId, spec.chatId)) throw notFound
      const id = chatFileRef(ref)
      const chain = id ? store.find(spec.userId, spec.chatId, id, true) : null
      if (!chain) throw notFound
      const file = chain.head
      if (seen.has(chain.id)) throw new CallError(`${UPLOAD_WORDS.nothing}: the same file is named more than once in this call. Attach each file once.`, 'refused (attachment named twice)')
      seen.add(chain.id)
      if (store.kCarried(file)) throw new CallError(`${UPLOAD_WORDS.nothing}: "${quote(file.name)}" came with an answer that is kept from some people who may join this chat, so it is not attached.`, 'refused (chat file carried by a hidden answer)')
      if (rt.ctx.files.quarantine.hasHash(file.sha256)) throw new CallError(`${UPLOAD_WORDS.nothing}: "${quote(file.name)}" is held by the team's safety check, so it cannot be attached. Tell the user.`, 'refused (attachment held)')
      if (bytes + file.size > BROWSER_UPLOAD_MAX_BYTES) throw new CallError(`${UPLOAD_WORDS.nothing}: the files attached in one call can be at most ${BROWSER_UPLOAD_MAX_BYTES / 1_000_000} MB together. ${UPLOAD_WORDS.tooLarge}`, 'refused (attachment too large)')
      const open = () => { const o = store.open(spec.userId, spec.chatId, file.id, false); return o.quarantined || o.sha256 !== file.sha256 ? null : o }
      const o = open()
      if (!o) throw notFound
      const read = readRegular(o.abs, BROWSER_UPLOAD_MAX_BYTES - bytes)
      bytes += read.bytes.length
      const ready: UploadFileReady = {
        name: file.name, bytes: read.bytes, sha256: file.sha256, where: `chat:files/${file.name}`,
        recheck: () => { try { exec.livePrincipal(); return seesChatFiles(rt.db, spec.userId, spec.chatId) && !!open() && !rt.ctx.files.quarantine.hasHash(file.sha256) } catch { return false } },
      }
      out.push(ready)
      at.set(ready, names.indexOf(ref))
    }
    scanForStoredKeys(rt.ctx, spec.userId, out, UPLOAD_WORDS.nothing)
    if (team.length) {
      const tc = toolContext(exec, exec.files)
      const files = readOutgoingTeamFiles(rt.ctx, tc, team, { maxFiles: BROWSER_UPLOAD_MAX_FILES, maxBytes: BROWSER_UPLOAD_MAX_BYTES, words: UPLOAD_WORDS, before: { count: out.length, bytes } })
      // a shared chat: someone here who cannot open one of these files gets the asker's file-read card first
      const said = await exec.confirmSharedAttach(files.map((f) => f.rel), step)
      if (said) return no(said, 'not attached (shared chat: file read card)')
      for (const f of files) {
        const ready: UploadFileReady = {
          name: f.name, bytes: f.bytes, sha256: f.sha256, where: f.rel,
          recheck: () => { try { rt.ctx.files.recheckOutgoing(toolContext(exec, exec.files).files, { rel: f.rel, identity: f.identity }); return !rt.ctx.files.quarantine.hasHash(f.sha256) } catch { return false } },
        }
        out.push(ready)
        at.set(ready, names.indexOf(f.handle))
      }
    }
  } catch (e) {
    if (e instanceof CallError) return no(e.message, e.kind)
    throw e
  }
  return { files: out.sort((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0)) }
}

/** The audit line's files: where each came from, its size and hash (never its content). */
export const uploadSummary = (files: readonly UploadFileReady[]) => files.map((f) => `${f.where.length > 160 ? '…' + f.where.slice(-159) : f.where} ${f.bytes.length} B sha256 ${f.sha256.slice(0, 16)}`).join(', ').slice(0, 700)

/** The step once the files are in: "파일 2개 첨부함: mail.daum.net · a.pdf, b.pdf". The host is the one the desktop
 * app names in its result ("Attached 2 files to mail.daum.net ..."). */
export function attachedStepLabel(r: BrowserResult, files: readonly UploadFileReady[], locale: Parameters<typeof stepText>[1]): string | null {
  const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
  const host = /^Attached \d+ files? to ([^\s]+?)(?: |$)/m.exec(text)?.[1]
  if (!r.ok || !host) return null
  const names = files.slice(0, 3).map((f) => f.name).join(', ') + (files.length > 3 ? ` +${files.length - 3}` : '')
  return stepText('browserFilesAttached', locale, { n: String(files.length), host: host.slice(0, 80), names: names.slice(0, 120) })
}

/** An older desktop app's answer to a tool it does not know, in words the AI can pass on. */
export function oldAppResult(r: BrowserResult): BrowserResult {
  const said = r.error ?? r.content.find((c) => c.type === 'text')?.text ?? ''
  return !r.ok && OLD_APP.test(said) ? { ...r, error: UPDATE_APP_TEXT, content: [{ type: 'text', text: UPDATE_APP_TEXT }] } : r
}
