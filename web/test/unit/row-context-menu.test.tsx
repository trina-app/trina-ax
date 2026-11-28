// A right-click on a list row opens that row's "···" menu, the same items in the same order (rooms/MenuButton.tsx
// useRowMenu, the one way every row takes; docs/AGENTS/plan/20261128-1102-row-context-menu.md):
// - the hook: a right-click opens the menu and cancels the event (so the desktop app's own menu stays away); a text box,
//   Shift and a row with no menu keep the browser's own; Shift+F10 and the menu key open it from the keyboard; Esc
//   gives the keyboard back to the row;
// - the guard: every row's menu in web/src (a MenuButton or RoomMenu with a row's `sheetTitle` / `title`) takes the
//   hook's bundle (`open`), and every surface the owner named has it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { MemoryRouter } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { ListRow } from '../../src/components/list/List'
import { MenuButton, useRowMenu } from '../../src/components/rooms/MenuButton'
import { FakeEvent, installDom, mount, removeDom, type FakeElement } from './dom-host'

beforeAll(() => installDom())
afterAll(() => removeDom())

const items = (log: string[]) => [
  { label: 'Pin', onSelect: () => log.push('pin'), testId: 'it-pin' },
  { label: 'Copy link', onSelect: () => log.push('link'), testId: 'it-link' },
  { label: 'Delete', onSelect: () => log.push('delete'), danger: true, testId: 'it-delete' },
]
const menuIds = (doc: FakeElement) => (doc.querySelectorAll('[role="menuitem"]') as unknown as FakeElement[]).map((e) => e.getAttribute('data-testid'))
const rightClick = (el: FakeElement, o: { shiftKey?: boolean; x?: number; y?: number } = {}) => {
  const e = new FakeEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: o.shiftKey })
  Object.assign(e, { button: 2, clientX: o.x ?? 120, clientY: o.y ?? 40 })
  el.dispatchEvent(e as never)
  return e
}
const key = (el: FakeElement, k: string, shiftKey = false) => {
  const e = new FakeEvent('keydown', { bubbles: true, cancelable: true, key: k, shiftKey })
  el.dispatchEvent(e as never)
  return e
}

function Row({ withBox = false }: { withBox?: boolean }) {
  const log: string[] = []
  return (
    <MemoryRouter>
      <ul>
        <ListRow to="/c/1" name={withBox ? <textarea data-testid="box" /> : 'Quote draft'} testId="row" rowMenu={{ items: items(log), label: 'Quote draft menu', testId: 'row-menu' }} />
      </ul>
    </MemoryRouter>
  )
}

describe('useRowMenu: a right-click opens the row\'s "···"', () => {
  test('the same items in the same order as the "···", and the event is cancelled (no browser or desktop menu)', async () => {
    const m = await mount(<Row />)
    try {
      const body = m.container.ownerDocument!.body as unknown as FakeElement
      await m.click('row-menu')
      const byButton = menuIds(body)
      expect(byButton).toEqual(['it-pin', 'it-link', 'it-delete'])
      // closed again with its button
      await m.click('row-menu')
      await m.until(() => menuIds(body).length === 0, 'the menu closed')
      const e = rightClick(m.get('row'))
      expect(e.defaultPrevented).toBe(true)
      await m.until(() => menuIds(body).length > 0, 'the menu opened')
      expect(menuIds(body)).toEqual(byButton)
    } finally {
      await m.unmount()
    }
  })

  test('Shift+right-click and a text box keep the browser\'s own menu', async () => {
    const m = await mount(<Row withBox />)
    try {
      const body = m.container.ownerDocument!.body as unknown as FakeElement
      expect(rightClick(m.get('row'), { shiftKey: true }).defaultPrevented).toBe(false)
      expect(rightClick(m.get('box')).defaultPrevented).toBe(false)
      await m.settle()
      expect(menuIds(body)).toEqual([])
    } finally {
      await m.unmount()
    }
  })

  test('a row without a menu keeps the browser\'s own', async () => {
    const m = await mount(<MemoryRouter><ul><ListRow to="/c/2" name="No menu" testId="plain" /></ul></MemoryRouter>)
    try {
      expect(rightClick(m.get('plain')).defaultPrevented).toBe(false)
    } finally {
      await m.unmount()
    }
  })

  for (const [name, k, shift] of [['Shift+F10', 'F10', true], ['the menu key', 'ContextMenu', false]] as const)
    test(`${name} on the focused row opens it; Esc gives the keyboard back to the row`, async () => {
      const m = await mount(<Row />)
      try {
        const body = m.container.ownerDocument!.body as unknown as FakeElement
        const link = m.get('row')
        link.focus()
        const e = key(link, k, shift)
        expect(e.defaultPrevented).toBe(true)
        await m.until(() => menuIds(body).length > 0, 'the menu opened')
        // the browser's contextmenu right after the key is the same press: no second menu, no browser menu
        const after = new FakeEvent('contextmenu', { bubbles: true, cancelable: true })
        link.dispatchEvent(after as never)
        expect(after.defaultPrevented).toBe(true)
        // the keyboard is in the menu; Esc closes it and the row's link has it again
        const first = body.querySelector('[data-testid="it-pin"]')!
        expect(m.container.ownerDocument!.activeElement).toBe(first)
        key(first, 'Escape')
        await m.until(() => menuIds(body).length === 0, 'the menu closed')
        expect(m.container.ownerDocument!.activeElement).toBe(link)
      } finally {
        await m.unmount()
      }
    })

  test('a menu opened by the row runs an item and gives the keyboard back to the row', async () => {
    const log: string[] = []
    function Custom() {
      const menu = useRowMenu()
      return (
        <ul>
          <li {...menu.row} data-testid="li">
            <a href="/x" data-testid="link">x</a>
            <MenuButton label="x menu" items={items(log)} {...menu.open} testId="x-menu" />
          </li>
        </ul>
      )
    }
    const m = await mount(<Custom />)
    try {
      rightClick(m.get('link'))
      await m.until(() => m.find('it-link'), 'the menu')
      await m.click('it-link')
      expect(log).toEqual(['link'])
      expect(m.container.ownerDocument!.activeElement).toBe(m.get('link'))
    } finally {
      await m.unmount()
    }
  })

  test('a dialog the row renders through a portal (a room row\'s section picker) and the open menu keep their own presses', async () => {
    const log: string[] = []
    function Portal() {
      const menu = useRowMenu()
      return (
        <ul>
          <li {...menu.row} data-testid="li">
            <a href="/x" data-testid="link">x</a>
            <MenuButton label="x menu" items={items(log)} {...menu.open} testId="x-menu" />
            {createPortal(<div role="dialog" data-testid="picker"><button type="button" data-testid="pick">Section</button></div>, document.body)}
          </li>
        </ul>
      )
    }
    const m = await mount(<Portal />)
    try {
      const body = m.container.ownerDocument!.body as unknown as FakeElement
      // React passes the dialog's right-click and Shift+F10 up to the row: the row leaves them alone
      expect(rightClick(m.get('pick')).defaultPrevented).toBe(false)
      expect(key(m.get('pick'), 'F10', true).defaultPrevented).toBe(false)
      await m.settle()
      expect(menuIds(body)).toEqual([])
      // a right-click inside the row's open menu does not open it again somewhere else
      rightClick(m.get('link'), { x: 50, y: 20 })
      await m.until(() => m.find('it-pin'), 'the menu')
      const inMenu = rightClick(m.get('it-pin'), { x: 400, y: 300 })
      expect(inMenu.defaultPrevented).toBe(false)
      await m.click('it-pin')
      expect(log).toEqual(['pin'])
    } finally {
      await m.unmount()
    }
  })

  test('`off`: no menu, the browser\'s own stays', async () => {
    function Off() {
      const menu = useRowMenu({ off: true })
      return <div {...menu.row} data-testid="off">x</div>
    }
    const m = await mount(<Off />)
    try {
      expect(rightClick(m.get('off')).defaultPrevented).toBe(false)
      expect(key(m.get('off'), 'F10', true).defaultPrevented).toBe(false)
    } finally {
      await m.unmount()
    }
  })
})

// ---------------- the guard ----------------

const SRC = join(import.meta.dir, '../../src')
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f)
  return statSync(p).isDirectory() ? files(p) : /\.tsx$/.test(f) ? [p] : []
})
const sources = files(SRC).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }))

/** each JSX element `<Tag …>` / `<Tag … />` in a file, its props' text (braces counted, so an icon={<X />} inside is kept) */
function elements(text: string, tag: string): string[] {
  const out: string[] = []
  for (let i = text.indexOf(`<${tag}`); i >= 0; i = text.indexOf(`<${tag}`, i + 1)) {
    const next = text[i + tag.length + 1]
    if (next && /[A-Za-z0-9_]/.test(next)) continue
    let depth = 0
    let j = i + tag.length + 1
    for (; j < text.length; j++) {
      const c = text[j]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (depth === 0 && (c === '>' || (c === '/' && text[j + 1] === '>'))) break
    }
    out.push(text.slice(i, j))
  }
  return out
}

/** menus with a row's name on a phone's sheet that are not a list row's, or open at the pointer their own way */
const NOT_A_ROW: Record<string, string> = {
  'components/rooms/MenuButton.tsx': 'the menu itself',
  'components/FileMenu.tsx': "a picture's or file chip's own menu, already at the pointer (useFileMenu)",
  'components/messages/MessageActions.tsx': "a message's menu: its own long press",
  'components/TitleMenu.tsx': "a page's title menu",
  'components/SearchDialog.tsx': "the search dialog's results: a combobox with its own keys",
  'components/AvailableSkills.tsx': "the skills list's phone sheet (its computer dropdown is its own, a follow-up)",
  'pages/Scheduled.tsx': "a phone's new-task sheet",
  'pages/admin/RowMenu.tsx': 'Admin › Members and Groups: a table with its own dropdown (a follow-up)',
}

/** menus by their test id in a file that also has rows: a page header's "···", not a row's */
const NOT_A_ROW_MENU = ['testId="project-menu"']

describe('every row with a "···" opens it on a right-click', () => {
  test("a row's menu (a MenuButton with a sheet title, a RoomMenu with a row's title) takes useRowMenu's `open`", () => {
    const missing: string[] = []
    for (const s of sources) {
      if (NOT_A_ROW[s.path]) continue
      for (const el of elements(s.text, 'MenuButton')) if (el.includes('sheetTitle') && !NOT_A_ROW_MENU.some((x) => el.includes(x)) && !/\{\.\.\.[\w.]*open\}|rowBack=/.test(el)) missing.push(`${s.path}: ${el.slice(0, 80).replace(/\s+/g, ' ')}`)
      for (const el of elements(s.text, 'RoomMenu')) if (/\btitle=/.test(el) && !/\{\.\.\.[\w.]*open\}/.test(el)) missing.push(`${s.path}: ${el.slice(0, 80).replace(/\s+/g, ' ')}`)
    }
    expect(missing).toEqual([])
  })

  test('a file that calls useRowMenu puts both halves on: `row` on the row, `open` (or its signals) on the menu', () => {
    for (const s of sources.filter((x) => /\buseRowMenu\(/.test(x.text) && x.path !== 'components/rooms/MenuButton.tsx')) {
      expect(`${s.path} row: ${/\w+\.row\b(?![.\w])/.test(s.text)}`).toBe(`${s.path} row: true`)
      expect(`${s.path} open: ${/\.open\b/.test(s.text)}`).toBe(`${s.path} open: true`)
    }
  })

  test('the rows the owner named: each one has it', () => {
    const has = (path: string, re: RegExp) => expect(`${path}: ${re.test(sources.find((x) => x.path === path)!.text)}`).toBe(`${path}: true`)
    // the Projects panel: a project's row and its chats' rows (ListRow rowMenu takes the hook itself)
    const panel = sources.find((x) => x.path === 'components/panels/ProjectsPanel.tsx')!.text
    expect(panel.match(/rowMenu=\{\{/g)?.length).toBe(2)
    has('components/list/List.tsx', /const rm = useRowMenu\(\)[\s\S]*\{\.\.\.rm\.open\}/)
    // the Trina history's rows, the Chats panel's room and DM rows, the Rooms page's
    has('components/nav/ChatItem.tsx', /\{\.\.\.menu\.open\}/)
    has('components/nav/RoomsList.tsx', /\{\.\.\.menu\.open\}/)
    has('pages/Rooms.tsx', /\{\.\.\.menu\.open\}/)
    // a project page's chats (ListRow) and the Projects page's cards
    has('pages/Projects.tsx', /rowMenu=\{\{[\s\S]*project-chat-menu/)
    has('pages/Projects.tsx', /function ProjectCard\b[\s\S]*useRowMenu\(\)/)
    // the Files page's file and folder rows
    has('pages/Files.tsx', /useRowMenu\(\{ off: dim/)
    // the section headers with a "···": my sections (Chats, the Trina history) and 트리나 기록
    has('components/nav/HistorySections.tsx', /headProps=\{menu\.row\}/)
    has('components/panels/RoomsByKind.tsx', /headProps=\{s\.folder \? menu\.row/)
    has('components/panels/TrinaList.tsx', /headProps=\{headMenu\.row\}/)
  })
})
