// Desktop team list: every team that is not the open one shows a visible "Open" (user feedback: a row did not say that a
// click opens the team); Remove stays in the row's "···" menu with its confirmation. The screen has no DOM test kit,
// so this reads the source and the strings; desktop/e2e/desktop.spec.ts clicks it in the real app.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STRINGS } from '../../desktop/src/common/i18n'

const root = join(import.meta.dir, '../..')
const welcome = readFileSync(join(root, 'desktop/src/ui/welcome.ts'), 'utf8')
const css = readFileSync(join(root, 'desktop/src/ui/ui.css'), 'utf8')
const list = welcome.slice(welcome.indexOf('function teamList()'), welcome.indexOf('function confirmBox('))

describe('desktop team list: Open first, Remove in the menu', () => {
  test('another team shows an outlined Open inside the row button; the open team keeps its quiet Current', () => {
    expect(list).toContain("? h('span', { class: 'current', 'data-testid': 'team-current' }, glyph('check'), tr('welcome.current'))")
    expect(list).toContain(": h('span', { class: 'open-pill', 'data-testid': 'team-open-pill', 'aria-hidden': 'true' }, tr('welcome.open'))")
    // one button per row: the pill is a span inside the row's button, not a second button in the tab order
    const row = list.slice(list.indexOf("class: 'team-row'"), list.indexOf("tr('welcome.open'))"))
    expect(row).toContain('team-open-pill')
    expect(row.match(/h\(\s*'button'/g)).toBeNull()
    expect(row).toContain('onclick: () => ui.welcome.open(t.id)')
  })
  test('screen readers hear "Open {team}" with the address as its description', () => {
    expect(list).toContain("'aria-label': t.current ? undefined : tr('welcome.openTeam', { team: t.label })")
    expect(list).toContain("'aria-describedby': t.current ? undefined : `team-origin-${t.id}`")
    expect(list).toContain("id: `team-origin-${t.id}`")
  })
  test('Remove from list is only in the ··· menu, with its confirmation', () => {
    const rowAndMenu = list.slice(list.indexOf("class: 'team-row'"))
    expect(rowAndMenu.indexOf("tr('welcome.remove')")).toBeGreaterThan(rowAndMenu.indexOf("role: 'menu'"))
    expect(list).toContain("role: 'menuitem'")
    expect(list).toContain('confirming = t.id')
    expect(welcome).toContain("tr('welcome.removeConfirm', { team: team.label })")
  })
  test('the Open is never the accent; touch screens get a 44px ··· ', () => {
    const pill = css.slice(css.indexOf('.team-row .open-pill {'), css.indexOf('}', css.indexOf('.team-row .open-pill {')))
    expect(pill).toContain('border: 1px solid var(--field-border)')
    expect(pill).not.toMatch(/--accent/)
    const coarse = css.slice(css.indexOf('@media (pointer: coarse) {\n  .teams .more'))
    expect(coarse).toMatch(/width: 44px;\s*height: 44px;/)
  })
  test('"Open {team}" is in every language and names the team', () => {
    for (const [loc, s] of Object.entries(STRINGS)) {
      expect(s['welcome.openTeam'], loc).toContain('{team}')
      expect(s['welcome.open'], loc).toBeTruthy()
    }
    expect(STRINGS.en['welcome.openTeam']).toBe('Open {team}')
  })
})

describe('desktop welcome: quiet help actions and Back', () => {
  test('the help view, Back and the demo link are the same quiet button: no orange underlined links, no dot between them', () => {
    expect(welcome).toContain("h('button', { type: 'button', class: 'ghost', 'data-testid': 'no-address'")
    expect(welcome).toContain("h('button', { type: 'button', class: 'ghost', 'data-testid': 'join-back'")
    expect(welcome).toContain("h('button', { type: 'button', class: 'ghost', 'data-testid': 'demo'")
    // the "no team yet" view and its install link are gone (docs/decisions/20261126-desktop-create-team.md)
    expect(welcome).not.toContain('no-team')
    expect(welcome).toContain("h('button', { type: 'button', class: 'ghost', 'data-testid': 'welcome-back'")
    expect(welcome).not.toContain("h('span', { 'aria-hidden': 'true' }, ' · ')")
    const ghost = css.slice(css.indexOf('button.ghost {'), css.indexOf('}', css.indexOf('button.ghost {')))
    expect(ghost).toContain('color: var(--muted)')
    expect(ghost).toContain('border: none')
    expect(ghost).not.toMatch(/accent|underline/)
    // 44px on a touch screen
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*button\.ghost \{\s*min-height: 44px;/)
  })
})
