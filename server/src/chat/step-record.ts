// The AI's own steps in earlier answers of the same chat (docs/decisions/20261122-chat-step-memory.md). Claude
// Code remembers, inside one session, which tools it called with which arguments and what came back. A fresh engine
// session (Codex and the API engine every turn; Claude Code after an edit, an engine switch, a shared chat whose read
// scope not everyone may see, a session too big to keep, ...) got only the answers' text, so the AI could not say how
// it had done something two answers ago and guessed. Each tool step now keeps a short note on the server (its key
// arguments and the start of its result, secrets hidden: messages.step_notes, never sent to an app), and a fresh
// session's history shows, under the asker's own earlier answers, one line per step.
import { stepRepeatsCard } from './open-questions'
import type { Database } from 'bun:sqlite'
import type { StoredStep } from './store'
import { neutralizeTags } from './prompt'
import { knownStepTool, stepWords } from '@mycel/shared'
import { BROWSER_TOOL_NAMES } from '../realtime/browser-tools'

/** a step's note: `i` its key arguments, `o` the start of its result (both plain text, already capped and redacted) */
export interface StepNote { i?: string; o?: string }
export type StepNotes = Record<string, StepNote>

/** the newest answers on the branch that get a record (answers that called no tool do not count) (older ones keep their text and the summary's step labels) */
export const STEP_RECORD_ANSWERS = 10
/** lines per answer: the first STEP_RECORD_HEAD and the newest ones, a line says how many were left out */
export const STEP_RECORD_LINES = 40
const STEP_RECORD_HEAD = 5
/** characters of one answer's record */
export const STEP_RECORD_CHARS = 3_000
/** characters of a step's arguments and of its result as kept */
export const STEP_ARGS_CHARS = 240
export const STEP_RESULT_CHARS = 200
/** steps a note is kept for at most per answer (the step list itself has no lower cap) */
export const STEP_NOTES_MAX = 300

/** Tools whose result is a file's or a message's content: their result is not kept (the AI reads it again; a person may
 * have lost access to it since). Their arguments (the path, the query) are. */
const CONTENT_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'glob', 'Read', 'Grep', 'Glob', 'chat_file', 'room_read', 'room_file', 'read_office', 'read_pdf', 'thread_look', 'shared_with_me'])
/** a tool whose result is mostly what it read (a file, a mail, a page, a message list): its arguments are kept, its
 * result not (read again; a person may have lost access to it since). By name: a connection's own read tools too
 * (gmail_read_message, slack_read_channel, search_files, get_page, fetch, list_events, ...) */
const CONTENT_NAME = /(^|_)(read|reads|get|fetch|search|find|list|lookup|query|grep|glob|cat|open|download|export|view|show|recall|history|context|tabs|page|pages|screenshot|snapshot|scrape|crawl|inbox|messages|thread|threads)(_|$)/i
/** a tool's own name as words joined by "_": "mcp__x__getJiraIssue" and "notion-fetch" as get_jira_issue, notion_fetch */
const nameWords = (tool: string): string => tool.replace(/^.*__/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.\s]+/g, '_').toLowerCase()
/** the in-app browser's own tools (what a signed-in page showed or ran: a cookie, a token, an open tab) and the tools
 * that show a skill's or a room's text: their results are never kept */
const NO_RESULT_TOOLS: ReadonlySet<string> = new Set([...BROWSER_TOOL_NAMES, 'skill', 'rooms', 'tabs_context', 'javascript_tool'])
export const contentTool = (tool: string): boolean => CONTENT_TOOLS.has(tool) || NO_RESULT_TOOLS.has(tool) || NO_RESULT_TOOLS.has(tool.replace(/^.*__/, '')) || CONTENT_NAME.test(nameWords(tool))
/** steps that are server notes, not the AI's work */
const NOTE_TOOLS: ReadonlySet<string> = new Set(['engine', 'refusal', 'demo_replay', 'attachment', 'history_summary', 'todo_write', 'context',
  // a memory's words: the person may have forgotten it since (Settings › 메모리); the memory list is the place for them
  'remember', 'forget', 'recall', 'memory'])

/** argument keys that say what a call did, shown first (a path, an address, a name, a command, code) */
const KEY_ARG = /^(path|paths|file|file_path|filepath|filename|file_name|name|title|url|urls|href|uri|link|to|cc|subject|query|q|search|command|cmd|code|script|selector|target|source|destination|dest|from|folder|dir|directory|room|room_id|chat_id|id|ids|profile|action|method|tab|page|value|text|pattern|glob|description|prompt|attachment|attachments)$/i
/** argument keys whose value is long body text: shown as a length only */
const BODY_ARG = /^(content|contents|body|html|markdown|new_string|old_string|data|base64|image|images|bytes|blob|patch|diff|edits|message|messages|rows|cells|slides|sheets)$/i

const oneLine = (s: string): string => s.replace(/data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]+/gi, '[data]').replace(/[A-Za-z0-9+/=]{200,}/g, '[data]').replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** what was typed into a page or a form (a code, a card number): its length only */
const TYPED_ARG = /^(value|text|keys|input|otp|code_value|password|passcode|pin)$/i

/** Strings that look like secrets in what a call took or gave back (a token, a key, a cookie, a password field),
 * hidden whatever the person stored: the record must never let the AI repeat one. */
export function scrubSecrets(s: string): string {
  return s
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g, '[hidden]')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '[hidden]')
    .replace(/\b(ghp|gho|ghs|ghu|github_pat|xox[abpsr]|AKIA|ASIA|AIza|ya29)[A-Za-z0-9_.-]{8,}/g, '[hidden]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [hidden]')
    .replace(/(["']?\b(?:password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|apikey|session(?:id)?|cookie|set-cookie|authorization|auth|otp|pin)\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[hidden]')
}

function argValue(key: string, v: unknown, typed = false): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    if (BODY_ARG.test(key) || (typed && TYPED_ARG.test(key))) return `(${v.length} characters)`
    // code and commands keep more of their start: they are what the call did
    return JSON.stringify(clip(oneLine(v), /^(code|script|command|cmd)$/i.test(key) ? 200 : 120))
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    if (BODY_ARG.test(key)) return `(${v.length} items)`
    const scalars = v.filter((x) => typeof x === 'string' || typeof x === 'number').slice(0, 5).map((x) => JSON.stringify(clip(oneLine(String(x)), 80)))
    return scalars.length ? `[${scalars.join(', ')}${v.length > scalars.length ? `, +${v.length - scalars.length}` : ''}]` : `(${v.length} items)`
  }
  if (typeof v === 'object') return BODY_ARG.test(key) ? '(object)' : null
  return null
}

/** A call's key arguments in one short line: `path="a/b.pdf" url="https://…"`. The keys that say what the call did come
 * first; body text (a file's content, a mail's body) only as its length; nested objects once, one level down. */
export function stepArgs(input: unknown, max = STEP_ARGS_CHARS, tool = ''): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  // a browser tool that types (form_input, computer, javascript_tool ...): what it typed only as its length
  const typed = !!tool && (NO_RESULT_TOOLS.has(tool) || NO_RESULT_TOOLS.has(tool.replace(/^.*__/, '')))
  const entries = Object.entries(input as Record<string, unknown>)
  const flat: [string, unknown][] = []
  for (const [k, v] of entries) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !BODY_ARG.test(k)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>).slice(0, 8)) if (typeof v2 !== 'object' || v2 === null || Array.isArray(v2)) flat.push([`${k}.${k2}`, v2])
    } else flat.push([k, v])
  }
  const keyOf = (k: string) => k.split('.').pop()!
  const ordered = [...flat.filter(([k]) => KEY_ARG.test(keyOf(k))), ...flat.filter(([k]) => !KEY_ARG.test(keyOf(k)))]
  const parts: string[] = []
  let used = 0
  for (const [k, v] of ordered) {
    const val = argValue(keyOf(k), v, typed)
    if (val === null) continue
    const part = `${k}=${val}`
    if (used + part.length > max) { if (!parts.length) parts.push(clip(part, max)); break }
    parts.push(part)
    used += part.length + 1
  }
  return scrubSecrets(parts.join(' '))
}

/** The start of a call's result in one line, pictures and base64 left out. Empty for a content tool or no output. */
export function stepResult(tool: string, output: string | undefined, max = STEP_RESULT_CHARS): string {
  if (!output || contentTool(tool)) return ''
  const line = scrubSecrets(oneLine(output))
  if (!line) return ''
  return line.length > max ? `${line.slice(0, max - 1)}… (${output.length} characters in all)` : line
}

/** The notes as stored: a JSON object, or {} for none or a value that does not read. */
export function parseNotes(raw: string | null | undefined): StepNotes {
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v as StepNotes : {} } catch { return {} }
}

/** How the asker may see one step: its label, and whether its arguments and result may be shown. A step that keeps
 * paths aside (a shared chat's StoredStep.sv) shows them only when the asker may list every one of them now. */
function stepFor(s: StoredStep, canList: ((p: string) => boolean) | null): { label: string; full: boolean } {
  if (!s.sv) return { label: s.label, full: true }
  const shows = !!canList && s.sv.paths.every((p) => { try { return canList(p) } catch { return false } })
  return shows ? { label: s.sv.label, full: true } : { label: s.label, full: false }
}

const statusWord = (s: StoredStep): string => (s.stopped ? 'stopped' : s.paused ? 'paused' : s.status === 'error' ? 'failed' : s.status === 'running' ? 'did not finish' : 'ok')

/**
 * One answer's record: a line per tool step (the main AI's, a sub-task by its own line), oldest first, with the tool's
 * name, its label as the asker may see it, how it ended and, where the note may be shown, its key arguments and the
 * start of its result. '' when the answer called no tool. Every value is neutralized (a result cannot close or open
 * one of our blocks).
 */
export function stepsRecord(steps: readonly StoredStep[], notes: StepNotes, canList: ((p: string) => boolean) | null): string {
  const work = steps.filter((s) => s.kind !== 'thinking' && !s.parentId && !(s.tool && NOTE_TOOLS.has(s.tool)))
  if (!work.length) return ''
  const lines = work.map((s, n) => {
    const v = stepFor(s, canList)
    const note = v.full ? notes[s.id] : undefined
    const bits = [`${n + 1}. ${s.tool ?? s.kind}: ${oneLine(v.label)} [${statusWord(s)}]`]
    if (note?.i) bits.push(`args: ${note.i}`)
    if (note?.o) bits.push(`result: ${note.o}`)
    return neutralizeTags(bits.join(' | '))
  })
  let kept = lines
  if (lines.length > STEP_RECORD_LINES) {
    const tail = STEP_RECORD_LINES - STEP_RECORD_HEAD
    kept = [...lines.slice(0, STEP_RECORD_HEAD), `(${lines.length - STEP_RECORD_LINES} steps in between left out)`, ...lines.slice(-tail)]
  }
  // over the characters: the head and as many of the newest lines as fit
  let text = kept.join('\n')
  if (text.length > STEP_RECORD_CHARS) {
    const head = kept.slice(0, Math.min(3, kept.length))
    const rest = kept.slice(head.length)
    const tail: string[] = []
    let used = head.join('\n').length + 60
    for (let i = rest.length - 1; i >= 0; i--) {
      const l = clip(rest[i]!, 400)
      if (used + l.length + 1 > STEP_RECORD_CHARS) break
      tail.unshift(l)
      used += l.length + 1
    }
    const left = rest.length - tail.length
    text = [...head.map((l) => clip(l, 400)), ...(left > 0 ? [`(${left} more steps left out)`] : []), ...tail].join('\n')
  }
  return text
}

/** An answer that wrote no text but ran tools (stopped or failed partway): it stays in the history with this line, so
 * its steps reach the next session (it used to be left out whole, steps and all). Null: an answer without such steps
 * (left out as before), or one still running. */
export function emptyAnswerText(m: { role: string; content: string; status: string; steps: string | null }): string | null {
  if (m.role !== 'assistant' || m.content.trim() || m.status === 'streaming') return null
  let steps: unknown
  try { steps = JSON.parse(m.steps ?? '[]') } catch { return null }
  const work = (x: unknown) => {
    if (!x || typeof x !== 'object') return false
    const st = x as { kind?: unknown; parentId?: unknown; tool?: unknown }
    return st.kind !== 'thinking' && !st.parentId && !(typeof st.tool === 'string' && NOTE_TOOLS.has(st.tool))
  }
  if (!Array.isArray(steps) || !steps.some(work)) return null
  return m.status === 'stopped' ? '(This answer was stopped before it wrote any text.)' : m.status === 'error' ? '(This answer ended with an error before it wrote any text.)' : '(This answer wrote no text.)'
}

/** history items as the turn builds them, with the step record of an answer where it gets one */
export type RecordItem = { id?: string; role: 'user' | 'assistant'; content: string; steps?: string }

/** How the turn may show its earlier steps. `canList`: may the paths a line keeps aside be named (in a chat several
 * people see: may EVERYONE who sees it now list them, since the new answer is theirs to read too). `shared`: the chat is
 * shared now: `hiddenFrom(id)` says whether an answer is hidden from anyone who sees it now (chat/shared-answers.ts
 * answerHiddenFrom; its notes then stay out: the new answer would carry what they were never given), `sharedLater(id)`
 * whether it ran before the chat was shared (its steps ran without the read card: their words alone, as the others see
 * them, ChatStore.viewSteps). `copies`: a chat shared with people with files copied in: the originals' paths as the
 * copies' (chat/copy-paths.ts), as for the answer text. `budget`: characters for all records together. */
export interface RecordView {
  asker: string
  several: boolean
  withheld?: ReadonlySet<string>
  canList: ((p: string) => boolean) | null
  shared?: { hiddenFrom: (answerId: string) => boolean; sharedLater: (answerId: string) => boolean }
  mapText?: (text: string) => string
  budget?: number
}
/** The chat was never shared with anyone and nobody else wrote in it: not shared now (a project's shared chat, people),
 * no share in the audit log, no message of another person (fails closed: false). `memo`: one answer per chat. */
function neverShared(db: Database, chatId: string, asker: string, memo: Map<string, boolean>): boolean {
  const known = memo.get(chatId)
  if (known !== undefined) return known
  let ok = false
  try {
    ok = !db.query(`SELECT 1 FROM chats c WHERE c.id = ?1 AND (c.shared_at IS NOT NULL OR c.people_shared_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'chat.share' AND a.target = ?1)
        OR EXISTS (SELECT 1 FROM messages x WHERE x.chat_id = ?1 AND x.role = 'user' AND x.author_id IS NOT NULL AND x.author_id <> ?2))
      UNION ALL SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM chats WHERE id = ?1) LIMIT 1`).get(chatId, asker)
  } catch { ok = false }
  memo.set(chatId, ok)
  return ok
}

/** a history window of fewer estimated tokens than this (a small model) gets no records: the text comes first */
export const STEP_RECORD_MIN_BUDGET = 12_000
/** characters for all records of one history together (newest answers first) */
export const STEP_RECORD_TOTAL = 6_000
/** another person's answers in a shared chat (docs/decisions/20261123-shared-chat-others-steps.md): at most this many
 * per person, and this many characters of theirs together (inside STEP_RECORD_TOTAL) */
export const OTHER_RECORD_ANSWERS = 4
export const OTHER_RECORD_CHARS = 1_800
/** The tools of another person's answer whose notes (arguments, result) may be shown to the asker: the team's own file
 * tools that name team paths (their paths shown only when everyone may list them: stepFor). Everything else (a
 * connection's, an app's or the browser's step, a card's answer, a post, a share, a web address, a data query) shows
 * its name and how it ended only. */
const OTHERS_NOTE_TOOLS: ReadonlySet<string> = new Set(['read', 'list', 'glob', 'grep', 'write', 'edit', 'edit_files', 'make_file', 'edit_hwp', 'hwp_render',
  'stamp_pdf', 'edit_pdf', 'merge_pdfs', 'split_pdf', 'resize_images', 'unzip_file', 'make_zip', 'move_files', 'copy_files', 'rename_file', 'rename_files', 'delete_files'])
/** (only a step that names team paths, kept aside for whoever may list them all: StoredStep.sv, shown by stepFor) */
const othersNotes = (s: StoredStep): boolean => !!s.tool && OTHERS_NOTE_TOOLS.has(s.tool) && !!s.sv
/** The team paths a note's words name: quoted values and words with a "/" (a web address and a chat place left out). */
export function notePaths(n: StepNote): string[] {
  const out = new Set<string>()
  for (const t of [n.i ?? '', n.o ?? '']) {
    for (const m of t.matchAll(/"((?:[^"\\]|\\.)*)"/g)) if (m[1]!.includes('/')) out.add(m[1]!)
    for (const w of t.replace(/"(?:[^"\\]|\\.)*"/g, ' ').split(/[\s,;()[\]{}<>|'`]+/)) if (w.includes('/')) out.add(w)
  }
  return [...out].map((p) => p.replace(/[.:!?…]+$/, '').replace(/^\/+/, '')).filter((p) => p && !/^[a-z][a-z0-9+.-]*:/i.test(p))
}
const notePathsListable = (n: StepNote, canList: ((p: string) => boolean) | null): boolean =>
  notePaths(n).every((p) => { try { return !!canList && canList(p) } catch { return false } })

/**
 * The step records for a fresh session's history: for the newest STEP_RECORD_ANSWERS answers that are the asker's own
 * (and, in a chat shared now, other people's answers the asker sees: OTHER_RECORD_ANSWERS / OTHER_RECORD_CHARS per
 * person, their connections' and browser's steps by name and status only) and called a tool,
 * within STEP_RECORD_TOTAL characters. Own (as chat/history-summary.ts summaryLines): in a chat several people wrote in,
 * only an answer to the asker's own message whose turn was theirs, and never one hidden from them (`withheld`); in a
 * chat of one person, every answer whose turn was theirs (an answer another person regenerated while the chat was
 * shared stays out after it is private again). Another person's steps (their connections, their cards, what their tools returned)
 * never reach this asker's AI. In a shared chat the notes (arguments, results) of an answer hidden from anyone who sees
 * the chat now, or from before the chat was shared, stay out: its lines say only what everyone there may read.
 */
export function withStepRecords<T extends RecordItem>(db: Database, items: T[], o: RecordView): T[] {
  let left = STEP_RECORD_ANSWERS
  let room = o.budget ?? STEP_RECORD_TOTAL
  const out = items.slice()
  const never = new Map<string, boolean>()
  const others = new Map<string, { n: number; chars: number }>()
  for (let i = out.length - 1; i >= 0 && left > 0 && room > 200; i--) {
    const h = out[i]!
    if (h.role !== 'assistant' || !h.id || o.withheld?.has(h.id)) continue
    const row = db.query(`SELECT m.steps, m.step_notes, m.chat_id, p.author_id AS asked_by, t.user_id AS ran_by
      FROM messages m LEFT JOIN messages p ON p.id = m.parent_id LEFT JOIN turns t ON t.id = m.turn_id WHERE m.id = ?`).get(h.id) as
      { steps: string | null; step_notes: string | null; chat_id: string; asked_by: string | null; ran_by: string | null } | null
    if (!row) continue
    // another person's turn (B regenerated an answer on A's message), also in a chat that is no longer shared: their
    // steps are theirs. A row with no turn (an older build's) is nobody's known turn: only in a chat of one person that
    // was never shared (neverShared)
    if (row.ran_by === null && (o.several || !neverShared(db, row.chat_id, o.asker, never))) continue
    // another person's answer (their turn, or an answer to their message): only in a chat shared now, where the asker
    // sees that answer (not withheld, above), with that person's own cap; their connections' and browser's steps by
    // name only (othersNotes). In a chat that is no longer shared their steps stay theirs
    // (a row with no turn got here only in a chat of one person that was never shared: theirs)
    const own = (row.ran_by === o.asker || row.ran_by === null) && (!o.several || row.asked_by === o.asker)
    const other = !own && o.several && !!o.shared && row.ran_by !== null ? row.ran_by : null
    if (!own && !other) continue
    const per = other ? others.get(other) ?? { n: 0, chars: 0 } : null
    if (per && (per.n >= OTHER_RECORD_ANSWERS || per.chars >= OTHER_RECORD_CHARS)) continue
    let steps: StoredStep[] = []
    try { const v = JSON.parse(row.steps ?? '[]'); if (Array.isArray(v)) steps = v.filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && typeof s.label === 'string') } catch {}
    if (!steps.length) continue
    const before = !!o.shared && o.shared.sharedLater(h.id)
    // (fails closed: a check that throws keeps the notes out)
    let withNotes = !before
    if (withNotes && o.shared) { try { withNotes = !o.shared.hiddenFrom(h.id) } catch { withNotes = false } }
    if (before) steps = steps.map((s) => { const { sv: _sv, tool, ...rest } = s; return { ...rest, ...(tool && knownStepTool(tool) ? { tool } : {}), label: stepWords(s, 'en') } })
    let notes = withNotes ? parseNotes(row.step_notes) : {}
    if (other) {
      const ok = new Set(steps.filter(othersNotes).map((x) => x.id))
      // (a note's own words name paths too: a write's result, "saved to users/alice/…". Kept only when the asker and
      // everyone who sees the chat now may list every path in it; fails closed: security review of batch 5)
      notes = Object.fromEntries(Object.entries(notes).filter(([id, n]) => ok.has(id) && notePathsListable(n, o.canList)))
      steps = steps.map((x) => (stepRepeatsCard(x.tool) ? (({ sv: _sv, ...rest }) => ({ ...rest, label: stepWords(x, 'en') }))(x) : x))
    }
    let text = stepsRecord(steps, notes, o.canList)
    if (!text) continue
    if (o.mapText) text = o.mapText(text)
    const cap = per ? Math.min(room, OTHER_RECORD_CHARS - per.chars) : room
    if (text.length > cap) text = `${text.slice(0, Math.max(0, cap - 40)).replace(/\n[^\n]*$/, '')}\n(older steps left out)`
    room -= text.length
    if (per && other) others.set(other, { n: per.n + 1, chars: per.chars + text.length })
    left--
    out[i] = { ...h, steps: text }
  }
  return out
}
