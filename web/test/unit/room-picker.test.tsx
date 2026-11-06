// The new-chat picker (components/rooms/PeoplePicker.tsx, docs/DECISIONS.md "그룹 대화와 방 이름"): tick people (a group
// ticks its people now); one person opens the DM, two or more make a group chat with an optional name that shows only
// then; inviting leaves out the people already in the chat. What it sends is checked against a fake server.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { PeoplePicker } from '../../src/components/rooms/PeoplePicker'
import { usePeople } from '../../src/store/people'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { act } from 'react'
import { FakeElement, FakeEvent, installDom, mount, removeDom } from './dom-host'
import { BEN, CY, ME, room } from './rooms-fixtures'

const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const GROUP = { id: uuidv7(), name: '디자인팀' }
const LONG = { id: 'long', name: '아주아주긴이름을가진디자인팀의팀장님' }
const team = room({ kind: 'team', groupId: GROUP.id, name: GROUP.name })
const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [GROUP],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false } } as unknown as Me

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const sent: { key: string; body: unknown }[] = []
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    sent.push({ key, body })
    if (key === `GET /api/rooms/${team.id}/members`) return json({ items: [ME, BEN, CY].map((user) => ({ user, joinedAt: '2026-11-05T00:00:00.000Z' })) })
    if (key === 'POST /api/rooms') return json(room({ kind: body.kind, name: body.name ?? null, peers: [BEN] }), 201)
    if (key.startsWith('POST /api/rooms/') && key.endsWith('/members')) return json(room({ kind: 'group' }))
    return json({ error: { code: 'not_found', message: key } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  sent.length = 0
  useRooms.getState().reset()
  usePeople.setState({ people: null, byId: {}, loaded: false, failed: false })
  useSession.setState({ status })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale })
})

async function open(mode?: Parameters<typeof PeoplePicker>[0]['mode']) {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const people = [ME, BEN, CY, LONG]
  usePeople.setState({ people, byId: Object.fromEntries(people.map((p) => [p.id, p])), loaded: true, failed: false })
  useRooms.setState({ rooms: [team], loaded: true })
  const m = await mount(<MemoryRouter><PeoplePicker open onClose={() => {}} mode={mode} /></MemoryRouter>)
  await m.until(() => m.find('picker-groups'), 'the groups section')
  const rowOf = (testid: string, text: string) => m.container.ownerDocument!.body.querySelectorAll(`[data-testid="${testid}"]`).find((r) => (r.textContent ?? '').includes(text))!
  // a click on a checkbox turns it over before its handlers run (the browser's own step, which the fake DOM leaves out)
  const tick = async (testid: string, text: string) => {
    const box = rowOf(testid, text).querySelector('[data-testid="picker-tick"]')!
    const checked = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'checked')!
    await act(async () => {
      checked.set!.call(box, !checked.get!.call(box))
      box.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true }))
    })
  }
  return { m, tick, rowOf }
}

test('one person ticked opens our DM; the name field shows only with two or more', async () => {
  const { m, tick } = await open()
  try {
    expect(m.get('picker-go').hasAttribute('disabled')).toBe(true)
    await tick('people-row', 'Ben')
    expect(m.get('picker-go').textContent).toBe(ko('rooms.picker.start'))
    expect(m.find('picker-name')).toBeNull()
    expect(m.get('picker-count').textContent).toBe(ko('rooms.picker.selected', { n: 1 }))
    await m.click('picker-go')
    await m.until(() => sent.find((s) => s.key === 'POST /api/rooms'), 'the request')
    expect(sent.find((s) => s.key === 'POST /api/rooms')!.body).toEqual({ kind: 'dm', userId: BEN.id })
  } finally {
    await m.unmount()
  }
})

test('a group ticks its people at once (me left out); two or more make a group chat with the name typed', async () => {
  const { m, tick, rowOf } = await open()
  try {
    // the group lists its people that can be picked (me not counted)
    expect(rowOf('picker-group', GROUP.name).textContent).toContain(ko('rooms.picker.groupCount', { n: 2 }))
    // I am never in the list
    expect(m.container.ownerDocument!.body.querySelectorAll('[data-testid="people-row"]').map((r) => r.textContent)).not.toContain(ME.name)
    await tick('picker-group', GROUP.name)
    expect(m.get('picker-count').textContent).toBe(ko('rooms.picker.selected', { n: 2 }))
    expect(m.get('picker-go').textContent).toBe(ko('rooms.picker.createGroup'))
    await m.type('picker-name', '  주간 회의 ')
    await tick('people-row', LONG.name)
    await m.click('picker-go')
    await m.until(() => sent.find((s) => s.key === 'POST /api/rooms'), 'the request')
    expect(sent.find((s) => s.key === 'POST /api/rooms')!.body).toEqual({ kind: 'group', userIds: [BEN.id, CY.id, LONG.id], name: '주간 회의' })
  } finally {
    await m.unmount()
  }
})

test('a group ticked again unticks its people; a DM\'s invite starts with the other person ticked', async () => {
  const { m, tick } = await open({ kind: 'new', preselect: [BEN.id] })
  try {
    expect(m.get('picker-count').textContent).toBe(ko('rooms.picker.selected', { n: 1 }))
    await tick('picker-group', GROUP.name)
    expect(m.get('picker-count').textContent).toBe(ko('rooms.picker.selected', { n: 2 }))
    await tick('picker-group', GROUP.name)
    expect(m.get('picker-count').textContent).toBe('')
  } finally {
    await m.unmount()
  }
})

test('inviting into a group chat leaves out the people already in it', async () => {
  const chat = room({ kind: 'group', name: null, memberCount: 2, peers: [BEN] })
  useRooms.setState({ members: { [chat.id]: [ME, BEN].map((user) => ({ user, joinedAt: '2026-11-05T00:00:00.000Z' })) } })
  const { m, tick } = await open({ kind: 'invite', roomId: chat.id })
  try {
    const names = m.container.ownerDocument!.body.querySelectorAll('[data-testid="people-row"]').map((r) => r.textContent ?? '')
    expect(names.some((n) => n.includes('Ben'))).toBe(false)
    expect(names.some((n) => n.includes('Cy Park'))).toBe(true)
    expect(m.find('picker-name')).toBeNull()
    await tick('people-row', 'Cy Park')
    expect(m.get('picker-go').textContent).toBe(ko('rooms.picker.invite'))
    await m.click('picker-go')
    await m.until(() => sent.find((s) => s.key === `POST /api/rooms/${chat.id}/members`), 'the request')
    expect(sent.find((s) => s.key === `POST /api/rooms/${chat.id}/members`)!.body).toEqual({ userIds: [CY.id] })
  } finally {
    await m.unmount()
  }
})

test("a DM's 초대하기 whose other person is gone ticks nobody: no count, nothing to send", async () => {
  const { m } = await open({ kind: 'new', preselect: ['gone-person'] })
  try {
    expect(m.get('picker-count').textContent).toBe('')
    expect(m.get('picker-go').hasAttribute('disabled')).toBe(true)
  } finally {
    await m.unmount()
  }
})
