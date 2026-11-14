// The admin's "Who can open it" panel, mounted (web/src/pages/admin/FolderSharing.tsx; docs/DECISIONS.md "Who can open
// it, like Drive's Share"): a draft belongs to one folder; Save asks the server again for exactly that draft and, when
// it gives more access, asks the admin first; the save carries the hash it started from, and another admin's change is
// said and keeps the draft. The server here is a stub whose previews are the real server's computation (editPreview on
// a RuleSet of the stub's rows), so "more access" is what the permission function says.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act, useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { Folder } from '@mycel/shared/api'
import { type Access, type Principal } from '../../../server/src/policy/access'
import { editPreview, rulesHash } from '../../../server/src/admin/access-edit'
import FolderSharing from '../../src/pages/admin/FolderSharing'
import { DialogHost } from '../../src/components/ui'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { FakeElement, FakeEvent, installDom, mount, removeDom, type Mounted } from './dom-host'
import { ruleWorld } from '../../../tests/lib/rule-world'

const en = (key: MessageKey, p?: Params) => translate('en', key, p)
const SALES = '01900000-0000-7000-8000-0000000000c1'
const LEADS = '01900000-0000-7000-8000-0000000000c2'
const T0 = '2026-11-10T00:00:00.000Z'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const people: Principal[] = [
  { id: 'olga', name: 'Olga', role: 'owner', groups: [] },
  { id: 'alice', name: 'Alice', role: 'member', groups: [SALES] },
  { id: 'bob', name: 'Bob', role: 'member', groups: [SALES, LEADS] },
  { id: 'carol', name: 'Carol', role: 'member', groups: [LEADS] },
  { id: 'erin', name: 'Erin', role: 'member', groups: [] },
]
const user = (p: Principal) => ({ id: p.id, username: p.id, name: p.name, email: null, role: p.role, status: 'active', mustChangePassword: false, locale: 'en', localeChoice: null, groupIds: p.groups, createdAt: T0, lastSeenAt: null })
const groups = [{ id: SALES, name: 'Sales', description: null, memberIds: ['alice', 'bob'] }, { id: LEADS, name: 'Leads', description: null, memberIds: ['bob', 'carol'] }]
type R = { subjectType: 'everyone' | 'role' | 'group' | 'user'; subjectId: string | null; access: Access }

/** the stub server's rule rows by folder, and its folder ids */
let rows: Map<string, R[]>
const ids = new Map([['shared', '01900000-0000-7000-8000-0000000000f1'], ['shared/Sales', '01900000-0000-7000-8000-0000000000f2'], ['shared/Sales/Quotes', '01900000-0000-7000-8000-0000000000f3'], ['shared/Sales/Plans', '01900000-0000-7000-8000-0000000000f4'], ['shared/Sales/New', '01900000-0000-7000-8000-0000000000f5']])
/** the stub's limited folders (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)"): set by a save's `limited`;
 * a folder whose rows hold "everyone: none" counts as limited too (the form these tests were written in) */
let limitedPaths = new Set<string>()
/** rows the one-time conversion wrote (`Folder.rules[].byConversion`), as `<path>:<type>:<id>` */
let byConversion = new Set<string>()
const isLimited = (path: string) => limitedPaths.has(path) || (rows.get(path) ?? []).some((r) => r.subjectType === 'everyone' && r.access === 'none')
const ruleSet = () => ruleWorld([...rows].flatMap(([path, rs]) => rs.map((r) => ({ path, subject_type: r.subjectType, subject_id: r.subjectId, access: r.access }))), [...rows.keys()].filter(isLimited))
const folderOf = (path: string): Folder => ({
  id: ids.get(path)!, path, exists: true, createdAt: T0, groupId: null, keep: path === 'shared' ? 'team' : null, hidden: false,
  rules: (rows.get(path) ?? []).map((r, i) => ({ id: `01900000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}`, folderId: ids.get(path)!, ...r, updatedBy: null, updatedAt: T0, ...(byConversion.has(`${path}:${r.subjectType}:${r.subjectId}`) ? { byConversion: true } : {}) })),
  rulesHash: rulesHash(rows.get(path) ?? [], isLimited(path)),
  limited: isLimited(path),
})
const sent: { key: string; body: any }[] = []
let putReply: ((path: string, body: any) => Response) | null = null
let postReply: ((body: any) => Response) | null = null
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status

beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    const body = init?.body ? JSON.parse(String(init.body)) : null
    sent.push({ key, body })
    if (key === 'GET /api/admin/folders') return json(200, { items: [...rows.keys()].map(folderOf) })
    if (key === 'GET /api/admin/users') return json(200, { items: people.map(user) })
    if (key === 'GET /api/admin/groups') return json(200, { items: groups })
    if (key === 'GET /api/admin/access/folder') {
      // every person's access to a file in `path`, and for "no access" the nearest limited folder at or above it
      const at = new URL(url, 'http://x').searchParams.get('path') ?? ''
      const segs = at ? at.split('/') : []
      let cutAt: string | undefined
      for (let i = segs.length; i > 0; i--) if (isLimited(segs.slice(0, i).join('/'))) { cutAt = segs.slice(0, i).join('/'); break }
      const out = people.map((p) => {
        const access = ruleSet().access(p, [...segs, 'x.md'])
        const reason = p.role === 'owner' ? { kind: 'owner-admin' } : access === 'none' ? { kind: 'no-rule', ...(cutAt ? { cutAt } : {}) } : { kind: 'rule', folder: at, tier: 'everyone', rules: [] }
        return { user: { id: p.id, name: p.name }, role: p.role, access, reason, listable: false, via: [], viaMore: false }
      })
      return json(200, { path: at, exists: true, ruleFolder: null, people: out, total: out.length, nextCursor: null, summary: { access: { none: 0, read: 0, write: 0 }, sources: [] }, inactive: [] })
    }
    if (key === 'POST /api/admin/access/edit-preview') {
      const out = editPreview({ rules: ruleSet(), people, groupName: (id) => groups.find((g) => g.id === id)?.name ?? null, personName: (id) => people.find((p) => p.id === id)?.name ?? null }, body.path, body.rules, { team: body.path === 'shared' ? 'shared' : null, limited: body.limited })
      return json(200, { path: body.path, exists: true, connected: false, ...out })
    }
    if (key === 'POST /api/admin/folders') {
      if (postReply) return postReply(body)
      rows.set(body.path, body.rules)
      if (body.limited) limitedPaths.add(body.path)
      return json(201, folderOf(body.path))
    }
    const put = /^PUT \/api\/admin\/folders\/([^/]+)\/rules$/.exec(key)
    if (put) {
      const path = [...ids].find(([, id]) => id === put[1])![0]
      if (putReply) return putReply(path, body)
      rows.set(path, body.rules)
      if (body.limited === true) limitedPaths.add(path)
      if (body.limited === false) { limitedPaths.delete(path); rows.set(path, body.rules.filter((r: R) => !(r.subjectType === 'everyone' && r.access === 'none'))) }
      return json(200, folderOf(path))
    }
    return json(500, { error: { code: 'internal', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
beforeEach(() => {
  // Quotes: Sales can edit, Alice only views; on Sales, Leads can view and nobody else; Company-wide: everyone views
  limitedPaths = new Set()
  rows = new Map<string, R[]>([
    ['shared', [{ subjectType: 'everyone', subjectId: null, access: 'read' }]],
    ['shared/Sales', [{ subjectType: 'group', subjectId: LEADS, access: 'read' }, { subjectType: 'everyone', subjectId: null, access: 'none' }]],
    ['shared/Sales/Quotes', [{ subjectType: 'group', subjectId: SALES, access: 'write' }, { subjectType: 'user', subjectId: 'alice', access: 'read' }]],
    ['shared/Sales/Plans', [{ subjectType: 'user', subjectId: 'erin', access: 'write' }]],
  ])
  putReply = null
  postReply = null
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'olga', name: 'Olga', role: 'owner' }, groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
})
// a test that failed before its unmount leaves its panel mounted: it goes first, so it does not render again signed out
// (an error between tests that reads as the next test's)
const live = new Set<Mounted>()
afterEach(async () => {
  for (const m of live) await m.unmount()
  live.clear()
  sent.length = 0
  useSession.setState({ status: sessionBefore })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
})

let showPath: (p: string) => void = () => {}
function Host({ start }: { start: string }) {
  const [path, setPath] = useState(start)
  showPath = setPath
  const guard = { current: async () => true }
  const list = { current: { open: false, close: () => {} } }
  return (
    <MemoryRouter>
      <FolderSharing key={path} path={path} project={null} projectOf={() => null} onSwap={setPath} onLeave={() => {}} guard={guard} list={list} footer={null} />
      <DialogHost />
    </MemoryRouter>
  )
}
const mountHost = async (path: string) => {
  const m = await mount(<Host start={path} />)
  live.add(m)
  return m
}
/** the panel with the server's first answer in: the list is busy until then (the rows from the folders above come with
 * it). Before, the list was busy only while a later answer was on its way, so under load this went on without the
 * first one and the rows from above were not there yet */
const open = async (path = 'shared/Sales/Quotes') => {
  const m = await mountHost(path)
  await m.until(() => m.find('sharing-row') || m.find('sharing-empty'), 'the rows')
  await m.until(() => m.find('sharing-list')?.getAttribute('aria-busy') === null && calls('POST /api/admin/access/edit-preview').length > 0, 'the first answer')
  return m
}
/** a browser checks a box before the click's listeners run, past React's value tracker (this small DOM does not) */
const tick = async (m: Mounted, el: FakeElement) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'checked')!.set!.call(el, !(el as unknown as { checked: boolean }).checked)
  await m.click(el)
}
const choose = async (el: FakeElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(FakeElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new FakeEvent('change', { bubbles: true }))
  })
}
/** a select's chosen value, as React marks it on its options */
const valueOf = (sel: FakeElement) => sel.querySelectorAll('option').find((o) => (o as unknown as { selected?: boolean }).selected)?.getAttribute('value') ?? null
const rowsOf = (m: Mounted, id: string) => m.container.ownerDocument!.body.querySelectorAll(`[data-testid="${id}"]`)
const calls = (key: string) => sent.filter((x) => x.key === key)
const ready = (m: Mounted) => m.until(() => m.find('sharing-outcome'), 'what will happen')

describe('the panel shows who can open it, like Drive\'s list', () => {
  test('groups and people set here, the one set apart from their group, the folder above\'s people greyed', async () => {
    const m = await open()
    const rows = rowsOf(m, 'sharing-row')
    expect(rows.map((r) => r.getAttribute('data-subject'))).toEqual([`group:${SALES}`, 'user:alice'])
    // since P2 the wider of her two rules decides (access adds up): no "In Sales, but can only view here" line
    expect(rows[1]!.querySelector('[data-testid="sharing-row-from"]')).toBeNull()
    const above = rowsOf(m, 'sharing-above')
    expect(above.map((r) => r.getAttribute('data-subject'))).toEqual([`group:${LEADS}`])
    expect(above[0]!.textContent).toContain(en('folderAccess.fromFolder', { folder: 'Sales' }))
    expect(above[0]!.textContent).toContain(en('folderAccess.canView'))
    // general access: no setting here, so it shows what Sales gives (Restricted) and where it comes from; no "Same as"
    expect(valueOf(m.get('sharing-general-select'))).toBe('restricted')
    expect(m.find('sharing-general-role')).toBeNull()
    expect(m.get('sharing-general-hint').textContent).toContain(en('folderAccess.restrictedHint'))
    expect(m.get('sharing-general-inherited').textContent).toBe(en('folderAccess.fromFolder', { folder: 'Sales' }))
    // the owner and admins: a row of the list, not a footer sentence
    expect(m.get('sharing-staff').textContent).toContain(en('folderAccess.staffRow'))
    expect(m.get('sharing-staff').textContent).toContain(en('folderAccess.manager'))
    // Settings › Limit access: off here (Quotes is not limited)
    expect((m.get('sharing-limit') as unknown as { checked: boolean }).checked).toBe(false)
    // the role menu holds Remove access (Drive), no ✕
    expect(rowsOf(m, 'sharing-row')[0]!.querySelectorAll('option').map((o) => o.getAttribute('value'))).toEqual(['read', 'write', 'remove'])
    expect(m.find('sharing-remove')).toBeNull()
    // nothing changed: Done, no Save
    expect(m.find('sharing-done')).not.toBeNull()
    expect(m.find('sharing-save')).toBeNull()
    await m.unmount()
  })
})

describe('Drive\'s role menu and Access removed (P1)', () => {
  test('Remove access is in the role menu: the row goes, and what will happen names who loses it', async () => {
    const m = await open()
    await choose(rowsOf(m, 'sharing-row')[1]!.querySelector('select')!, 'remove')
    // asked first (a native menu's arrow keys would remove on the way); Cancel keeps the row
    const ask = await m.until(() => m.find('dialog-confirm'), 'the remove question')
    expect(m.html()).toContain(en('folderAccess.removeTitle', { name: 'Alice' }))
    await m.click((ask.parentNode as FakeElement).querySelectorAll('button')[0]!)
    await m.until(() => !m.find('dialog-confirm'), 'the question closed')
    expect(rowsOf(m, 'sharing-row')).toHaveLength(2)
    await choose(rowsOf(m, 'sharing-row')[1]!.querySelector('select')!, 'remove')
    await m.click(await m.until(() => m.find('dialog-confirm'), 'the remove question'))
    await m.until(() => rowsOf(m, 'sharing-row').length === 1, 'the row gone')
    expect(rowsOf(m, 'sharing-row').map((r) => r.getAttribute('data-subject'))).toEqual([`group:${SALES}`])
    await ready(m)
    // Alice is in Sales, which can edit here: access adds up, so she could edit already; taking her row out changes nobody
    expect(m.get('sharing-outcome').textContent).toContain(en('folderAccess.noChange'))
    await m.unmount()
  })

  test('a limited folder lists who it stops under Access removed, with Add (Google\'s word): back as Viewer, asked before Save', async () => {
    // Quotes limited: Carol, let in by Leads on Sales, cannot open it
    rows.set('shared/Sales/Quotes', [{ subjectType: 'group', subjectId: SALES, access: 'write' }])
    limitedPaths.add('shared/Sales/Quotes')
    const m = await open()
    expect((m.get('sharing-limit') as unknown as { checked: boolean }).checked).toBe(true)
    expect(rowsOf(m, 'sharing-row').map((r) => r.getAttribute('data-subject'))).toEqual([`group:${SALES}`])
    await m.until(() => m.find('sharing-removed'), 'Access removed')
    const removed = rowsOf(m, 'sharing-removed-row')
    expect(removed.map((r) => r.getAttribute('data-subject'))).toEqual(['user:carol'])
    expect(m.get('sharing-removed').textContent).toContain(en('folderAccess.accessRemoved'))
    await m.click('sharing-add-back')
    expect(m.find('sharing-removed')).toBeNull()
    const back = rowsOf(m, 'sharing-row').find((r) => r.getAttribute('data-subject') === 'user:carol')!
    expect(back.getAttribute('data-access')).toBe('read')
    await ready(m)
    expect(m.get('sharing-outcome').textContent).toContain('Carol will be able to open it')
    await m.click('sharing-save')
    const confirm = await m.until(() => m.find('dialog-confirm'), 'the confirm')
    expect(m.html()).toContain(en('folderAccess.confirmOpen', { n: 1 }))
    await m.click(confirm)
    const put = await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`)[0], 'the save')
    expect(put.body.rules).toContainEqual({ subjectType: 'user', subjectId: 'carol', access: 'read' })
    // the limit was not changed in the draft: not sent (the server keeps it)
    expect(put.body.limited).toBeUndefined()
    await m.unmount()
  })

  test('the team can edit the folder above: Viewer cannot be picked here, and the line offers Limit access', async () => {
    rows.set('shared/Sales/Quotes', [{ subjectType: 'everyone', subjectId: null, access: 'read' }])
    rows.set('shared/Sales', [{ subjectType: 'everyone', subjectId: null, access: 'write' }])
    const m = await mountHost('shared/Sales/Quotes')
    await m.until(() => m.find('sharing-general-role'), 'the team role')
    // access adds up: the team edits here too, whatever Quotes' own row says
    expect(valueOf(m.get('sharing-general-role'))).toBe('write')
    const viewer = m.get('sharing-general-role').querySelectorAll('option').find((o) => o.getAttribute('value') === 'read')!
    expect(viewer.hasAttribute('disabled')).toBe(true)
    expect(m.get('sharing-general-above').textContent).toContain(en('folderAccess.lowerNeedsLimit'))
    // the link turns the limit on: Viewer can be picked then
    await m.click('sharing-general-limit')
    expect((m.get('sharing-limit') as unknown as { checked: boolean }).checked).toBe(true)
    await m.until(() => !m.get('sharing-general-role').querySelectorAll('option').find((o) => o.getAttribute('value') === 'read')!.hasAttribute('disabled'), 'Viewer pickable')
    await m.unmount()
  })

  test('a limited folder may give the team less than the folder above: Viewer under Editor, no line', async () => {
    rows.set('shared/Sales/Quotes', [{ subjectType: 'user', subjectId: 'erin', access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'read' }])
    rows.set('shared/Sales', [{ subjectType: 'everyone', subjectId: null, access: 'write' }])
    limitedPaths.add('shared/Sales/Quotes')
    const m = await open()
    expect(valueOf(m.get('sharing-general-select'))).toBe('team')
    expect(valueOf(m.get('sharing-general-role'))).toBe('read')
    expect(m.find('sharing-general-above')).toBeNull()
    expect(m.find('sharing-save')).toBeNull()
    await m.unmount()
  })
})

describe('review of #779: the owner\'s row, and General access before the first answer', () => {
  test('Limit access that cuts off who the folder above lets in asks first, by name (re-review of #779)', async () => {
    const m = await open()
    // Quotes is not limited; Sales (above) lets Leads in: Carol. Turning the limit on stops her
    await tick(m, m.get('sharing-limit'))
    await ready(m)
    expect(m.get('sharing-outcome').textContent).toContain('Carol will no longer be able to open it')
    await m.click('sharing-save')
    const ask = await m.until(() => m.find('dialog-confirm'), 'the confirm')
    expect(m.html()).toContain(en('folderAccess.narrowTitle'))
    expect(m.get('sharing-confirm-body').textContent).toContain('Carol will no longer be able to open it')
    expect(ask.textContent).toBe(en('folderAccess.saveAnyway'))
    // Cancel: nothing saved
    await m.click((ask.parentNode as FakeElement).querySelectorAll('button')[0]!)
    await m.until(() => !m.find('dialog-confirm'), 'closed')
    expect(calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`)).toHaveLength(0)
    // Save anyway sends the limit
    await m.click('sharing-save')
    await m.click(await m.until(() => m.find('dialog-confirm'), 'the confirm'))
    const put = await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`)[0], 'the save')
    expect(put.body.limited).toBe(true)
    await m.unmount()
  })

  test('the owner listed here: Manager with Remove access only', async () => {
    rows.set('shared/Sales/Quotes', [{ subjectType: 'group', subjectId: SALES, access: 'write' }, { subjectType: 'user', subjectId: 'olga', access: 'read' }])
    const m = await open()
    const olga = rowsOf(m, 'sharing-row').find((r) => r.getAttribute('data-subject') === 'user:olga')!
    expect(olga.querySelectorAll('option').map((o) => o.getAttribute('value'))).toEqual(['staff', 'remove'])
    expect(olga.textContent).toContain(en('folderAccess.manager'))
    await m.unmount()
  })

  test('a row the folder conversion added says so ("Added when folders changed")', async () => {
    rows.set('shared/Sales/Quotes', [{ subjectType: 'group', subjectId: SALES, access: 'write' }, { subjectType: 'user', subjectId: 'erin', access: 'read' }])
    byConversion = new Set(['shared/Sales/Quotes:user:erin'])
    try {
      const m = await open()
      const erin = rowsOf(m, 'sharing-row').find((r) => r.getAttribute('data-subject') === 'user:erin')!
      expect(erin.textContent).toContain(en('folderAccess.byConversion'))
      expect(rowsOf(m, 'sharing-row').find((r) => r.getAttribute('data-subject') === `group:${SALES}`)!.textContent).not.toContain(en('folderAccess.byConversion'))
      await m.unmount()
    } finally {
      byConversion = new Set()
    }
  })

  test('General access waits for the first answer (what the folder above gives is not known before)', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((r) => { release = r })
    const before = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/admin/access/edit-preview')) await held
      return before(input, init)
    }) as typeof fetch
    try {
      const m = await mountHost('shared/Sales/Quotes')
      const sel = await m.until(() => m.find('sharing-general-select'), 'the select')
      expect(sel.hasAttribute('disabled')).toBe(true)
      // no value shown yet (not "Restricted"), no role, no line under it (re-review of #779)
      expect(valueOf(sel)).toBe('')
      expect(m.find('sharing-general-role')).toBeNull()
      expect(m.find('sharing-general-hint')).toBeNull()
      release()
      await m.until(() => !m.find('sharing-general-select')?.hasAttribute('disabled'), 'enabled after the answer')
      await m.unmount()
    } finally {
      globalThis.fetch = before
    }
  })
})

describe('review of #787: Limit access off, and shared/', () => {
  test('turning Limit access off raises rows lower than the folders above give (12-A at save time)', async () => {
    rows.set('shared/Sales', [{ subjectType: 'everyone', subjectId: null, access: 'write' }])
    rows.set('shared/Sales/Quotes', [{ subjectType: 'user', subjectId: 'erin', access: 'read' }, { subjectType: 'everyone', subjectId: null, access: 'read' }])
    limitedPaths.add('shared/Sales/Quotes')
    const m = await open()
    await tick(m, m.get('sharing-limit'))
    await m.until(() => rowsOf(m, 'sharing-row').find((r) => r.getAttribute('data-subject') === 'user:erin')?.getAttribute('data-access') === 'write', 'Erin raised to Editor')
    await ready(m)
    await m.click('sharing-save')
    await m.click(await m.until(() => m.find('dialog-confirm'), 'the confirm'))
    const put = await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`)[0], 'the save')
    expect(put.body.limited).toBe(false)
    // the team's Viewer row is gone (it follows Editor from above); Erin is stored as Editor
    expect(put.body.rules).toEqual([{ subjectType: 'user', subjectId: 'erin', access: 'write' }])
    await m.unmount()
  })

  test('Limit access off never raises a person through their group (re-review of #787)', async () => {
    // Sales can edit Sales; Quotes (limited) lists Alice, who is in Sales, as Viewer
    rows.set('shared/Sales', [{ subjectType: 'group', subjectId: SALES, access: 'write' }])
    rows.set('shared/Sales/Quotes', [{ subjectType: 'user', subjectId: 'alice', access: 'read' }])
    limitedPaths.add('shared/Sales/Quotes')
    const m = await open()
    await tick(m, m.get('sharing-limit'))
    await ready(m)
    expect(rowsOf(m, 'sharing-row').find((r) => r.getAttribute('data-subject') === 'user:alice')!.getAttribute('data-access')).toBe('read')
    await m.unmount()
  })

  test('shared/ limited with nobody added and nothing from the team root: the limit cannot be turned off into a refused save', async () => {
    rows.set('shared', [])
    limitedPaths.add('shared')
    const m = await mountHost('shared')
    await m.until(() => m.find('sharing-limit'), 'the switch')
    await m.until(() => !m.find('sharing-general-select')?.hasAttribute('disabled'), 'the first answer')
    // the switch says why it cannot go off, and is not offered
    expect(m.get('sharing-limit').hasAttribute('disabled')).toBe(true)
    expect(m.get('sharing-limit-locked').textContent).toBe(en('folderAccess.limitLocked'))
    expect((m.get('sharing-limit') as unknown as { checked: boolean }).checked).toBe(true)
    expect(m.find('sharing-save')).toBeNull()
    // a team role picked: the limit can go off again
    await choose(m.get('sharing-general-select'), 'team')
    await m.until(() => !m.get('sharing-limit').hasAttribute('disabled'), 'the switch free')
    expect(m.find('sharing-limit-locked')).toBeNull()
    await m.unmount()
  })

  test('shared/: Restricted is Limit access (shared/ keeps a setting of its own); Save is not stopped', async () => {
    const m = await mountHost('shared')
    await m.until(() => m.find('sharing-general-select') && !m.find('sharing-general-select')!.hasAttribute('disabled'), 'General access')
    await choose(m.get('sharing-general-select'), 'restricted')
    await m.until(() => (m.find('sharing-limit') as unknown as { checked?: boolean } | null)?.checked === true, 'the limit on')
    await ready(m)
    expect(m.find('sharing-keep-one')).toBeNull()
    await m.click('sharing-save')
    await m.click(await m.until(() => m.find('dialog-confirm'), 'the confirm'))
    const put = await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared')}/rules`)[0], 'the save')
    expect(put.body).toMatchObject({ rules: [], limited: true })
    await m.unmount()
  })
})

describe('a draft belongs to one folder', () => {
  test('another folder starts from its own rules; its save goes to its own id with its own hash', async () => {
    const m = await open()
    await choose(rowsOf(m, 'sharing-row')[0]!.querySelector('select')!, 'read')
    await ready(m)
    expect(m.find('sharing-save')).not.toBeNull()
    // "Change there" to another folder: a new draft, nothing of Quotes'
    await act(async () => showPath('shared/Sales/Plans'))
    // the new panel loads first (find, not get: nothing is there meanwhile)
    await m.until(() => m.find('sharing')?.getAttribute('data-path') === 'shared/Sales/Plans' && rowsOf(m, 'sharing-row').length === 1, 'Plans')
    expect(m.find('sharing-save')).toBeNull()
    expect(rowsOf(m, 'sharing-row').map((r) => r.getAttribute('data-subject'))).toEqual(['user:erin'])
    await choose(rowsOf(m, 'sharing-row')[0]!.querySelector('select')!, 'read')
    await ready(m)
    await m.click('sharing-save')
    await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Plans')}/rules`).length, 'the save')
    const put = calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Plans')}/rules`)[0]!.body
    expect(put).toEqual({ rules: [{ subjectType: 'user', subjectId: 'erin', access: 'read' }], expectedHash: rulesHash([{ subjectType: 'user', subjectId: 'erin', access: 'write' }]) })
    // nothing was saved on Quotes
    expect(calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`)).toHaveLength(0)
    await m.unmount()
  })
})

describe('Save asks the server again, and asks first before more access', () => {
  test('more access: the confirm names who; Cancel saves nothing and keeps the draft; Give access saves with the hash', async () => {
    const m = await open()
    const before = folderOfHash('shared/Sales/Quotes')
    await choose(m.get('sharing-general-select'), 'team')
    await ready(m)
    // Carol could already open it (Leads, from Sales); Erin could not
    expect(m.get('sharing-outcome').textContent).toContain('Erin will be able to open it')
    const asked = calls('POST /api/admin/access/edit-preview').length
    await m.click('sharing-save')
    const confirm = await m.until(() => m.find('dialog-confirm'), 'the confirm')
    // asked again at once for this draft before asking the admin
    expect(calls('POST /api/admin/access/edit-preview').length).toBe(asked + 1)
    expect(m.html()).toContain(en('folderAccess.confirmOpen', { n: 1 }))
    expect(confirm.textContent).toBe(en('folderAccess.giveAccess'))
    expect(calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`)).toHaveLength(0)
    // Cancel: nothing saved, the draft is still there
    // the dialog's other button (no test id of its own)
    await m.click((confirm.parentNode as FakeElement).querySelectorAll('button')[0]!)
    await m.until(() => !m.find('dialog-confirm'), 'the confirm closed')
    expect(calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`)).toHaveLength(0)
    // the draft is still there: what will happen, and Save
    expect(m.get('sharing-outcome').textContent).toContain('Erin will be able to open it')
    expect(m.find('sharing-save')).not.toBeNull()
    // again, and Give access: one more ask, then the save with the hash it started from
    await m.click('sharing-save')
    await m.click(await m.until(() => m.find('dialog-confirm'), 'the confirm'))
    await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`).length, 'the save')
    expect(calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`)[0]!.body.expectedHash).toBe(before)
    await m.unmount()
  })

  test('only less access: saved straight, no confirm, after "what will happen" named who', async () => {
    const m = await open()
    await choose(rowsOf(m, 'sharing-row')[0]!.querySelector('select')!, 'read')
    await ready(m)
    expect(m.get('sharing-outcome').textContent).toContain('Bob will no longer be able to edit it')
    await m.click('sharing-save')
    await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`).length, 'the save')
    expect(m.find('dialog-confirm')).toBeNull()
    await m.unmount()
  })

  test('another admin changed a folder above after the last answer: Save shows the new answer and needs another click', async () => {
    // (access adds up: Alice must not edit through Sales here, or giving her edit changes nothing)
    rows.set('shared/Sales/Quotes', [{ subjectType: 'user', subjectId: 'alice', access: 'read' }])
    const m = await open()
    await choose(rowsOf(m, 'sharing-row')[0]!.querySelector('select')!, 'write')
    await ready(m)
    // meanwhile Sales lets everyone view
    rows.set('shared/Sales', [{ subjectType: 'group', subjectId: LEADS, access: 'read' }, { subjectType: 'everyone', subjectId: null, access: 'read' }])
    await m.click('sharing-save')
    await m.until(() => m.find('sharing-changed-now'), 'the "changed just now" line')
    expect(m.find('dialog-confirm')).toBeNull()
    expect(calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`)).toHaveLength(0)
    // the next Save goes on from the answer now on screen (Alice view → edit still asks)
    await m.click('sharing-save')
    const confirm = await m.until(() => m.find('dialog-confirm'), 'the confirm')
    await m.click((confirm.parentNode as FakeElement).querySelectorAll('button')[0]!)
    await m.unmount()
  })

  test('another admin changed this folder: the save is refused (409), said, and the draft is kept', async () => {
    const m = await open()
    await choose(rowsOf(m, 'sharing-row')[0]!.querySelector('select')!, 'read')
    await ready(m)
    // another admin saved first: their rules are there, and this save is refused
    putReply = (path) => {
      rows.set(path, [{ subjectType: 'group', subjectId: SALES, access: 'write' }])
      return json(409, { error: { code: 'conflict', message: 'changed', params: { reason: 'rules_changed' } } })
    }
    await m.click('sharing-save')
    await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`).length, 'the refused save')
    expect(m.find('dialog-confirm')).toBeNull()
    await m.until(() => m.find('sharing-stale'), 'the "someone else changed this" note')
    expect(m.get('sharing-stale').textContent).toContain(en('folderAccess.staleKept'))
    // the draft is kept: Save is still there to save it over theirs
    expect(m.find('sharing-save')).not.toBeNull()
    await m.unmount()
  })
})

describe('after a save, and the other ways a save ends', () => {
  test('a save starts a new draft from the saved rules: no "someone else changed this", Done again', async () => {
    const m = await open()
    await choose(rowsOf(m, 'sharing-row')[0]!.querySelector('select')!, 'read')
    await ready(m)
    await m.click('sharing-save')
    await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`).length && m.find('sharing-done'), 'saved, and Done')
    await m.settle(400)
    expect(m.find('sharing-stale')).toBeNull()
    expect(m.find('sharing-save')).toBeNull()
    await m.unmount()
  })

  test('Cancel › Discard, then a new change: Save saves it (QA TC-287)', async () => {
    const m = await open()
    await choose(rowsOf(m, 'sharing-row')[0]!.querySelector('select')!, 'read')
    await ready(m)
    await m.click('sharing-cancel')
    await m.click(await m.until(() => m.find('dialog-confirm'), 'the discard question'))
    await m.until(() => m.find('sharing-done'), 'the changes dropped')
    // the draft is the saved rules again (Sales can edit)
    expect(rowsOf(m, 'sharing-row')[0]!.getAttribute('data-access')).toBe('write')
    // the panel is still open on Quotes: a new change saves
    await choose(rowsOf(m, 'sharing-row')[0]!.querySelector('select')!, 'read')
    await ready(m)
    await m.click('sharing-save')
    const put = await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`)[0], 'the save')
    expect(put.body.rules).toContainEqual({ subjectType: 'group', subjectId: SALES, access: 'read' })
    await m.until(() => m.find('sharing-done'), 'saved, and Done')
    await m.unmount()
  })

  test('Discard while a Save waits for its fresh answer: that Save stops, the next one saves', async () => {
    const m = await open()
    await choose(rowsOf(m, 'sharing-row')[0]!.querySelector('select')!, 'read')
    await ready(m)
    // Save's fresh ask (the first ask from here on) is held until the admin dropped the changes and the panel has the
    // answer for the saved rules again
    let release: () => void = () => {}
    const held = new Promise<void>((r) => { release = r })
    let first = true
    let answered = false
    const before = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('/api/admin/access/edit-preview') || !first) return before(input, init)
      first = false
      await held
      const r = await before(input, init)
      answered = true
      return r
    }) as typeof fetch
    try {
      await m.click('sharing-save')
      await m.click('sharing-cancel')
      await m.click(await m.until(() => m.find('dialog-confirm'), 'the discard question'))
      await m.until(() => !m.find('sharing-save') && m.find('sharing-done'), 'the changes dropped')
      await m.until(() => m.find('sharing-list')?.getAttribute('aria-busy') === null, 'the answer for the saved rules')
      release()
      // the dropped Save's fresh answer came last: that Save ended without writing, and its answer (for the dropped
      // changes) does not take the place of the one for the list on screen
      await m.until(() => answered, 'the fresh answer')
      await m.settle(50)
      expect(calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`)).toHaveLength(0)
      expect(m.get('sharing-list').getAttribute('aria-busy')).toBeNull()
    } finally {
      globalThis.fetch = before
    }
    await choose(rowsOf(m, 'sharing-row')[0]!.querySelector('select')!, 'read')
    await ready(m)
    await m.click('sharing-save')
    await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`).length, 'the save')
    await m.unmount()
  })

  test('Cancel pressed while Save waits for its answer, then kept: Save does not cover the question, and saves after', async () => {
    const m = await open()
    // more access: Save asks first
    await choose(m.get('sharing-general-select'), 'team')
    await ready(m)
    let release: () => void = () => {}
    const held = new Promise<void>((r) => { release = r })
    let answered = false
    const before = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('/api/admin/access/edit-preview')) return before(input, init)
      await held
      const r = await before(input, init)
      answered = true
      return r
    }) as typeof fetch
    try {
      await m.click('sharing-save')
      await m.click('sharing-cancel')
      await m.until(() => m.html().includes(en('folderAccess.discardTitle')), 'the discard question')
      release()
      await m.until(() => answered, 'the fresh answer')
      await m.settle()
      // still the discard question: Save's "Give access?" did not take its place
      expect(m.html()).toContain(en('folderAccess.discardTitle'))
      expect(m.html()).not.toContain(en('folderAccess.giveAccess'))
    } finally {
      globalThis.fetch = before
    }
    // keep the changes (the question's other button), then Save: the confirm, Give access, saved
    const discard = m.get('dialog-confirm')
    await m.click((discard.parentNode as FakeElement).querySelectorAll('button')[0]!)
    await m.until(() => !m.find('dialog-confirm'), 'the question closed')
    expect(m.find('sharing-save')).not.toBeNull()
    await m.click('sharing-save')
    const confirm = await m.until(() => m.find('dialog-confirm'), 'the confirm')
    expect(confirm.textContent).toBe(en('folderAccess.giveAccess'))
    await m.click(confirm)
    await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`).length, 'the save')
    await m.unmount()
  })

  test('Save pressed twice quickly: one save', async () => {
    const m = await open()
    await choose(rowsOf(m, 'sharing-row')[0]!.querySelector('select')!, 'read')
    await ready(m)
    const save = m.get('sharing-save')
    await act(async () => {
      save.click()
      save.click()
    })
    await m.until(() => m.find('sharing-done'), 'saved')
    expect(calls(`PUT /api/admin/folders/${ids.get('shared/Sales/Quotes')}/rules`)).toHaveLength(1)
    await m.unmount()
  })

  test('a folder without settings of its own, given some by another admin meanwhile: said once, then saved over with PUT', async () => {
    // on disk, no rule row: the folder list does not have it
    const m = await mountHost('shared/Sales/New')
    await m.until(() => m.find('sharing-above'), 'the panel and the rows from above')
    // General access: the team can view (more access: Save asks first)
    await choose(m.get('sharing-general-select'), 'team')
    await ready(m)
    // the other admin's row is made between this panel's answer and its save
    postReply = () => {
      rows.set('shared/Sales/New', [{ subjectType: 'user', subjectId: 'erin', access: 'read' }])
      return json(409, { error: { code: 'conflict', message: 'exists', params: { reason: 'folder_exists' } } })
    }
    await m.click('sharing-save')
    await m.click(await m.until(() => m.find('dialog-confirm'), 'the confirm'))
    await m.until(() => m.find('sharing-stale'), 'the "someone else changed this" note')
    expect(calls('POST /api/admin/folders')).toHaveLength(1)
    // the next Save goes over their row (PUT with their hash), never POST again
    await m.until(() => m.find('sharing-save')?.hasAttribute('disabled') === false, 'Save ready')
    await m.click('sharing-save')
    await m.click(await m.until(() => m.find('dialog-confirm'), 'the confirm'))
    const put = await m.until(() => calls(`PUT /api/admin/folders/${ids.get('shared/Sales/New')}/rules`)[0], 'the PUT')
    expect(put.body.expectedHash).toBe(rulesHash([{ subjectType: 'user', subjectId: 'erin', access: 'read' }]))
    expect(calls('POST /api/admin/folders')).toHaveLength(1)
    await m.unmount()
  })
})

function folderOfHash(path: string) {
  return rulesHash(rows.get(path) ?? [])
}
