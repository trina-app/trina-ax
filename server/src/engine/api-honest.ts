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
 * worked afterwards is a step done. */
const CHANGES_FILE = new Set(['write', 'edit'])

function stepKey(tool: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const target = samePath(a.file_path) ?? samePath(a.path) ?? samePath(a.output) ?? ''
  return `${CHANGES_FILE.has(tool) ? 'change' : tool}|${target}`
}

/** A failed write or edit of the work folder (chat:work/…, $TRINA_WORK/…), which the file tools refuse on purpose and
 * steer to a command or copy_files (QA TC-6938: write to chat:work/report.txt refused, then a box_shell command made
 * report.txt and copy_files attached it; the answer still said "One step didn't work: Save."). Only these are settled by
 * another route: a refused save of a team file stays a failure whatever else the answer did. */
const WORK_TARGET = /^(?:chat:work\/|\$TRINA_WORK\/|\$\{TRINA_WORK\}\/)/i

/** The last part of a path ("chat:work/out/report.txt" -> "report.txt"), lower case; null for none */
const fileName = (p: string) => p.replace(/^["']|["']$/g, '').split('/').filter(Boolean).pop()?.toLowerCase() ?? null

/** The files a successful call made or handed over, by name: a command's outputs (after >, >>, tee or -o, and the target
 * of cp or mv), copy_files' and save_work_file's files, make_file's output. Nothing it only read or listed. */
function madeNames(tool: string, args: unknown): string[] {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const out: string[] = []
  const add = (v: unknown) => { const n = typeof v === 'string' ? fileName(v) : null; if (n) out.push(n) }
  if (tool === 'box_shell' && typeof a.command === 'string') {
    for (const m of a.command.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?|\s-o\s*)\s*("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g)) add(m[1])
    for (const part of a.command.split(/&&|\|\||[;|\n]/)) {
      const words = part.trim().split(/\s+/).filter((w) => w && !w.startsWith('-'))
      if ((words[0] === 'cp' || words[0] === 'mv') && words.length >= 3) {
        const to = words[words.length - 1]!.replace(/^["']|["']$/g, '')
        // into a folder ("…/out/"): the files keep their names
        if (to.endsWith('/') || WORK_TARGET.test(to + '/') && !/\.[^/]+$/.test(to)) words.slice(1, -1).forEach(add)
        else add(to)
      }
    }
  }
  if (tool === 'copy_files' && Array.isArray(a.paths)) a.paths.forEach(add)
  if (tool === 'save_work_file') add(a.path)
  if (tool === 'make_file') add(a.output)
  return out
}

/** The answer's tool calls that failed and were not done again with success afterwards (same tool or a change of the
 * same file, same target), nor superseded by a later call that made or handed over the same file another way. */
export class FailedSteps {
  private readonly open = new Map<string, string>()

  note(tool: string, args: unknown, ok: boolean) {
    const key = stepKey(tool, args)
    if (ok) {
      this.open.delete(key)
      // a refused save into the work folder whose file a later step made or handed over by another route: the outcome
      // stands (WORK_TARGET)
      const made = madeNames(tool, args)
      if (made.length) for (const k of [...this.open.keys()]) {
        const target = k.startsWith('change|') ? k.slice('change|'.length) : ''
        if (WORK_TARGET.test(target) && made.includes(fileName(target) ?? '')) this.open.delete(k)
      }
      // a call with a target also settles the same tool's earlier failure that had none (bad arguments the first time)
      this.open.delete(`${key.slice(0, key.indexOf('|'))}|`)
      // a file made or changed after a read that failed (often "not found" before it was created) settles the read
      if (key.startsWith('change|') && key !== 'change|') this.open.delete(`read|${key.slice('change|'.length)}`)
    } else {
      this.open.delete(key)
      this.open.set(key, tool)
    }
  }

  /** The failed steps' tools, one per step still open, in the order they failed (a tool can be there twice: two files). */
  tools(): string[] { return [...this.open.values()] }
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
 * path or anything else from the call's arguments. null = nothing to add.
 */
export function failedStepsNote(failed: string[], answer: string, locale: Locale): string | null {
  if (!failed.length || saysSomethingFailed(answer)) return null
  const names = [...new Set(failed.map((tool) => stepWords({ kind: 'tool', tool }, locale)))]
  return tr(failed.length === 1 ? 'apiStepFailed' : 'apiStepsFailed', locale, { names: names.join(', ') })
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
