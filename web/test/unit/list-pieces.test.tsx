// The shared list pieces (components/list/List.tsx; docs/DECISIONS.md "Lists: one set of rows and headers"): a row's name
// takes its look from the list tokens only (read / unread / selected), a ListRow says which place is on screen and
// keeps the test ids and data attributes it is given, and a ListSection folds with its ▸ and shows its count while folded.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRef } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { GroupChevron, ListHeading, ListRow, ListSection, rowName } from '../../src/components/list/List'
import { useSession } from '../../src/store/session'
import { withFold } from '../../src/components/panels/folds'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'

const before = useSession.getState().status
beforeAll(() => {
  installDom()
  // a section's fold is remembered per person (panels/folds.ts)
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia' } } } } as never)
})
afterAll(() => {
  useSession.setState({ status: before })
  removeDom()
})

describe('rowName', () => {
  test('read rows use the read tokens; unread and selected are semibold in ink', () => {
    expect(rowName()).toBe('text-row font-row-read text-row-read')
    expect(rowName({ unread: true })).toBe('text-row font-semibold text-ink')
    expect(rowName({ selected: true })).toBe('text-row font-semibold text-ink')
  })
  test('no one-off sizes or colours in a row name', () => {
    for (const c of [rowName(), rowName({ unread: true })]) expect(c).not.toMatch(/text-(xs|sm|base|\[)|text-muted|text-faint/)
  })
})

describe('ListRow', () => {
  test('a link row: the name, the meta line, aria-current when selected, its test ids and data attributes', async () => {
    const m = await mount(
      <MemoryRouter>
        <ul>
          <ListRow to="/projects/p1" selected unread={false} icon={<svg />} name="Acme launch" meta="나만 · 3시간 전" testId="row" nameTestId="row-name" metaTestId="row-meta" link={{ 'data-chip': 'trina' }} />
        </ul>
      </MemoryRouter>,
    )
    try {
      const row = m.get('row')
      expect(row.localName).toBe('a')
      expect(row.getAttribute('aria-current')).toBe('page')
      expect(row.getAttribute('data-chip')).toBe('trina')
      expect(row.className).toContain('min-h-row-min')
      expect(row.className).toContain('bg-hover')
      expect(m.get('row-name').textContent).toBe('Acme launch')
      expect(m.get('row-name').className).toContain('font-semibold')
      expect(m.get('row-meta').className).toContain('text-meta')
    } finally {
      await m.unmount()
    }
  })
  test('a button row when there is no link; read look, no aria-current', async () => {
    let clicked = 0
    const m = await mount(
      <ul>
        <ListRow onClick={() => clicked++} name="휴지통" testId="row" nameTestId="row-name" />
      </ul>,
    )
    try {
      const row = m.get('row')
      expect(row.localName).toBe('button')
      expect(row.getAttribute('aria-current')).toBeNull()
      expect(m.get('row-name').className).toContain('text-row-read')
      await m.click(row)
      expect(clicked).toBe(1)
    } finally {
      await m.unmount()
    }
  })
})

describe('ListRow: actions, a row menu, refs, the <li>, the tag', () => {
  test('actions sit beside the click area, outside the link; the <li> takes className, data-* and aria-*; rowRef is the link', async () => {
    let ran = 0
    const ref = createRef<HTMLElement>()
    const m = await mount(
      <MemoryRouter>
        <ul>
          <ListRow to="/skills/a" name="견적서" testId="row" rowRef={ref} strong nameTestId="row-name" li={{ className: 'opacity-70', 'data-testid': 'li', 'data-path': 'skills/a', 'aria-label': 'a skill' }} actions={<button type="button" onClick={() => ran++} data-testid="run">실행</button>} />
        </ul>
      </MemoryRouter>,
    )
    try {
      const li = m.get('li')
      expect(li.getAttribute('class')).toContain('opacity-70')
      expect(li.getAttribute('data-path')).toBe('skills/a')
      expect(li.getAttribute('aria-label')).toBe('a skill')
      expect(ref.current).toBe(m.get('row') as never)
      // the action is not inside the link
      expect(m.get('row').querySelector('[data-testid="run"]')).toBeNull()
      await m.click('run')
      expect(ran).toBe(1)
      // strong: medium in ink whether read or not
      expect(m.get('row-name').className).toContain('font-medium text-ink')
    } finally {
      await m.unmount()
    }
  })
  test('rowMenu: a "···" beside the link; a right-click on the row opens it, and the words keep clear of it', async () => {
    let picked = 0
    const m = await mount(
      <MemoryRouter initialEntries={['/']}>
        <ul>
          <ListRow to="/c/1" name="채팅 1" testId="row" rowMenu={{ items: [{ label: '고정', onSelect: () => picked++, testId: 'pin' }], label: '채팅 1 메뉴', testId: 'row-menu' }} />
        </ul>
      </MemoryRouter>,
    )
    try {
      const link = m.get('row')
      expect(link.className).toContain('pr-9')
      expect(link.querySelector('[data-testid="row-menu"]')).toBeNull()
      // a click on the row is not stopped by the menu's guard (no long press before it)
      const c = new FakeEvent('click', { bubbles: true, cancelable: true })
      link.dispatchEvent(c as never)
      expect(c.defaultPrevented).toBe(false)
      const e = new FakeEvent('contextmenu', { bubbles: true, cancelable: true })
      link.dispatchEvent(e as never)
      await m.until(() => m.find('pin') !== null, 'the menu')
      expect(e.defaultPrevented).toBe(true)
      await m.click('pin')
      expect(picked).toBe(1)
    } finally {
      await m.unmount()
    }
  })
  test('tag: one trailing slot, 13px and faint, at most 40% of the row; choice: the row is the label of its tick', async () => {
    const m = await mount(
      <ul>
        <ListRow name="민준" tag="acme-web" tagTestId="tag" testId="row" />
        <ListRow choice name="민지" end={<input type="checkbox" data-testid="tick" />} testId="pick" />
      </ul>,
    )
    try {
      expect(m.get('tag').className).toContain('max-w-[40%]')
      expect(m.get('tag').className).toContain('text-meta')
      expect(m.get('tag').className).toContain('ml-auto')
      expect(m.get('pick').localName).toBe('label')
      expect(m.get('pick').querySelector('[data-testid="tick"]')).not.toBeNull()
    } finally {
      await m.unmount()
    }
  })
  test('metaKeep (QA TC-4729): the meta is cut first, the kept end (a file\'s time and size) never shrinks or wraps', async () => {
    const m = await mount(
      <ul>
        <ListRow name="report.pdf" meta="Direct message · A very long member name" metaKeep="5:41 PM · 2 KB" metaTestId="meta" />
        <ListRow name="photo.png" metaKeep="5:41 PM · 2 KB" metaTestId="alone" />
      </ul>,
    )
    try {
      const line = m.get('meta')
      expect(line.className).toContain('flex')
      expect(line.className).toContain('whitespace-nowrap')
      expect(line.className).toContain('text-meta')
      const [cut, kept] = Array.from(line.children)
      expect(cut.className).toContain('truncate')
      expect(cut.className).toContain('min-w-0')
      expect(cut.getAttribute('title')).toBe('Direct message · A very long member name')
      expect(kept.className).toContain('shrink-0')
      expect(kept.className).not.toContain('truncate')
      expect(line.textContent).toBe('Direct message · A very long member name · 5:41 PM · 2 KB')
      // no meta: the kept end alone, without a leading dot
      expect(m.get('alone').textContent).toBe('5:41 PM · 2 KB')
    } finally {
      await m.unmount()
    }
  })
})

describe('ListSection and ListHeading', () => {
  test('the ▸ folds the section; the count shows only while folded; the header uses the list-head tokens', async () => {
    const m = await mount(
      <ListSection id="s1" foldKey="test:s1" label="팀 대화방" count={3} labelTestId="label">
        <ul>
          <li data-testid="inside">x</li>
        </ul>
      </ListSection>,
    )
    try {
      expect(m.get('label').querySelector('h3')?.className ?? '').toContain('text-list-head')
      expect(m.find('inside')).not.toBeNull()
      expect(m.find('panel-section-count')).toBeNull()
      await m.click('panel-section-fold')
      await m.until(() => m.find('inside') === null, 'the section folded')
      expect(m.get('panel-section-count').textContent).toBe('3')
      await m.click('panel-section-fold')
      await m.until(() => m.find('inside'), 'the section open again')
    } finally {
      await m.unmount()
    }
  })
  test('folded (docs/decisions/20261116-collapsible-chat-sections.md): the pill takes the count\'s place inside the button, the name turns bold, `keep` stays drawn', async () => {
    const m = await mount(
      <ListSection id="s2" foldKey="test:s2" label="Group chats" count={4} unread pill={<span data-testid="pill">@<span className="sr-only">one of them mentions you</span></span>} keep={<ul><li data-testid="kept">open room</li></ul>} labelTestId="label">
        <ul>
          <li data-testid="inside">x</li>
          <li data-testid="kept">open room</li>
        </ul>
      </ListSection>,
    )
    try {
      // open: no pill, the usual weight, every row
      expect(m.find('pill')).toBeNull()
      expect(m.get('label').querySelector('h3')?.className ?? '').toContain('font-semibold')
      await m.click('panel-section-fold')
      await m.until(() => m.find('inside') === null, 'the section folded')
      expect(m.get('panel-section-fold').getAttribute('aria-expanded')).toBe('false')
      // the pill is in the fold button (its words are the button's name), the count is not shown beside it
      expect(m.get('panel-section-fold').contains(m.get('pill'))).toBe(true)
      expect(m.find('panel-section-count')).toBeNull()
      expect(m.get('label').querySelector('h3')?.className ?? '').toContain('font-bold text-ink')
      expect(m.get('kept').textContent).toBe('open room')
      await m.click('panel-section-fold')
      await m.until(() => m.find('inside'), 'open again')
      expect(m.find('pill')).toBeNull()
    } finally {
      await m.unmount()
    }
  })
  test('the folds are the account\'s: a fold kept there starts folded on this device, and a choice is saved to the account', async () => {
    const was = useSession.getState()
    const saved: unknown[] = []
    useSession.setState({
      status: { kind: 'signed-in', me: { user: { id: 'mia', prefs: { listFolds: { 'section:test:s3': 'folded' } } } } },
      updatePrefs: async (p: unknown) => { saved.push(p); return true },
    } as never)
    const m = await mount(
      <ListSection id="s3" foldKey="test:s3" label="Team rooms" labelTestId="label">
        <ul>
          <li data-testid="inside">x</li>
        </ul>
      </ListSection>,
    )
    try {
      expect(m.find('inside')).toBeNull()
      await m.click('panel-section-fold')
      await m.until(() => saved.length === 1, 'saved')
      expect(saved[0]).toEqual({ listFolds: { 'section:test:s3': 'open' } })
    } finally {
      await m.unmount()
      useSession.setState({ status: was.status, updatePrefs: was.updatePrefs })
    }
  })
  test('withFold: the newest choice last, at most 200 kept (the oldest go)', () => {
    let f = {}
    for (let i = 0; i < 205; i++) f = withFold(f, `room-folder:f${i}`, 'folded')
    expect(Object.keys(f)).toHaveLength(200)
    expect(Object.keys(f)[0]).toBe('room-folder:f5')
    f = withFold(f, 'room-folder:f5', 'open')
    expect(Object.entries(f).at(-1)).toEqual(['room-folder:f5', 'open'])
  })
  test('a heading that does not fold has the same look', async () => {
    const m = await mount(<ListHeading as="h2" testId="h">고정됨</ListHeading>)
    try {
      expect(m.get('h').localName).toBe('h2')
      expect(m.get('h').className).toContain('text-list-head font-semibold text-list-head-ink')
    } finally {
      await m.unmount()
    }
  })
})

// QA TC-1082: a header with a link (파일's 팀 폴더) put its words ~20px right of the others on a phone: its ▸ was a 44px
// box. The same 24px slot as a header's own ▸; a finger gets its 44px from touch-hit.
describe('GroupChevron', () => {
  test('the 24px slot of a section header\'s ▸, at every width; the touch area from touch-hit', async () => {
    const m = await mount(<GroupChevron folded={false} controls="x" label="Team folders" onClick={() => {}} testId="chev" />)
    try {
      const cls = m.get('chev').className.split(' ')
      expect(cls).toContain('size-6')
      expect(cls).toContain('touch-hit')
      // a phone: nothing wider than the slot (touch-hit's ::after takes the taps); a wider touch screen: 44px that takes
      // only 24px of the row (-10px each side)
      expect(cls.filter((c) => /(^|:)(size|w|min-w)-/.test(c) && c !== 'size-6' && !c.startsWith('md:pointer-coarse:'))).toEqual([])
      expect(cls).toContain('md:pointer-coarse:w-11')
      expect(cls).toContain('md:pointer-coarse:-mx-2.5')
    } finally {
      await m.unmount()
    }
  })
})
