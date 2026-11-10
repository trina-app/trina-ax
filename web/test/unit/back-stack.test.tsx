// The phone's back stack for pages under a list (lib/backStack.ts; docs/DECISIONS.md "Admin and Settings on phones: a
// list you tap into"): what is noted under each history entry, when the list is put under a page, the ‹ label and
// where a page's scroll goes. Every case the plan's review raised:
// - a page opened from its list, or from another page of its area (Folder permissions' views, the access editor's way
//   back, a link from Members to Team settings) gets nothing put under it (no loop);
// - a page opened from outside (an Inbox notice, a chat, a push, a pasted address, the first entry) gets its list;
// - Back/Forward and a reload never rebuild; the first entry, reported as POP too, does;
// - an old address that redirects is judged by where the first address was opened from;
// - nothing before the page is final (a redirect, a member, Slack for a non-owner, Settings still loading), never on a
//   computer and never on a resize;
// - ‹ names where Back goes, alone when that has no name here or is the same page.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { useState } from 'react'
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigationType, type InitialEntry } from 'react-router-dom'
import { BELOW, backLabel, createTrail, needsList, noteEntry, noteLocation, resetTrail, scrollOnShow, useBackLabel, useListUnderPage } from '../../src/lib/backStack'
import { fixCount, sectionOf } from '../../src/pages/admin/overview'
import { rowValue } from '../../src/pages/admin/PhoneRoot'
import { FakeEvent, installDom, mount, removeDom, type FakeElement } from './dom-host'

const historyBefore = Object.getOwnPropertyDescriptor(globalThis, 'history')
const historyAt = (idx: number | null) => Object.defineProperty(globalThis, 'history', { configurable: true, writable: true, value: { state: idx === null ? null : { usr: null, key: 'k', idx } } })

beforeAll(() => installDom())
afterAll(() => {
  if (historyBefore) Object.defineProperty(globalThis, 'history', historyBefore)
  removeDom()
})
beforeEach(() => resetTrail())

describe('what is under an entry', () => {
  test('a push: the entry shown before; a replace: what was under the entry it replaced; Back to an unseen one: nothing', () => {
    const t = createTrail()
    noteEntry(t, 'a', '/settings', 'POP', null)
    noteEntry(t, 'b', '/admin', 'PUSH', null)
    expect(t.below.get('b')).toBe('/settings')
    noteEntry(t, 'c', '/admin/engines', 'PUSH', null)
    expect(t.below.get('c')).toBe('/admin')
    // the old address redirects (a replace): the new entry has what the old one had under it
    noteEntry(t, 'd', '/admin/providers', 'REPLACE', null)
    expect(t.below.get('d')).toBe('/admin')
    // seen again (Back, then Forward): what was noted when it was new
    noteEntry(t, 'b', '/admin', 'POP', null)
    noteEntry(t, 'd', '/admin/providers', 'POP', null)
    expect(t.below.get('d')).toBe('/admin')
    noteEntry(t, 'z', '/admin/usage', 'POP', null)
    expect(t.below.get('z')).toBeNull()
  })

  test('an entry this module made says what is under it, and that wins', () => {
    const t = createTrail()
    noteEntry(t, 'a', '/c/1', 'POP', null)
    noteEntry(t, 'b', '/admin/members', 'PUSH', { [BELOW]: '/admin' })
    expect(t.below.get('b')).toBe('/admin')
  })

  test('the same entry shown twice in a row changes nothing (a render again)', () => {
    const t = createTrail()
    noteEntry(t, 'a', '/', 'POP', null)
    noteEntry(t, 'b', '/admin', 'PUSH', null)
    noteEntry(t, 'b', '/admin', 'PUSH', null)
    expect(t.below.get('b')).toBe('/')
    expect(t.lastPath).toBe('/admin')
  })
})

describe('when the list goes under a page', () => {
  const at = (nav: 'PUSH' | 'REPLACE' | 'POP', below: string | null | undefined, o: { idx?: number | null; own?: boolean; list?: string } = {}) =>
    needsList({ nav, below, idx: o.idx ?? 3, listPath: o.list ?? '/admin', own: o.own ?? false })

  test('opened from its list or from another page of its area: never (no loop)', () => {
    expect(at('PUSH', '/admin')).toBe(false)
    // Folder permissions' By folder ↔ By person, the access editor's way back, Members → Team settings' usage limits
    expect(at('PUSH', '/admin/folders')).toBe(false)
    expect(at('PUSH', '/admin/members')).toBe(false)
    // a filter that replaces the entry
    expect(at('REPLACE', '/admin')).toBe(false)
    expect(at('PUSH', '/settings', { list: '/settings' })).toBe(false)
    expect(at('PUSH', '/settings/notifications', { list: '/settings' })).toBe(false)
  })

  test('opened from outside its area: yes', () => {
    // an Inbox notice, a chat, Home, a project, Settings for an Admin page, Admin for a Settings section
    for (const from of ['/settings/notifications', '/c/abc', '/', '/projects/p1', '/settings', '/rooms/r1']) expect(at('PUSH', from)).toBe(true)
    expect(at('PUSH', '/admin/members', { list: '/settings' })).toBe(true)
    // nothing known under it
    expect(at('PUSH', null)).toBe(true)
    // "/administrator" is not under "/admin"
    expect(at('PUSH', '/administrator')).toBe(true)
  })

  test('Back, Forward and a reload never rebuild; the first entry of the document does', () => {
    expect(at('POP', '/c/abc')).toBe(false)
    expect(at('POP', null, { idx: 5 })).toBe(false)
    // a pasted address, the phone app opened on a push: the router says POP for the first entry too
    expect(at('POP', null, { idx: 0 })).toBe(true)
    expect(at('POP', null, { idx: null })).toBe(false)
  })

  test('Back to a first entry seen before without its list (a computer, then narrowed): not rebuilt', () => {
    expect(at('POP', null, { idx: 0 }) && needsList({ nav: 'POP', below: null, idx: 0, listPath: '/admin', own: false, fresh: false })).toBe(false)
    const t = createTrail()
    noteEntry(t, 'a', '/admin/members', 'POP', null)
    expect(t.newKey).toBe('a')
    noteEntry(t, 'b', '/c/1', 'PUSH', null)
    noteEntry(t, 'a', '/admin/members', 'POP', null)
    expect(t.newKey).toBeNull()
  })

  test('an entry already rebuilt is left alone', () => {
    expect(at('PUSH', '/c/abc', { own: true })).toBe(false)
    expect(at('POP', null, { idx: 0, own: true })).toBe(false)
  })
})

describe('the ‹ label', () => {
  const names: Record<string, string> = { '/admin': 'Admin', '/admin/members': 'Members & invites', '/settings': 'Settings', '/settings/notifications': 'Inbox' }
  const label = (below: string | null | undefined, path: string, idx: number | null = 3, fallback = '/admin') => backLabel({ below, path, idx, fallback, name: (p) => names[p] ?? null })

  test('names where Back goes', () => {
    expect(label('/admin', '/admin/members')).toBe('Admin')
    expect(label('/admin/members', '/admin/settings')).toBe('Members & invites')
    expect(label('/settings', '/admin', 3, '/settings')).toBe('Settings')
    expect(label('/settings/notifications', '/admin', 3, '/settings')).toBe('Inbox')
  })

  test('‹ alone: somewhere without a name here (Admin opened from ☰ › Search on Home), or the same page', () => {
    expect(label('/', '/admin', 3, '/settings')).toBeNull()
    expect(label('/c/1', '/admin', 3, '/settings')).toBeNull()
    // Folder permissions' rule editor and its way back add history inside one page
    expect(label('/admin/folders', '/admin/folders')).toBeNull()
  })

  test('nothing of ours under it: the first entry is named after where ‹ goes instead; later ones are ‹ alone', () => {
    expect(label(null, '/admin', 0, '/settings')).toBe('Settings')
    expect(label(undefined, '/admin', null, '/settings')).toBe('Settings')
    expect(label(null, '/admin', 4, '/settings')).toBeNull()
  })
})

describe('where a page\'s scroll goes', () => {
  test('Back or Forward: where it was; a push: the top; a replace, a #hash or a ?query the page scrolls to: left to the page', () => {
    expect(scrollOnShow('POP', '', '')).toBe('restore')
    expect(scrollOnShow('PUSH', '', '')).toBe('top')
    expect(scrollOnShow('PUSH', '#ai-limits', '')).toBe('keep')
    for (const q of ['?member=bob', '?focus=hwp', '?folder=shared']) expect(scrollOnShow('PUSH', '', q)).toBe('keep')
    // a query the page does not scroll to (an engine opened, a view): the top, not the last page's place
    for (const q of ['?engine=claude-code', '?view=people', '?drive=1']) expect(scrollOnShow('PUSH', '', q)).toBe('top')
    expect(scrollOnShow('REPLACE', '', '')).toBe('keep')
  })
})

describe('the phone list\'s values and badges', () => {
  const state = <T,>(data: T | null, error: string | null = null) => ({ data, error, reload: async () => {} })
  const o = {
    users: state({ items: [] }), engines: state({ engines: [] }), services: state([{ id: 's' }, { id: 't' }]), plugins: state([]),
    usage: state({ totals: { costUsd: 0.47 } }), audit: state([{ at: new Date().toISOString() }]), active: [{}, {}, {}], defaultEngine: 'Claude Code',
  } as never
  test('what Home says first; nothing for none or for a page Home reads nothing for', () => {
    expect(rowValue('members', o, 'en')).toBe('3')
    expect(rowValue('providers', o, 'en')).toBe('Claude Code')
    expect(rowValue('connectors', o, 'en')).toBe('2')
    expect(rowValue('plugins', o, 'en')).toBeNull()
    expect(rowValue('usage', o, 'en')).toContain('0.47')
    expect(rowValue('audit', o, 'en')).toBeTruthy()
    for (const id of ['groups', 'folders', 'ai-apps', 'slack', 'settings', 'system']) expect(rowValue(id, o, 'en')).toBeNull()
  })
  test('a source that failed: "failed" (shown as "—", read out as Unavailable); still loading: nothing', () => {
    expect(rowValue('members', { ...(o as object), users: state(null, 'boom') } as never, 'en')).toBe('failed')
    expect(rowValue('members', { ...(o as object), users: state(null) } as never, 'en')).toBeNull()
  })
  test('a badge counts the attention rows that open that page, by its path', () => {
    expect(sectionOf('/admin/providers?engine=claude-code')).toBe('providers')
    expect(sectionOf('/admin/settings#ai-limits')).toBe('settings')
    expect(sectionOf('/admin')).toBe('')
    expect(sectionOf('/skills')).toBeNull()
    const rows = [{ to: '/admin/providers' }, { to: '/admin/providers?engine=claude-code' }, { to: '/admin/system' }, { to: '/skills' }]
    expect(fixCount(rows, 'providers')).toBe(2)
    expect(fixCount(rows, 'system')).toBe(1)
    expect(fixCount(rows, 'connectors')).toBe(0)
  })
})

describe('the hook in the app', () => {
  let seen: { path: string; type: string; state: unknown; key: string }[] = []
  function Note() {
    const l = useLocation()
    const nav = useNavigationType()
    noteLocation(l, nav)
    return null
  }
  function Page({ phone, final }: { phone: boolean; final: boolean }) {
    const l = useLocation()
    seen.push({ path: l.pathname + l.search + l.hash, type: useNavigationType(), state: l.state, key: l.key })
    useListUnderPage('/admin', phone, final)
    const label = useBackLabel('/admin', (p) => (p === '/admin' ? 'Admin' : p === '/settings/notifications' ? 'Inbox' : null))
    return <span data-testid="label">{label ?? '‹'}</span>
  }
  const app = (entries: InitialEntry[], o: { phone?: boolean; final?: boolean } = {}) => (
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Note />
      <Routes>
        <Route path="/admin/:section" element={<Page phone={o.phone ?? true} final={o.final ?? true} />} />
        <Route path="*" element={<Link to="/admin/members?member=bob#x" data-testid="go">go</Link>} />
      </Routes>
    </MemoryRouter>
  )
  const last = () => seen.at(-1)!
  // a plain left click, as React Router's Link wants it
  const press = async (el: FakeElement) => {
    const ev = new FakeEvent('click', { bubbles: true, cancelable: true })
    Object.assign(ev, { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })
    await act(async () => void el.dispatchEvent(ev))
  }

  test('a page pushed from outside gets the list under it, keeping its query and hash; ‹ then names the list', async () => {
    seen = []
    historyAt(2)
    const m = await mount(app(['/settings/notifications']))
    try {
      await press(m.get('go'))
      await m.until(() => seen.length > 0 && last().type === 'PUSH' && (last().state as Record<string, unknown> | null)?.[BELOW] === '/admin', 'the page again, over the list')
      expect(last().path).toBe('/admin/members?member=bob#x')
      expect(m.get('label').textContent).toBe('Admin')
    } finally {
      await m.unmount()
    }
  })

  test('not on a computer, not before the page is final (a redirect, a member, still loading)', async () => {
    for (const o of [{ phone: false }, { final: false }]) {
      seen = []
      resetTrail()
      historyAt(2)
      const m = await mount(app(['/settings/notifications'], o))
      try {
        await press(m.get('go'))
        await m.settle(30)
        expect(seen.filter((s) => s.path.startsWith('/admin')).every((s) => s.type === 'PUSH' && !s.state)).toBe(true)
        // nothing put under it: ‹ names where Back really goes, the Inbox
        expect(m.get('label').textContent).toBe('Inbox')
      } finally {
        await m.unmount()
      }
    }
  })

  test('a resize to a phone on the same entry never rebuilds (only how the entry first showed counts)', async () => {
    seen = []
    historyAt(2)
    function Flip() {
      const [phone, setPhone] = useState(false)
      return (
        <MemoryRouter initialEntries={['/c/1']}>
          <Note />
          <button type="button" data-testid="flip" onClick={() => setPhone(true)}>flip</button>
          <Routes>
            <Route path="/admin/:section" element={<Page phone={phone} final />} />
            <Route path="*" element={<Link to="/admin/members" data-testid="go">go</Link>} />
          </Routes>
        </MemoryRouter>
      )
    }
    const m = await mount(<Flip />)
    try {
      await press(m.get('go'))
      await m.until(() => seen.length > 0, 'the page')
      await m.click('flip')
      await m.settle(30)
      expect(seen.every((s) => !s.state)).toBe(true)
      expect(seen.at(-1)!.type).toBe('PUSH')
    } finally {
      await m.unmount()
    }
  })

  test('Back or a reload onto a page (POP, not the first entry): nothing is rebuilt', async () => {
    seen = []
    historyAt(4)
    const m = await mount(app(['/', '/admin/members']))
    try {
      await m.settle(30)
      expect(seen.every((s) => s.type === 'POP')).toBe(true)
      expect(m.get('label').textContent).toBe('‹')
    } finally {
      await m.unmount()
    }
  })

  test('several lists (a group of Team settings): both go under the page, outermost first; ‹ names the nearer one', async () => {
    seen = []
    historyAt(2)
    const entries: { path: string; state: unknown }[] = []
    function Group() {
      const l = useLocation()
      entries.push({ path: l.pathname + l.hash, state: l.state })
      useListUnderPage(['/admin', '/admin/settings'], true, true)
      const label = useBackLabel('/admin/settings', (p) => (p === '/admin/settings' ? 'Team settings' : null))
      return <span data-testid="label">{label ?? '‹'}</span>
    }
    const m = await mount(
      <MemoryRouter initialEntries={['/settings/notifications']}>
        <Note />
        <Routes>
          <Route path="/admin/:section/:sub" element={<Group />} />
          <Route path="*" element={<Link to="/admin/settings/limits#ai-limits" data-testid="go">go</Link>} />
        </Routes>
      </MemoryRouter>,
    )
    try {
      await press(m.get('go'))
      await m.until(() => (entries.at(-1)?.state as Record<string, unknown> | null)?.[BELOW] === '/admin/settings', 'the group over both lists')
      expect(entries.at(-1)!.path).toBe('/admin/settings/limits#ai-limits')
      expect(m.get('label').textContent).toBe('Team settings')
    } finally {
      await m.unmount()
    }
  })

  test('the first entry of the document (a pasted address, the app opened on a push): rebuilt', async () => {
    seen = []
    historyAt(0)
    const m = await mount(app(['/admin/members']))
    try {
      await m.until(() => seen.length > 0 && (last().state as Record<string, unknown> | null)?.[BELOW] === '/admin', 'the page over the list')
      expect(last().type).toBe('PUSH')
    } finally {
      await m.unmount()
    }
  })
})
