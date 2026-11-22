// The API engine's answer says what really happened (docs/decisions/20261118-api-engine-honest.md, QA TC-4829..4831).
// Open models behind an OpenAI-compatible API overwrote a file with a near-empty body and answered "fixed it", glued
// their "let me check" lines in front of the answer, and wrote links with no address. The rules here are small and
// pure; engine/api-agent.ts applies them.
import type { Locale } from '@mycel/shared/api'
import { stepWords } from '@mycel/shared'
import { tr } from '../chat/i18n'

// ---------------- a write that would wipe most of a file (TC-4829) ----------------

/** A file this small is never guarded: a short note rewritten in full is normal. */
export const SHRINK_MIN_OLD_BYTES = 400
/** The new body must keep at least this share of the bytes the AI read. */
export const SHRINK_MIN_RATIO = 0.3
/** The argument the model adds to a repeated write when the person asked for the whole file to be replaced. It is
 * taken out before the write runs (the write tool's own input has no such field). */
export const CONFIRM_ARG = 'confirmed_by_user'

/** A path as the AI wrote it, without "./", empty parts and a leading "/", so "a/b.md" and "./a//b.md" are one file. */
export function samePath(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim()) return null
  return p.trim().split('/').filter((s) => s !== '' && s !== '.').join('/') || null
}

/** The text a read gave, in bytes, from its numbered lines ("     1\tline"). A read that showed part of the file gives
 * that part: the real file is at least as big, so the rule can only refuse less, never more. 0 = no text lines (an
 * image, a PDF page as a picture, an empty file). */
export function readBytes(out: string): number {
  let n = 0
  for (const m of out.matchAll(/^ *\d+\t(.*)$/gm)) n += Buffer.byteLength(m[1]!, 'utf8') + 1
  return n
}

/**
 * What this answer's AI read, for the write check. Only the main loop's own reads count (engine/api-agent.ts): a file
 * the AI never read is not guarded here (the write tool refuses to overwrite it anyway: read before write).
 */
export class ReadLog {
  private readonly bytes = new Map<string, number>()

  /** A finished tool call: a read records the file's size; a save of a file read before records its new size (a file
   * the AI only wrote itself is never guarded: condensing its own draft is fine); any other call that worked forgets
   * every recorded file it names (an edit, a rename, a move, a delete, edit_files …: the size after it is not known
   * here, and an old size could refuse a fair rewrite later). */
  note(tool: string, args: unknown, ok: boolean, out: string) {
    if (!ok) return
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
    const p = samePath(a.file_path)
    if (tool === 'read') {
      const n = p ? readBytes(out) : 0
      if (p && n > 0) this.bytes.set(p, Math.max(n, this.bytes.get(p) ?? 0))
      return
    }
    if (tool === 'write' && p && typeof a.content === 'string') {
      if (this.bytes.has(p)) this.bytes.set(p, Buffer.byteLength(a.content, 'utf8'))
      return
    }
    for (const v of Object.values(a)) for (const x of Array.isArray(v) ? v : [v]) {
      const q = samePath(typeof x === 'object' && x !== null ? (x as { path?: unknown }).path : x)
      if (q) this.bytes.delete(q)
    }
  }

  /** null = the write may run (with `args` as the tool takes them); else the refusal for the model. */
  check(tool: string, args: unknown): { refusal: string | null; args: unknown } {
    if (tool !== 'write' || !args || typeof args !== 'object') return { refusal: null, args }
    const { [CONFIRM_ARG]: confirmed, ...rest } = args as Record<string, unknown>
    if (confirmed === true) return { refusal: null, args: rest }
    const p = samePath(rest.file_path)
    const old = p ? this.bytes.get(p) : undefined
    if (old === undefined || old < SHRINK_MIN_OLD_BYTES || typeof rest.content !== 'string') return { refusal: null, args: rest }
    const now = Buffer.byteLength(rest.content, 'utf8')
    if (now >= old * SHRINK_MIN_RATIO) return { refusal: null, args: rest }
    return {
      refusal: `Not saved: this would replace ${p}, which you read in this answer (about ${old} bytes), with ${now} bytes, so most of the file would be lost. The file was not changed. ` +
        'To change part of the file, use edit. Write the whole file only with its full new content. ' +
        `If the user asked you to empty or shorten the whole file, call write again with the same content and "${CONFIRM_ARG}": true; if you are not sure that is what they want, ask them first and do not say it was saved.`,
      args: rest,
    }
  }
}

// ---------------- failed steps the answer does not mention (TC-4829) ----------------

/** Calls that do the same thing to the same file count as one step: a save that failed and an edit of that file that
 * worked afterwards is a step done. chat_file and read are one read: chat_file reads a chat file by its id or name,
 * read by its chat:files/<id>/<name> path (QA TC-7052). */
const CHANGES_FILE = new Set(['write', 'edit'])
const READS_FILE = new Set(['read', 'chat_file'])
/** Tools that change a file in place or into `output`: one that failed and a file made again afterwards is the same
 * outcome (QA TC-7045: edit_pdf failed, make_file made the PDF again and it was attached). */
const EDITS_FILE = new Set(['edit_pdf', 'edit_office', 'edit_hwp', 'stamp_pdf'])

const kindOf = (tool: string) => CHANGES_FILE.has(tool) ? 'change' : READS_FILE.has(tool) ? 'read' : tool

function stepKey(tool: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const target = samePath(a.file_path) ?? samePath(a.path) ?? samePath(a.output) ?? (tool === 'chat_file' ? samePath(a.file) : null) ?? ''
  return `${kindOf(tool)}|${target}`
}

/** A chat place: this chat's files (chat:files/…) and the work folder (chat:work/…, $TRINA_WORK/…). The file tools refuse
 * some saves there on purpose and steer to another route: the work folder to a command or copy_files (QA TC-6938), a
 * chat made private again to the person's own folder (QA TC-7051: write chat:files/todo.md refused, then write
 * users/<id>/todo.md worked; the answer still said "One step didn't work: Save."). A failed save of a chat place is
 * settled by a file of that name made anywhere; a refused save of a team file stays a failure whatever else the answer
 * did. */
const CHAT_PLACE = /^(?:chat:(?:work|files)\/|\$TRINA_WORK\/|\$\{TRINA_WORK\}\/)/i
const WORK_TARGET = /^(?:chat:work\/|\$TRINA_WORK\/|\$\{TRINA_WORK\}\/)/i

/** The last part of a path ("chat:work/out/report.txt" -> "report.txt"), lower case; null for none */
const fileName = (p: string) => p.replace(/^["']|["']$/g, '').split('/').filter(Boolean).pop()?.toLowerCase() ?? null

/** The files a successful call made or handed over: a command's outputs (after >, >>, tee or -o, and the target of cp
 * or mv), copy_files' and save_work_file's files, make_file's output, write's file, a file-edit tool's output (or its
 * file, changed in place). Nothing it only read or listed. As written (samePath), or the name alone for a command. */
function madeFiles(tool: string, args: unknown): string[] {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const out: string[] = []
  const add = (v: unknown) => { const p = typeof v === 'string' ? samePath(v.replace(/^["']|["']$/g, '')) : null; if (p) out.push(p) }
  if (tool === 'box_shell' && typeof a.command === 'string') {
    for (const m of a.command.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?|\s-o\s*)\s*("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g)) add(fileName(m[1]!))
    for (const part of a.command.split(/&&|\|\||[;|\n]/)) {
      const words = part.trim().split(/\s+/).filter((w) => w && !w.startsWith('-'))
      if ((words[0] === 'cp' || words[0] === 'mv') && words.length >= 3) {
        const to = words[words.length - 1]!.replace(/^["']|["']$/g, '')
        // into a folder ("…/out/"): the files keep their names
        if (to.endsWith('/') || WORK_TARGET.test(to + '/') && !/\.[^/]+$/.test(to)) words.slice(1, -1).forEach((w) => add(fileName(w)))
        else add(fileName(to))
      }
    }
  }
  if (tool === 'copy_files' && Array.isArray(a.paths)) a.paths.forEach(add)
  if (tool === 'save_work_file') add(a.path)
  if (tool === 'make_file') add(a.output)
  if (tool === 'write') add(a.file_path)
  if (EDITS_FILE.has(tool)) add(typeof a.output === 'string' && a.output.trim() ? a.output : a.file_path)
  return out
}

/** A chat file as a read names it: chat_file's `file` (an id or a name: `token`) or a chat:files/<id>/<name> path (or
 * chat:files/<name>); null for a read of anything else. */
type ChatFileRef = { id?: string; name?: string; token?: string }
function chatFileRef(tool: string, target: string): ChatFileRef | null {
  if (tool === 'chat_file') return target ? { token: target.toLowerCase() } : null
  if (!/^chat:files\//i.test(target)) return null
  const segs = target.split('/').slice(1).map((s) => s.toLowerCase())
  if (!segs.length) return null
  return segs.length >= 2 ? { id: segs[0]!, name: segs[segs.length - 1]! } : { name: segs[0]! }
}

/** Two reads name the same chat file: both ids when both have one, else a token against the other's id or name, else
 * the names. */
function sameChatFile(a: ChatFileRef, b: ChatFileRef): boolean {
  if (a.id && b.id) return a.id === b.id
  if (a.token || b.token) {
    const ka = [a.id, a.name, a.token].filter(Boolean), kb = [b.id, b.name, b.token].filter(Boolean)
    return ka.some((x) => kb.includes(x))
  }
  return !!a.name && a.name === b.name
}

/** The answer's tool calls that failed and were not done again with success afterwards (same tool or a change of the
 * same file, same target), nor superseded by a later call that got the same outcome another way: a chat place's file
 * made elsewhere, a file-edit tool's file made again, a chat file read another way. */
export class FailedSteps {
  /** step key -> the failed tool and, for a file-edit tool, the file it was to make (`output`) */
  private readonly open = new Map<string, { tool: string; output: string | null }>()

  note(tool: string, args: unknown, ok: boolean) {
    const key = stepKey(tool, args)
    const kind = key.slice(0, key.indexOf('|'))
    const target = key.slice(kind.length + 1)
    if (ok) {
      this.open.delete(key)
      const made = madeFiles(tool, args)
      if (made.length) {
        const names = made.map(fileName)
        for (const [k, f] of [...this.open]) {
          const t = k.slice(k.indexOf('|') + 1)
          if (!t || !(k.startsWith('change|') || EDITS_FILE.has(f.tool))) continue
          // a chat place: the same name anywhere (CHAT_PLACE); a team file's failed file-edit tool: its file or the file
          // it was to make, made at that very path
          const paths = [t, f.output].filter((p): p is string => !!p)
          const settled = paths.some((p) => CHAT_PLACE.test(p) ? names.includes(fileName(p)) : EDITS_FILE.has(f.tool) && made.includes(p))
          if (settled) this.open.delete(k)
        }
      }
      const ref = kind === 'read' ? chatFileRef(tool, target) : null
      if (ref) for (const [k, f] of [...this.open]) {
        // the same chat file read another way: chat_file by id or name, read by chat:files/<id>/<name> (TC-7052)
        const other = k.startsWith('read|') ? chatFileRef(f.tool, k.slice('read|'.length)) : null
        if (other && sameChatFile(ref, other)) this.open.delete(k)
      }
      // a call with a target also settles the same tool's earlier failure that had none (bad arguments the first time);
      // a read with none is settled by a read of the same tool, or by a read of a chat file (chat_file {} then read of
      // chat:files/…, TC-7052), not by a read of any team file
      const bare = this.open.get(`${kind}|`)
      if (target && bare && (kind !== 'read' || bare.tool === tool || (ref && bare.tool === 'chat_file'))) this.open.delete(`${kind}|`)
      // a file made or changed after a read that failed (often "not found" before it was created) settles the read
      if (kind === 'change' && target) this.open.delete(`read|${target}`)
    } else {
      const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
      this.open.delete(key)
      this.open.set(key, { tool, output: EDITS_FILE.has(tool) ? samePath(a.output) : null })
    }
  }

  /** The failed steps' tools, one per step still open, in the order they failed (a tool can be there twice: two files). */
  tools(): string[] { return [...this.open.values()].map((f) => f.tool) }
}

/** Words that say a step did not work, in the six languages of the app. The answer that holds one already tells the
 * person; then nothing is added (the model's own words are only read here, never repeated). */
// Only phrases that say an action did not work: never a bare word for "error" ("오류를 고쳤어요", "I fixed an error" are
// what a model says after a save that failed, TC-4829), and "failed" only as "failed to" or at the end of a sentence.
const DID = '(?:save|write|change|update|edit|create|make|open|finish|complete|do|apply|fix|delete|move|rename|upload|send)'
const SAYS_FAILED = new RegExp([
  "didn'?t work", 'did not work', '\\bfail(?:s|ed)? to\\b', '\\bfailed(?=\\s*(?:[.!]|$))', `(?:couldn'?t|could not|wasn'?t able to|was not able to|unable to) ${DID}\\b`,
  "(?:was|were)n'?t (?:saved|changed|updated|created)", '(?:was|were) not (?:saved|changed|updated|created)', '\\bnot saved\\b',
  '실패했', '실패하였', '못\\s?했', '안\\s?됐', '안\\s?되었', '할 수 없었', '수 없었어', '저장되지 않았', '바뀌지 않았',
  '失敗しました', 'できませんでした', 'できなかった', 'されませんでした',
  '失败了', '未能', '没能', '没有成功',
  'no se pudo', 'no pude', 'falló', 'no funcionó',
  'gagal', 'tidak berhasil', 'tidak bisa (?:menyimpan|mengubah|membuat|membuka)',
].join('|'), 'i')

export function saysSomethingFailed(answer: string): boolean { return SAYS_FAILED.test(answer) }

/**
 * The line the server adds at the end of an answer whose steps failed when the answer does not say so ("One step
 * didn't work: Save."). Every word comes from the server: the step words of each tool (shared/src/step-labels.ts
 * stepWords, "Step" for a tool without words of its own) and the line in chat/i18n.ts. Never the model's text, never a
 * path or anything else from the call's arguments. The line is in the answer's language (answerLocale), the way the
 * answer itself follows the person's message rather than the app's language (QA TC-7045: a Korean answer ended in
 * English). null = nothing to add.
 */
export function failedStepsNote(failed: string[], answer: string, locale: Locale): string | null {
  if (!failed.length || saysSomethingFailed(answer)) return null
  const L = answerLocale(answer, locale)
  const names = [...new Set(failed.map((tool) => stepWords({ kind: 'tool', tool }, L)))]
  return tr(failed.length === 1 ? 'apiStepFailed' : 'apiStepsFailed', L, { names: names.join(', ') })
}

/** Code and links' addresses say nothing about the language an answer is written in. */
const NOT_PROSE = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\]\([^)\n]*\)|https?:\/\/\S+/g

/**
 * The language an answer is written in, for a line the server adds to it: Hangul makes it Korean, kana Japanese
 * (whichever there is more of), Han characters alone Chinese. An answer in Latin letters keeps the app's language when
 * that is written in Latin letters, else it is English when it has about three Latin words or more; a shorter one ("ok",
 * a name, an emoji) keeps the app's language. Code and
 * link addresses are not counted; a CJK character counts as three Latin letters.
 */
export function answerLocale(answer: string, app: Locale): Locale {
  const text = answer.replace(NOT_PROSE, ' ')
  let hangul = 0, kana = 0, han = 0, latin = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) hangul++
    else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xff66 && c <= 0xff9f)) kana++
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)) han++
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) latin++
  }
  // one CJK character carries about as much as two or three Latin letters: a Korean file name in an English answer
  // ("Here is 견적서.pdf, updated.") leaves it English, English names in a Korean answer leave it Korean
  if ((hangul + kana + han) * 3 >= latin && hangul + kana + han > 0) {
    if (kana > 0 && kana >= hangul) return 'ja'
    if (hangul > 0) return 'ko'
    return app === 'ja' ? 'ja' : 'zh'
  }
  if (app !== 'ko' && app !== 'ja' && app !== 'zh') return app
  // about 3 or more Latin words ("Saved the file."), as narration.ts writesLatin: a short "ok" or a bare name keeps it
  return (text.match(/[A-Za-z]{2,}/g) ?? []).length >= 3 ? 'en' : app
}

// ---------------- empty links (TC-4831) ----------------

/** A fenced code block (``` or ~~~, to its closing fence or the end) or an inline code span: left as written. */
const CODE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)|`[^`\n]+`/g
const EMPTY_LINK = /!?\[([^\]\n]*)\]\(\s*\)/g

/** `[label]()` and `[label]( )` (and an image without address) become `label`; code and real links stay. */
export function dropEmptyLinks(text: string): string {
  if (!text.includes('](')) return text
  let out = ''
  let at = 0
  for (const m of text.matchAll(CODE)) {
    out += text.slice(at, m.index).replace(EMPTY_LINK, '$1') + m[0]
    at = m.index! + m[0].length
  }
  return out + text.slice(at).replace(EMPTY_LINK, '$1')
}
