// The shared list pieces (components/list/List.tsx; docs/DECISIONS.md "Lists: one set of rows and headers"): a row's name
// takes its look from the list tokens only (read / unread / selected), a ListRow says which place is on screen and
// keeps the test ids and data attributes it is given, and a ListSection folds with its ▸ and shows its count while folded.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { ListHeading, ListRow, ListSection, rowName } from '../../src/components/list/List'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

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
