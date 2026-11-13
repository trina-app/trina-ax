// The lists' rows in the source (docs/DECISIONS.md "Lists: one set of rows and headers"; components/list/List.tsx): a
// row's height, its name's look and its icon box come from the list tokens through ListRow (or the few shared pieces
// below), so a list never sets its own sizes. This fails a pull request that uses the row tokens (rowName, h-row,
// min-h-row, size-list-icon/glyph) in a file that is not one of those pieces: build the row with ListRow, rowBox or
// panelRow instead. ALLOW lists the files that may, each with its reason; an entry whose file no longer uses them fails
// too, so the list only shrinks. The computed heights are checked by web/test/e2e/type-scale.spec.ts.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(import.meta.dir, '../../src')
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name)
  return d.isDirectory() ? files(p) : /\.tsx?$/.test(d.name) ? [p] : []
})
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/')
const TOKENS = /\b(rowName|h-row|min-h-row(?:-min)?|size-list-(?:icon|glyph))\b/

/** the files that may use the row tokens themselves, and why */
const ALLOW = new Map<string, string>([
  ['components/list/List.tsx', 'the source: ListRow, ListIcon, ListSection, rowBox, headBox'],
  ['components/panels/PanelFrame.tsx', "the panels' fixed rows and group heads (panelRowBox, groupHead)"],
  ['components/nav/RoomsList.tsx', "a room's row: its own menu and drag (List.tsx), the name's look from rowName"],
  ['pages/Rooms.tsx', "the phone's 대화 tab rows: their own menu and drag, the name's look from rowName"],
  ['components/phone/PhoneChecks.tsx', "a phone's radio list (its own single source)"],
  ['components/phone/PhoneChoice.tsx', "a phone's select row (its own single source)"],
  ['components/phone/PhoneList.tsx', "a phone's info list (its own single source)"],
  ['pages/Activity.tsx', "the notification feed: three-line rows with a face, a different kind from a panel's list"],
  ['pages/Settings.tsx', "a form field's label in a row's look (rowName), not a list row"],
  ['components/ProjectParticipants.tsx', 'to fix: the participant rows wrap their controls under the name (a row with a second line of buttons)'],
])

/** the other single-source rows, for a kind of row ListRow is not (they keep their own box, the list tokens' type): every
 * list of that kind uses them, so a new list of it builds on them, not on its own markup */
const SHARED = new Map<string, string>([
  ['components/integrations/ConnectionRow.tsx', "a connection or app: a 40px logo, name, line and one status or action (docs/DECISIONS.md \"Connection rows: one look\")"],
  ['components/settings/SettingRow.tsx', 'a setting: name, line and its control (type-scale-source.test.ts locks its sizes)'],
  ['components/CompactRow.tsx', "Admin's people and groups on a phone"],
])

const sources = files(SRC).map((p) => ({ file: rel(p), text: fs.readFileSync(p, 'utf8') }))
const users = sources.filter((s) => TOKENS.test(s.text)).map((s) => s.file)

describe('list rows: one source', () => {
  test('only the shared pieces use the row tokens (build a row with ListRow, rowBox or panelRow, or one of SHARED)', () => {
    expect(users.filter((f) => !ALLOW.has(f))).toEqual([])
  })

  test('every allowed file still uses them (a stale entry fails, so the list only shrinks)', () => {
    expect([...ALLOW.keys()].filter((f) => !users.includes(f))).toEqual([])
  })

  test('every shared row is still there (a move or rename takes its entry along)', () => {
    expect([...SHARED.keys()].filter((f) => !sources.some((s) => s.file === f))).toEqual([])
  })
})
