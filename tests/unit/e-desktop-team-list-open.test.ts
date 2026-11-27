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
  test('the Open shows on the row hover or keyboard focus, and always on a touch screen', () => {
    const pill = css.slice(css.indexOf('.team-row .open-pill {'), css.indexOf('}', css.indexOf('.team-row .open-pill {')))
    expect(pill).toContain('opacity: 0')
    expect(css).toMatch(/\.team-row:hover \.open-pill,\s*\.team-row:focus-visible \.open-pill,\s*\.teams li\.menu-open \.open-pill \{\s*opacity: 1;/)
    const coarse = css.slice(css.indexOf('@media (pointer: coarse) {\n  .teams .more'))
    expect(coarse).toMatch(/\.team-row \.open-pill \{\s*padding: 6px 14px;\s*opacity: 1;/)
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

// S0's actions follow the team pickers of Slack, Notion, Linear, Figma and Discord: create and join are list rows like
// the team rows, not a coloured block (docs/AGENTS/plan/20261127-1028-team-picker-actions-redesign.md)
describe('desktop S0: create and join are quiet rows like the team rows', () => {
  const s0 = welcome.slice(welcome.indexOf('function actionRow('), welcome.indexOf('function outsideBox('))
  test('two action rows with an icon tile, no orange block and no outlined box', () => {
    expect(s0).toContain("actionRow({ id: 'create-team', icon: 'plus', title: tr('start.create'), sub: first ? tr('start.createSub') : undefined, lead: first,")
    expect(s0).toContain("actionRow({ id: 'join-team', icon: 'link', title: tr('start.join')")
    expect(welcome).not.toContain("class: 'choice primary'")
    expect(css).not.toContain('button.choice')
    const row = css.slice(css.indexOf('button.action-row {'), css.indexOf('}', css.indexOf('button.action-row {')))
    expect(row).toContain('border: none')
    expect(row).toContain('background: transparent')
    expect(row).not.toMatch(/accent/)
  })
  // the actions must not read as more teams (docs/AGENTS/plan/20261127-1053-team-picker-polish-2.md)
  test('the actions have their own voice: a bare icon, a 14px title, a chevron; the demo is the third row', () => {
    expect(s0).toContain("h('span', { class: 'go', 'aria-hidden': 'true' }, glyph(o.out ? 'external' : 'chevron'))")
    expect(s0).toContain("actionRow({ id: 'demo', icon: 'compass', title: tr('start.demo'), quiet: true, out: true,")
    expect(s0).not.toContain('demoLink()')
    const tile = css.slice(css.indexOf('.action-row .tile {'), css.indexOf('}', css.indexOf('.action-row .tile {')))
    expect(tile).not.toContain('background')
    expect(css).toMatch(/\.action-row \.name \{[^}]*font-size: 14px;/)
    expect(css).toMatch(/\.team-row \.name \{[^}]*font-size: 15px;/)
  })
  test('the first run\'s Create leads with a hairline, not a coloured block', () => {
    const lead = css.slice(css.indexOf('button.action-row.lead {'), css.indexOf('}', css.indexOf('button.action-row.lead {')))
    expect(lead).toContain('border: 1px solid var(--line)')
    expect(lead).not.toMatch(/accent|background/)
  })
  test('the "+" tile is the one accent among the actions; Join keeps the plain tile', () => {
    const block = css.slice(css.indexOf('button.action-row {'), css.indexOf('.action-row .sub-line'))
    const accentRules = block.match(/[^}]*\{[^}]*--accent[^}]*\}/g) ?? []
    expect(accentRules.length).toBe(1)
    expect(accentRules[0]).toContain('.action-row.icon-plus .tile')
  })
  test('the language is a compact control: a globe, the select, "Language" kept for screen readers', () => {
    expect(welcome).toContain("glyph('globe', 14), h('span', { class: 'sr-only' }, tr('welcome.language')), select)")
    expect(css).toContain('field-sizing: content')
  })
  test('the create line is short in every language', () => {
    for (const [loc, s] of Object.entries(STRINGS)) expect(s['start.createSub'].length, loc).toBeLessThanOrEqual(48)
  })
  test('the create line does not say "free" again under a title that already says it', () => {
    const free: Record<string, RegExp> = { ko: /무료/, en: /free/i, id: /gratis/i, ja: /無料/, es: /gratis/i, zh: /免费/ }
    for (const [loc, s] of Object.entries(STRINGS)) {
      expect(s['start.create'], loc).toMatch(free[loc])
      expect(s['start.createSub'], loc).not.toMatch(free[loc])
    }
  })
})
