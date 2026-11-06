// The room's info (components/rooms/MembersDialog.tsx, docs/DECISIONS.md "그룹 대화와 방 이름"): the name row only for
// those who may rename, 초대하기 in group chats and DMs, the manager marked, "…" › 내보내기 only for the manager and owners
// or admins in it (never on their own row), and 대화방 나가기 only in a group chat.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7, type Me, type Room } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { MembersDialog } from '../../src/components/rooms/MembersDialog'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'
import { BEN, CY, ME, room } from './rooms-fixtures'

const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const meAs = (role: 'member' | 'admin') => ({ user: { id: ME.id, username: ME.id, name: ME.name, email: null, role, locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'en' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false } } as unknown as Me)
const members = [ME, BEN, CY].map((user) => ({ user, joinedAt: '2026-11-05T00:00:00.000Z' }))
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterEach(() => useSession.setState({ status }))
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

async function show(r: Room, role: 'member' | 'admin' = 'member') {
  useSession.setState({ status: { kind: 'signed-in', me: meAs(role) } } as never)
  return mount(<MemoryRouter><MembersDialog open onClose={() => {}} room={r} members={members} meId={ME.id} onInvite={() => {}} /></MemoryRouter>)
}
const menus = (m: Awaited<ReturnType<typeof show>>) => m.container.ownerDocument!.body.querySelectorAll('[data-testid="room-member-menu"]').length

test('a group chat I manage: my name row, invite, a menu on every row but mine, leave', async () => {
  const m = await show(room({ kind: 'group', name: null, canRename: true, managerId: ME.id, peers: [BEN, CY], memberCount: 3 }))
  try {
    expect(m.find('room-name')).toBeTruthy()
    expect(m.find('room-invite')).toBeTruthy()
    expect(m.find('room-leave')).toBeTruthy()
    expect(m.get('room-manager').textContent).toContain('Manager')
    expect(menus(m)).toBe(2)
  } finally { await m.unmount() }
})

test('a plain member of a group chat: no menus; an admin in it: menus on the others, the manager too', async () => {
  const r = room({ kind: 'group', name: 'Plan', canRename: true, managerId: BEN.id, peers: [BEN, CY], memberCount: 3 })
  let m = await show(r)
  try { expect(menus(m)).toBe(0) } finally { await m.unmount() }
  m = await show(r, 'admin')
  try { expect(menus(m)).toBe(2) } finally { await m.unmount() }
})

test('a team room for a member: no name row, no invite, no leave; a DM: invite only', async () => {
  let m = await show(room({ kind: 'team', canRename: false }))
  try {
    expect(m.find('room-name')).toBeNull()
    expect(m.find('room-invite')).toBeNull()
    expect(m.find('room-leave')).toBeNull()
    expect(menus(m)).toBe(0)
  } finally { await m.unmount() }
  m = await show(room({ kind: 'dm', name: null, canRename: false, peers: [BEN], memberCount: 2, groupId: null }))
  try {
    expect(m.find('room-name')).toBeNull()
    expect(m.find('room-invite')).toBeTruthy()
    expect(m.find('room-leave')).toBeNull()
  } finally { await m.unmount() }
})
