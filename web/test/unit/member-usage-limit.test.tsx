// A person's usage limit from Admin › Members (pages/admin/Members.tsx, pages/admin/BudgetForm.tsx; QA TC-2507..2511):
// "Usage limit…" in every member's "…" opens the shared limit dialog for that person, filled with the limit they have
// for the period (edit) or a new one (create); the Period switches between their day and month limits; Remove limit
// deletes the one shown. Their row says the limit in one quiet line, and "Over limit" once it is used up. A second limit
// for the same subject and period is refused by the server (409 budget_duplicate) and said in a plain line, by name.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { uuidv7, type Budget, type Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { resetAdminReads } from '../../src/store/adminPeople'
import { useUi } from '../../src/store/ui'
import { BudgetForm } from '../../src/pages/admin/BudgetForm'
import Members from '../../src/pages/admin/Members'
import TeamAiSettings from '../../src/pages/admin/TeamAiSettings'
import { FakeElement, FakeEvent, installDom, mount, removeDom, type Mounted } from './dom-host'

setDefaultTimeout(30_000)
// a limit's id is a UUIDv7 on the wire, a person's like a username (the API client checks the answers)
const ID = { owner: 'owner', ben: 'ben', cy: 'cy', m1: uuidv7(), d1: uuidv7(), t1: uuidv7(), new: uuidv7() }
const me = { user: { id: ID.owner, username: 'owner', name: 'Olivia', email: null, role: 'owner', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'en' }, session: { id: uuidv7(), client: 'web', expiresAt: '2030-01-01T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'UTC' } } as unknown as Me
const person = (username: keyof typeof ID, name: string, role = 'member') => ({ id: ID[username], username, name, email: null, role, status: 'active', groupIds: [], mustChangePassword: false, lastSeenAt: '2026-11-14T10:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z', locale: 'en', localeChoice: null })
const budget = (over: Partial<Budget>): Budget => ({ id: ID.m1, subjectType: 'user', subjectId: ID.ben, period: 'month', limitUsd: 0, limitTokens: 500_000, action: 'block', usedUsd: 0, usedTokens: 120_000, ...over })

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
let budgets: Budget[] = []
// the server already has a limit for this subject and period (server/src/admin/budgets.ts checkNoDuplicate)
let duplicate = false
const sent: { key: string; body: unknown }[] = []
const g = globalThis as Record<string, unknown>
const resizeBefore = Object.getOwnPropertyDescriptor(g, 'ResizeObserver')
beforeAll(() => {
  installDom()
  // the admin page header measures itself (pages/admin/common.tsx)
  Object.defineProperty(g, 'ResizeObserver', { configurable: true, writable: true, value: class { observe() {} unobserve() {} disconnect() {} } })
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (key !== 'GET /api/admin/budgets') sent.push({ key, body })
    if (key === 'GET /api/admin/budgets') return json({ items: budgets })
    if (key === 'POST /api/admin/budgets' && duplicate) return json({ error: { code: 'conflict', message: 'This already has a usage limit for that period. Change that limit instead of adding another.', params: { reason: 'budget_duplicate' } } }, 409)
    if (key === 'POST /api/admin/budgets') return json(budget({ id: ID.new, ...body, usedTokens: 0 }), 201)
    if (key.startsWith('PATCH /api/admin/budgets/')) return json(budget({ id: key.split('/').pop(), ...body }))
    if (key.startsWith('DELETE /api/admin/budgets/')) return new Response(null, { status: 204 })
    if (key === 'GET /api/admin/users') return json({ items: [person('owner', 'Olivia', 'owner'), person('ben', 'Ben'), person('cy', 'Cy')], noAi: [], deletionRequested: [], deletionDue: {} })
    if (key === 'GET /api/admin/team-link') return json({ link: null })
    if (key.startsWith('GET ')) return json({ items: [] })
    return json({ error: { code: 'not_found', message: key } }, 404)
  }) as unknown as typeof fetch
})
const pages: Mounted[] = []
afterEach(async () => {
  for (const p of pages.splice(0)) await p.unmount()
  sent.length = 0
  budgets = []
  duplicate = false
  useUi.setState({ toasts: [] })
  useSession.setState({ status })
  resetAdminReads()
})
afterAll(() => {
  globalThis.fetch = realFetch
  if (resizeBefore) Object.defineProperty(g, 'ResizeObserver', resizeBefore)
  else delete g.ResizeObserver
  removeDom()
  useLocaleStore.setState({ locale })
})

const choose = async (el: FakeElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(FakeElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new FakeEvent('change', { bubbles: true }))
  })
}
/** a select's or an input's shown value */
const valueOf = (el: FakeElement) => el.tagName === 'SELECT'
  ? el.querySelectorAll('option').find((o) => (o as unknown as { selected?: boolean }).selected)?.getAttribute('value') ?? null
  : (el as unknown as { value: string }).value
const formFor = async (list: Budget[]) => {
  budgets = list
  let saved = 0
  const m = await mount(<MemoryRouter><BudgetForm person={{ id: ID.ben, name: 'Ben' }} budgets={list} onClose={() => {}} onSaved={() => { saved++ }} /></MemoryRouter>)
  pages.push(m)
  return { m, saved: () => saved }
}

test('no limit yet: the dialog names the person, has no "Applies to", and Save makes a new month limit for them', async () => {
  const { m, saved } = await formFor([budget({ subjectId: ID.cy })])
  expect(m.html()).toContain('Usage limit for Ben')
  expect(m.html()).not.toContain('Applies to')
  expect(m.get('budget-form').getAttribute('data-editing')).toBeNull()
  expect(valueOf(m.get('budget-period'))).toBe('month')
  expect(m.find('budget-remove')).toBeNull()
  await m.click('budget-save')
  await m.until(() => saved() === 1, 'the save')
  expect(sent).toEqual([{ key: 'POST /api/admin/budgets', body: { subjectType: 'user', subjectId: ID.ben, period: 'month', limitTokens: 1_000_000, limitUsd: 0, action: 'warn' } }])
})

test('a limit they have: filled in, saved into that limit, with what is used of it and Remove limit', async () => {
  const { m, saved } = await formFor([budget({ id: ID.m1, limitUsd: 20, action: 'block' })])
  expect(m.get('budget-form').getAttribute('data-editing')).toBe(ID.m1)
  expect(valueOf(m.get('budget-tokens'))).toBe('500000')
  expect(valueOf(m.get('budget-usd'))).toBe('20')
  expect(valueOf(m.get('budget-action'))).toBe('block')
  expect(m.get('budget-used').textContent).toBe('120,000 of 500,000 tokens this month')
  await m.type('budget-tokens', '800000')
  await m.click('budget-save')
  await m.until(() => saved() === 1, 'the save')
  expect(sent).toEqual([{ key: `PATCH /api/admin/budgets/${ID.m1}`, body: { subjectType: 'user', subjectId: ID.ben, period: 'month', limitTokens: 800_000, limitUsd: 20, action: 'block' } }])
  sent.length = 0
  await m.click('budget-remove')
  await m.until(() => saved() === 2, 'the remove')
  expect(sent.map((s) => s.key)).toEqual([`DELETE /api/admin/budgets/${ID.m1}`])
})

test('a day and a month limit: opens on the month one; Per day shows and saves the day one; neither is hidden', async () => {
  const { m, saved } = await formFor([budget({ id: ID.d1, period: 'day', limitTokens: 50_000, action: 'warn', usedTokens: 60_000 }), budget({ id: ID.m1 })])
  expect(m.get('budget-form').getAttribute('data-editing')).toBe(ID.m1)
  await choose(m.get('budget-period'), 'day')
  expect(m.get('budget-form').getAttribute('data-editing')).toBe(ID.d1)
  expect(valueOf(m.get('budget-tokens'))).toBe('50000')
  expect(valueOf(m.get('budget-action'))).toBe('warn')
  expect(m.get('budget-used').textContent).toBe('60,000 of 50,000 tokens today')
  await m.click('budget-save')
  await m.until(() => saved() === 1, 'the save')
  expect(sent[0]!.key).toBe(`PATCH /api/admin/budgets/${ID.d1}`)
})

const membersPage = async () => {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(<MemoryRouter initialEntries={['/admin/members']}><Routes><Route path="/admin/members" element={<Members />} /></Routes></MemoryRouter>)
  pages.push(m)
  await m.until(() => m.find('members-table'), 'the members')
  return m
}
const menuOf = async (m: Mounted, name: string) => {
  const row = m.container.querySelectorAll('tr').find((r) => r.textContent?.includes(name) && r.querySelector('[data-testid="member-more"]'))
  if (!row) throw new Error(`no row for ${name}: ${m.html()}`)
  await m.click(row.querySelector('[data-testid="member-more"]')!)
}

test('Members: a limit is one quiet line under the name, "Over limit" once used up; nothing for people without one', async () => {
  budgets = [budget({ id: ID.m1, usedTokens: 600_000 }), budget({ id: ID.t1, subjectType: 'team', subjectId: null })]
  const m = await membersPage()
  await m.until(() => m.find('member-limit-ben'), 'the limit line')
  expect(m.get('member-limit-ben').textContent).toBe('500,000 tokens a month · Over limit')
  expect(m.find('member-over-limit-ben')).toBeTruthy()
  // the team's limit is not shown on anyone
  expect(m.find('member-limit-cy')).toBeNull()
  expect(m.find('member-limit-owner')).toBeNull()
})

test('Members: "Usage limit…" in the row\'s "…" opens the dialog for that person, filled with their limit', async () => {
  budgets = [budget({ id: ID.m1 })]
  const m = await membersPage()
  await menuOf(m, 'Ben')
  await m.click('member-usage-limit-ben')
  await m.until(() => m.find('budget-form'), 'the dialog')
  expect(m.html()).toContain('Usage limit for Ben')
  expect(m.get('budget-form').getAttribute('data-editing')).toBe(ID.m1)
  expect(valueOf(m.get('budget-tokens'))).toBe('500000')
  await m.type('budget-tokens', '700000')
  await m.click('budget-save')
  await m.until(() => !m.find('budget-form'), 'the dialog to close')
  expect(sent.filter((s) => s.key.includes('budgets'))).toEqual([{ key: `PATCH /api/admin/budgets/${ID.m1}`, body: { subjectType: 'user', subjectId: ID.ben, period: 'month', limitTokens: 700_000, limitUsd: 0, action: 'block' } }])
})

test('Members: the owner\'s own row has it too (the owner and the admins set anyone\'s limit); no limit opens a new one', async () => {
  const m = await membersPage()
  await menuOf(m, 'Olivia')
  await m.click('member-usage-limit-owner')
  await m.until(() => m.find('budget-form'), 'the dialog')
  expect(m.html()).toContain('Usage limit for Olivia')
  expect(m.get('budget-form').getAttribute('data-editing')).toBeNull()
})

test('an emptied token field is no token limit: Save waits for an amount; a dollars-only limit keeps no token number', async () => {
  const { m, saved } = await formFor([])
  await m.type('budget-tokens', '')
  expect(m.get('budget-save').hasAttribute('disabled')).toBe(true)
  await m.type('budget-usd', '20')
  expect(m.get('budget-save').hasAttribute('disabled')).toBe(false)
  await m.click('budget-save')
  await m.until(() => saved() === 1, 'the save')
  expect(sent[0]!.body).toEqual({ subjectType: 'user', subjectId: ID.ben, period: 'month', limitTokens: null, limitUsd: 20, action: 'warn' })
})

test('Team settings › Usage limits still makes any limit: Add limit sends the whole team by default', async () => {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(<MemoryRouter><TeamAiSettings part="limits" /></MemoryRouter>)
  pages.push(m)
  await m.until(() => m.find('budget-new'), 'Add limit')
  await m.click('budget-new')
  await m.until(() => m.find('budget-form'), 'the dialog')
  expect(m.html()).toContain('Applies to')
  expect(m.find('budget-remove')).toBeNull()
  expect(valueOf(m.get('budget-period'))).toBe('day')
  await m.click('budget-save')
  await m.until(() => !m.find('budget-form'), 'the dialog to close')
  expect(sent.filter((x) => x.key.includes('budgets'))).toEqual([{ key: 'POST /api/admin/budgets', body: { subjectType: 'team', subjectId: null, period: 'day', limitTokens: 1_000_000, limitUsd: 0, action: 'warn' } }])
})

test('Members: the dialog reads the limits again as it opens, so a limit made a moment ago is edited, not made twice', async () => {
  const m = await membersPage()
  await m.settle(50)
  // made elsewhere after this page read the list (Team settings, another admin)
  budgets = [budget({ id: ID.m1 })]
  await menuOf(m, 'Ben')
  await m.click('member-usage-limit-ben')
  await m.until(() => m.find('budget-form'), 'the dialog')
  expect(m.get('budget-form').getAttribute('data-editing')).toBe(ID.m1)
})

const errorToasts = () => useUi.getState().toasts.filter((x) => x.level === 'error').map((x) => x.text)

test('a second limit for the same person and period: the server refuses it, the dialog says so by name and stays open', async () => {
  duplicate = true
  // the list in hand missed the limit made a moment ago, so the dialog offers a new one
  const { m, saved } = await formFor([])
  await m.click('budget-save')
  await m.until(() => errorToasts().length === 1, 'the error line')
  expect(errorToasts()).toEqual(['Ben already has a usage limit for this period. Close this and open it again to change that one.'])
  expect(saved()).toBe(0)
  expect(m.find('budget-form')).toBeTruthy()
})

test('Team settings: a second limit for the whole team is said in a plain line, and the dialog stays open', async () => {
  duplicate = true
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const m = await mount(<MemoryRouter><TeamAiSettings part="limits" /></MemoryRouter>)
  pages.push(m)
  await m.until(() => m.find('budget-new'), 'Add limit')
  await m.click('budget-new')
  await m.until(() => m.find('budget-form'), 'the dialog')
  await m.click('budget-save')
  await m.until(() => errorToasts().length === 1, 'the error line')
  expect(errorToasts()).toEqual(['The whole team already has a usage limit for this period. Edit that one in the list instead.'])
  expect(m.find('budget-form')).toBeTruthy()
})
