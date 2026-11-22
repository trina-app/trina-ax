// The ask registry (docs/ASKS.md, docs/decisions/20261122-ask-registry.md): every place <app> asks the person for
// anything has an entry there. This test fails when the code and the registry disagree:
// - a file has more ask call sites (the patterns below) than its "Code index" row says, or a file with ask call
//   sites has no row (a new card, dialog or system prompt was added without a registry entry);
// - a card kind the code knows (an "Always allow" kind, a TurnRequest kind, an allowance kind, a tool whose card waits)
//   is not in the "Kinds" table, or the table names one the code no longer has;
// - an entry is malformed: a repeated id, an empty field, a "where" file that does not exist, a Rule A status that is
//   not OK, VIOLATION or OPEN.
// The scan is by pattern, not by markers in the card code, so card code needs no comments of its own.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { AiAllowance, CARD_ALWAYS_KINDS, TurnRequest } from '@mycel/shared/api'
import { CARD_LATER_TOOLS } from '../../server/src/chat/open-questions'

const REPO = path.resolve(import.meta.dir, '../..')
const REGISTRY = 'docs/ASKS.md'

/** Where asks are raised, and the call that raises one. A line that matches counts once. */
export const SCANS: { name: string; roots: string[]; exts: string[]; re: RegExp }[] = [
  {
    // the AI's cards: the server raises every one through these (chat/turn.ts waitForPerson and its wrappers, a tool's
    // TurnPerson.confirm / askConfirm, chat/always-allow.ts withAlways, a connect card), and a share dialog's confirm step
    name: 'server card',
    roots: ['server/src'],
    exts: ['.ts'],
    re: /waitForPerson\(|askPerson\(|askAlways\(|askConfirm\(|withAlways\(|\.confirm\(|type: 'turn\.request'|kind: 'ask_user'|kind: 'connect_service'|kind: 'browser_site'|kind: 'dev_env_site'|status: 'confirm'|state: 'confirm'|ACTION_POST\w* =|ACTION_LINK =/,
  },
  {
    // the web app's confirm dialogs (components/ui.tsx, chat/ShareToRoom.tsx, a password again: ReauthDialog), the
    // browser's own confirm() and its permission prompts (notifications, microphone, install)
    name: 'web dialog',
    roots: ['web/src'],
    exts: ['.ts', '.tsx'],
    re: /confirmDialog\(|choiceDialog\(|useConfirmStep[<(]|window\.confirm\(|<ReauthDialog\b|Notification\.requestPermission|getUserMedia\(|beforeinstallprompt/,
  },
  {
    // the desktop, menu bar and phone apps: system permission prompts and native dialogs
    name: 'app prompt',
    roots: ['desktop/src', 'desktop/electron-builder.config.ts', 'desktop/electron-builder.devid.config.ts', 'menubar/Sources', 'mobile/App.tsx', 'mobile/app.config.ts', 'mobile/src', 'mobile/modules', 'mobile/plugins', 'native'],
    exts: ['.ts', '.tsx', '.js', '.swift', '.kt', '.go', '.m'],
    re: /showMessageBox|showOpenDialog|askForMediaAccess|requestPermission|requestPermissionsAsync|new Notification\(|pane\.ask\(|launchImageLibraryAsync|alertdialog|getUserMedia\(|requestAuthorization|PermissionsAndroid|\.confirm\(|NS\w+UsageDescription|android\.permission\.|'(RECORD_AUDIO|CAMERA|POST_NOTIFICATIONS|READ_MEDIA_\w+)'/,
  },
]
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', 'e2e', 'test', 'tests', '__tests__', '.expo', 'ios', 'android'])
/** a comment line names an ask without raising one */
const COMMENT = /^\s*(\/\/|\/\*|\*|#)/
const isTestFile = (f: string) => /\.(test|spec)\.[a-z]+$/.test(f)

function walk(rel: string, exts: string[], out: string[]): void {
  const abs = path.join(REPO, rel)
  if (!fs.existsSync(abs)) return
  const st = fs.statSync(abs)
  if (st.isFile()) { if (exts.some((e) => rel.endsWith(e)) && !isTestFile(rel)) out.push(rel); return }
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory() ? SKIP_DIR.has(e.name) : false) continue
    walk(path.posix.join(rel, e.name), exts, out)
  }
}

/** file → number of lines that raise an ask, for every scanned file with at least one */
export function scanCode(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const s of SCANS) {
    const files: string[] = []
    for (const r of s.roots) walk(r, s.exts, files)
    for (const f of files) {
      const n = fs.readFileSync(path.join(REPO, f), 'utf8').split('\n').filter((l) => !COMMENT.test(l) && s.re.test(l)).length
      if (n) counts.set(f, (counts.get(f) ?? 0) + n)
    }
  }
  return counts
}

export interface Table { header: string[]; rows: string[][] }
/** the Markdown tables under a "## <section>" heading (up to the next "## ") */
export function tablesIn(md: string, section: string): Table[] {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${section}`)
  if (start < 0) return []
  const out: Table[] = []
  let cur: Table | null = null
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith('## ')) break
    if (!l.startsWith('|')) { cur = null; continue }
    const cells = l.slice(1, l.trimEnd().endsWith('|') ? l.trimEnd().length - 1 : undefined).split(/(?<!\\)\|/).map((c) => c.trim())
    if (!cur) { cur = { header: cells.map((c) => c.toLowerCase()), rows: [] }; out.push(cur); continue }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue
    cur.rows.push(cells)
  }
  return out
}
const unquote = (s: string) => s.replace(/^`|`$/g, '').trim()
const idsOf = (cell: string) => cell.split(',').map((x) => unquote(x.trim())).filter(Boolean)

export const ENTRY_FIELDS = ['id', 'where', 'trigger', 'text (en / ko)', 'buttons', 'always', 'revoke', 'scheduled', 'guests', 'reason', 'rule a'] as const
/** every registry entry, by id, with its fields by header */
export function entriesOf(md: string): { entries: Map<string, Record<string, string>>; problems: string[] } {
  const entries = new Map<string, Record<string, string>>()
  const problems: string[] = []
  for (const t of tablesIn(md, 'Registry')) {
    if (t.header[0] !== 'id') continue
    const missing = ENTRY_FIELDS.filter((f) => !t.header.includes(f))
    if (missing.length) { problems.push(`a registry table lacks the columns ${missing.join(', ')}`); continue }
    for (const r of t.rows) {
      const e: Record<string, string> = {}
      t.header.forEach((h, i) => { e[h] = r[i] ?? '' })
      const id = unquote(e.id!)
      if (!/^[a-z0-9]+(\.[a-z0-9_-]+)+$/.test(id)) problems.push(`entry id "${e.id}" is not a dotted lowercase id in backticks`)
      if (entries.has(id)) problems.push(`entry id ${id} is listed twice`)
      for (const f of ENTRY_FIELDS) if (!e[f]?.trim()) problems.push(`entry ${id}: the field "${f}" is empty (write "none" or "n/a" with a reason)`)
      if (!/^(OK|VIOLATION|OPEN)\b/.test(e['rule a'] ?? '')) problems.push(`entry ${id}: rule A must start with OK, VIOLATION or OPEN`)
      entries.set(id, e)
    }
  }
  return { entries, problems }
}

/** what the Code index says: file → sites and the ids at them */
export function indexOf(md: string): Map<string, { sites: number; ids: string[] }> {
  const m = new Map<string, { sites: number; ids: string[] }>()
  for (const t of tablesIn(md, 'Code index')) {
    const f = t.header.indexOf('file'), s = t.header.indexOf('sites'), i = t.header.indexOf('ids')
    if (f < 0 || s < 0 || i < 0) continue
    for (const r of t.rows) m.set(unquote(r[f]!), { sites: Number(r[s]), ids: idsOf(r[i]!) })
  }
  return m
}

/** ids a Code index row may name besides registry entries: a line that matches the pattern but raises nothing itself */
const NOT_AN_ASK = new Set(['definition', 'helper', 'not-an-ask'])

/** the disagreements between the scan and the Code index, as lines a person can act on */
export function indexProblems(code: Map<string, number>, index: Map<string, { sites: number; ids: string[] }>, entries: Map<string, unknown>): string[] {
  const out: string[] = []
  for (const [f, n] of code) {
    const row = index.get(f)
    if (!row) out.push(`${f}: ${n} ask call site(s) and no Code index row in ${REGISTRY}. Add an entry for each new ask and a row "| \`${f}\` | ${n} | <ids> |".`)
    // more: a new ask. Fewer passes (an ask removed; its entry is cleaned up when the row is next touched).
    else if (n > row.sites) out.push(`${f}: ${n} ask call site(s), the Code index says ${row.sites}. A card, dialog or prompt was added: give it an entry and update the row in ${REGISTRY}.`)
  }
  for (const [f, row] of index) {
    if (!code.has(f)) out.push(`${f}: in the Code index but no ask call site there now. Remove the row (and its entries if the asks are gone).`)
    for (const id of row.ids) if (!NOT_AN_ASK.has(id) && !entries.has(id)) out.push(`${f}: the Code index names ${id}, which has no registry entry.`)
  }
  return out
}

/** the card kinds the code knows, each as `<group>:<kind>` (the Kinds table's first column) */
export function codeKinds(): Set<string> {
  const k = new Set<string>()
  for (const c of CARD_ALWAYS_KINDS) k.add(`always:${c}`)
  for (const o of TurnRequest.options) k.add(`request:${o.shape.kind.value}`)
  for (const o of AiAllowance.options) k.add(`allowance:${o.shape.kind.value}`)
  for (const t of CARD_LATER_TOOLS) k.add(`waits:${t}`)
  return k
}
export function kindsOf(md: string): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const t of tablesIn(md, 'Kinds')) {
    if (t.header[0] !== 'kind') continue
    for (const r of t.rows) m.set(unquote(r[0]!), idsOf(r[1] ?? ''))
  }
  return m
}

const MD = fs.readFileSync(path.join(REPO, REGISTRY), 'utf8')
const { entries, problems } = entriesOf(MD)

describe('ask registry (docs/ASKS.md)', () => {
  test('every entry is well formed', () => {
    expect(problems).toEqual([])
    expect(entries.size).toBeGreaterThan(50)
  })

  test("every entry's file exists", () => {
    const bad: string[] = []
    for (const [id, e] of entries) {
      const files = [...e.where!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/:\d+(-\d+)?(,\d+)*$/, ''))
      if (!files.length) bad.push(`${id}: "where" names no file in backticks`)
      for (const f of files) if (!fs.existsSync(path.join(REPO, f))) bad.push(`${id}: ${f}`)
    }
    expect(bad).toEqual([])
  })

  test('every ask call site in the code is in the Code index', () => {
    expect(indexProblems(scanCode(), indexOf(MD), entries)).toEqual([])
  })

  test('every card kind the code knows is in the Kinds table, and only those', () => {
    const code = codeKinds(), table = kindsOf(MD)
    expect([...code].filter((k) => !table.has(k)).map((k) => `${k}: no row in the Kinds table`)).toEqual([])
    expect([...table.keys()].filter((k) => !code.has(k)).map((k) => `${k}: in the Kinds table, not in the code`)).toEqual([])
    const unknown = [...table].flatMap(([k, ids]) => (ids.length ? ids : ['(none)']).filter((id) => !entries.has(id)).map((id) => `${k}: ${id} has no registry entry`))
    expect(unknown).toEqual([])
  })

  test('the guard fails on a new ask without an entry', () => {
    const code = scanCode(), index = indexOf(MD)
    const [file, n] = [...code][0]!
    const more = new Map(code).set(file, n + 1)
    expect(indexProblems(more, index, entries).join('\n')).toContain(`${file}: ${n + 1} ask call site(s)`)
    const fresh = new Map(code).set('server/src/chat/new-card.ts', 1)
    expect(indexProblems(fresh, index, entries).join('\n')).toContain('server/src/chat/new-card.ts: 1 ask call site(s) and no Code index row')
  })
})
