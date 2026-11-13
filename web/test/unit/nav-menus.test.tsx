// The rail and the Trina panel, rendered and pressed (the layout itself is
// test/unit/rail-badges.test.tsx and the e2e suites):
// - the team menu on top of the rail (docs/DECISIONS.md "The team menu"): for owners and admins a button that opens the
//   team, its address, "팀원 초대" and 관리자, by mouse and by keyboard; a member's is not a button; 팀원 초대 opens the
//   invite dialog, or the owner's own invite step while the welcome steps are unfinished;
// - a chat row's "…" (nav/ChatItem.tsx, in the Trina panel's history): "상단에 고정" / "고정 해제" for every row, rename,
//   "프로젝트로 옮기기" ("프로젝트 바꾸기" in a project) and delete for a chat of my own, the move dialog of the chat's
//   title menu; a shared chat never offers the move;
// - pinned chats (docs/DECISIONS.md "Pinned chats"): first, the most recently pinned first, a pin before the title.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { type Chat, type Me, type WelcomeProgress } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { TeamInviteDialog, TeamMenu } from '../../src/components/TeamMenu'
import { HistoryList, useRecentsView } from '../../src/components/nav/HistoryList'
import { useChatPeek } from '../../src/components/nav/ChatItem'
import { INVITE_STEP_STATE } from '../../src/components/onboarding/GoalCard'
import { useUi } from '../../src/store/ui'
import { useAiAccess } from '../../src/store/aiAccess'
import { useChats } from '../../src/store/chats'
import { useInbox } from '../../src/store/inbox'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { FakeElement, FakeEvent, installDom, mount, removeDom } from './dom-host'
import { room } from './rooms-fixtures'
import { useProjects } from '../../src/store/projects'

const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)
const me = (role: 'owner' | 'admin' | 'member'): Me =>
  ({
    user: { id: 'mina', username: 'mina', name: '김민아님', title: null, email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
    groups: [], team: { name: '에이크미 마케팅본부', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
    server: { version: '0', dev: false, deployment: 'hosted' },
  }) as unknown as Me
const chat = (n: number, o: Partial<Chat> = {}): Chat => ({
  id: `01900000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`, projectId: null, title: `채팅 ${n}`, engine: 'claude-code', model: null,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: `2026-11-01T00:${String(n).padStart(2, '0')}:00.000Z`, deletedAt: null, runState: 'idle', ...o,
})
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

let wide = true
let inboxCount = 0
const calls: string[] = []
/** more answers by "METHOD path", for one test (the rest is a 404) */
let routes: Record<string, (init?: RequestInit) => Response> = {}
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
const roomsBefore = useRooms.getState()
const chatsBefore = { chats: useChats.getState().chats, chatsLoaded: useChats.getState().chatsLoaded, chatsCursor: useChats.getState().chatsCursor, requests: useChats.getState().requests }
const inboxBefore = useInbox.getState().unread
// the setup row (onboarding/SetupRow.tsx, on top of every list panel) reads these: put them back as they were
const welcomeBefore = (({ loaded, progress }) => ({ loaded, progress }))(useWelcome.getState())
const aiAccessBefore = (({ loaded, usable, action, requested, trial, sending, failed }) => ({ loaded, usable, action, requested, trial, sending, failed }))(useAiAccess.getState())
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  ;(globalThis as Record<string, unknown>).matchMedia = (q: string) => ({ matches: wide ? q === '(min-width: 768px)' : q === '(max-width: 767.98px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    if (key === 'GET /api/notifications') return json({ items: [], nextCursor: null, unreadCount: inboxCount })
    if (routes[key]) return routes[key](init)
    return json({ error: { code: 'not_found', message: key } }, 404)
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})
beforeEach(() => {
  wide = true
  calls.length = 0
  routes = {}
  localStorage.clear()
  // the projects this window saw (one list for every panel): none from the test before
  useProjects.getState().reset()
  useSession.setState({ status: { kind: 'signed-in', me: me('member') } } as never)
  useChats.setState({ chats: Array.from({ length: 8 }, (_, i) => chat(i + 1)), chatsLoaded: true, chatsCursor: null, requests: {} })
  useRooms.setState({ rooms: [room({ name: 'acme-design', unreadCount: 2 }), room({ kind: 'dm', name: null, unreadCount: 0 })], loaded: true, failed: null })
})
afterEach(() => {
  // reset first: it drops a read still on its way
  useWelcome.getState().reset()
  useWelcome.setState(welcomeBefore)
  useAiAccess.getState().reset()
  useAiAccess.setState(aiAccessBefore)
  useRooms.setState(roomsBefore, true)
  useChats.setState(chatsBefore)
  useInbox.setState({ unread: inboxBefore })
  inboxCount = 0
})


/** the rail's team menu and the Trina panel's history (its filter at the default) */
function History() {
  const view = useRecentsView()
  const peek = useChatPeek()
  return <HistoryList onNavigate={() => {}} peek={peek} viewState={view} />
}
const Nav = () => (
  <>
    <TeamMenu />
    <History />
  </>
)
const render = (path = '/') => mount(<MemoryRouter initialEntries={[path]}><Nav /></MemoryRouter>)

describe('the team menu on top', () => {
  const as = (role: 'owner' | 'admin' | 'member', address?: string) => {
    const m0 = me(role)
    useSession.setState({ status: { kind: 'signed-in', me: { ...m0, team: { ...m0.team, ...(address ? { address } : {}) } } } } as never)
  }
  const key = (el: FakeElement, k: string) => act(async () => { el.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: k })) })
  let path = ''
  const Where = () => { path = useLocation().pathname; return null }
  const renderWithDialog = () => mount(<MemoryRouter initialEntries={['/files']}><Nav /><TeamInviteDialog /><Where /></MemoryRouter>)

  test('a member: the team\'s logo and name, not a button (no menu)', async () => {
    as('member', 'https://acme.trina.app')
    const m = await render()
    try {
      expect(m.get('team-header').tagName).toBe('DIV')
      expect(m.get('sidebar-team').textContent).toBe('에이크미 마케팅본부')
      expect(m.get('sidebar-team').className).toContain('truncate')
      expect(m.find('team-menu')).toBeNull()
      expect(m.get('team-header').querySelector('button, a, svg')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  // UX review S6: switching teams is found under the logo, as in Slack; the app draws the list (the page never sees it)
  test('the desktop app: every role\'s menu ends with 다른 팀으로 전환, which opens the app\'s own teams menu (an older app: its team list)', async () => {
    const calls: string[] = []
    const g = globalThis as Record<string, unknown>
    try {
      for (const role of ['member', 'owner'] as const) {
        for (const withMenu of [true, false]) {
          g.mycelDesktop = { bridgeVersion: 1, appVersion: '0.4.0', platform: 'darwin', openTeams: () => calls.push(`${role}:openTeams`), ...(withMenu ? { teamMenu: () => calls.push(`${role}:teamMenu`) } : {}) }
          as(role)
          const m = await renderWithDialog()
          try {
            await m.click('team-menu')
            const items = m.get('team-dropdown').querySelectorAll('[role="menuitem"]')
            expect(items.map((x) => x.getAttribute('data-testid'))).toEqual(role === 'member' ? ['team-menu-switch'] : ['team-menu-invite', 'team-menu-admin', 'team-menu-switch'])
            expect(m.get('team-menu-switch').textContent?.trim()).toBe(ko('teamMenu.switch'))
            await m.click('team-menu-switch')
            expect(m.find('team-dropdown')).toBeNull()
          } finally {
            await m.unmount()
          }
        }
      }
      expect(calls).toEqual(['member:teamMenu', 'member:openTeams', 'owner:teamMenu', 'owner:openTeams'])
    } finally {
      delete g.mycelDesktop
    }
  })

  for (const role of ['owner', 'admin'] as const) {
    test(`${role}: a button opens the menu: the team with its address, then 팀원 초대 and 관리자, nothing personal`, async () => {
      as(role, 'https://acme.trina.app')
      const m = await renderWithDialog()
      try {
        const button = m.get('team-menu')
        expect(button.tagName).toBe('BUTTON')
        expect(button.getAttribute('aria-haspopup')).toBe('menu')
        expect(button.getAttribute('aria-expanded')).toBe('false')
        expect(button.textContent).toBe('에이크미 마케팅본부')
        expect(button.getAttribute('aria-label')).toBe('에이크미 마케팅본부')
        expect(m.find('team-dropdown')).toBeNull()
        await m.click(button)
        const menu = m.get('team-dropdown')
        expect(button.getAttribute('aria-expanded')).toBe('true')
        expect(menu.getAttribute('role')).toBe('menu')
        expect(menu.getAttribute('aria-label')).toBe('에이크미 마케팅본부')
        expect(m.get('team-menu-name').textContent).toBe('에이크미 마케팅본부')
        expect(m.get('team-menu-address').textContent).toBe('acme.trina.app')
        const items = menu.querySelectorAll('[role="menuitem"]')
        expect(items.map((x) => [x.getAttribute('data-testid'), x.textContent?.trim()])).toEqual([['team-menu-invite', ko('teamMenu.invite')], ['team-menu-admin', ko('sidebar.admin')]])
        expect(document.activeElement).toBe(items[0] as never)
        // the person's own things stay in the photo's menu at the rail's bottom
        for (const id of ['account-settings', 'logout', 'account-away', 'account-trash']) expect(menu.querySelector(`[data-testid="${id}"]`)).toBeNull()
        // 관리자 opens Admin and closes the menu
        await m.click('team-menu-admin')
        expect(path).toBe('/admin')
        expect(m.find('team-dropdown')).toBeNull()
      } finally {
        await m.unmount()
      }
    })
  }

  test('no team address known: the menu names the team only', async () => {
    as('owner')
    const m = await render()
    try {
      await m.click('team-menu')
      expect(m.get('team-menu-name').textContent).toBe('에이크미 마케팅본부')
      expect(m.find('team-menu-address')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  test('the keyboard: the first item has focus, arrows wrap, Home and End; Esc closes it only and gives the keyboard back', async () => {
    as('owner')
    const closed: boolean[] = []
    const onKey = (e: { key?: string }) => { if (e.key === 'Escape') closed.push(true) }
    window.addEventListener('keydown', onKey as never)
    const m = await render()
    try {
      const button = m.get('team-menu')
      await m.click(button)
      const [invite, admin] = [m.get('team-menu-invite'), m.get('team-menu-admin')]
      expect(document.activeElement).toBe(invite as never)
      await key(invite, 'ArrowDown')
      expect(document.activeElement).toBe(admin as never)
      await key(admin, 'ArrowDown')
      expect(document.activeElement).toBe(invite as never)
      await key(invite, 'ArrowUp')
      expect(document.activeElement).toBe(admin as never)
      await key(admin, 'Home')
      expect(document.activeElement).toBe(invite as never)
      await key(invite, 'End')
      expect(document.activeElement).toBe(admin as never)
      await key(admin, 'Escape')
      expect(m.find('team-dropdown')).toBeNull()
      expect(document.activeElement).toBe(button as never)
      expect(button.getAttribute('aria-expanded')).toBe('false')
      expect(closed).toEqual([])
      // Tab closes it too, and the keyboard moves on from the button as usual
      await m.click(button)
      await key(m.get('team-menu-invite'), 'Tab')
      expect(m.find('team-dropdown')).toBeNull()
    } finally {
      window.removeEventListener('keydown', onKey as never)
      await m.unmount()
    }
  })

  test('팀원 초대 opens the invite dialog (the team link\'s message), titled 팀원 초대; closing it gives the keyboard back to the team button', async () => {
    as('admin')
    const m = await renderWithDialog()
    try {
      await m.click('team-menu')
      await m.click('team-menu-invite')
      expect(m.find('team-dropdown')).toBeNull()
      await m.until(() => m.find('invite-step'), 'the invite step')
      const dialog = document.body.querySelector('[role="dialog"]')!
      expect(dialog.querySelector('h2')?.textContent).toBe(ko('teamMenu.invite'))
      // one heading: the dialog's own (InviteStep's title is left out)
      expect(dialog.querySelectorAll('h2').length).toBe(1)
      expect(path).toBe('/files')
      await m.click('invite-step-done')
      expect(m.find('invite-step')).toBeNull()
      expect(document.activeElement).toBe(m.get('team-menu') as never)
    } finally {
      await m.unmount()
    }
  })

  test('the invite dialog closes on a page change (a link in it, ⇧⌘O): it never stays over another page', async () => {
    as('owner')
    let go: ((to: string) => void) | null = null
    const Go = () => { const n = useNavigate(); go = n; return null }
    const m = await mount(<MemoryRouter initialEntries={['/files']}><Nav /><TeamInviteDialog /><Where /><Go /></MemoryRouter>)
    try {
      await m.click('team-menu')
      await m.click('team-menu-invite')
      await m.until(() => m.find('invite-step'), 'the invite step')
      await act(async () => go!('/skills'))
      expect(path).toBe('/skills')
      expect(m.find('invite-step')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  describe('while the owner\'s welcome steps are unfinished', () => {
    const unfinished = {
      startedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', teamType: 'marketing',
      steps: { profile: 'done', result: null, invite: null }, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
    } as unknown as WelcomeProgress
    let state: unknown = null
    const Here = () => { const l = useLocation(); path = l.pathname; state = l.state; return null }
    test('the owner: 팀원 초대 opens the steps\' own invite step, not a second invite dialog', async () => {
      as('owner')
      const m = await mount(<MemoryRouter initialEntries={['/files']}><Nav /><TeamInviteDialog /><Here /></MemoryRouter>)
      try {
        useWelcome.setState({ loaded: true, progress: unfinished })
        await m.click('team-menu')
        await m.click('team-menu-invite')
        expect(path).toBe('/welcome')
        expect(state).toEqual(INVITE_STEP_STATE)
        await m.settle(50)
        expect(m.find('invite-step')).toBeNull()
      } finally {
        await m.unmount()
      }
    })
    test('an admin who is not the owner: the invite dialog (the steps are the owner\'s; /welcome would send them Home)', async () => {
      as('admin')
      const m = await mount(<MemoryRouter initialEntries={['/files']}><Nav /><TeamInviteDialog /><Here /></MemoryRouter>)
      try {
        useWelcome.setState({ loaded: true, progress: unfinished })
        await m.click('team-menu')
        await m.click('team-menu-invite')
        await m.until(() => m.find('invite-step'), 'the invite dialog')
        expect(path).toBe('/files')
      } finally {
        await m.unmount()
      }
    })
  })
})


describe('a chat row\'s "…"', () => {
  const P = '01900000-0000-7000-8000-000000000301'
  const project = { id: P, name: 'Acme launch', folderPath: 'shared/acme-launch', instructions: '', createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', canEdit: true }
  const shared = (by: string, canDelete: boolean) => ({ by: { id: by, name: by === 'mina' ? '김민아님' : 'Bob' }, audience: 3, answering: null, mine: true, canDelete })
  /** the row of the chat with this title, its "…" opened: the items as [test id, words] (null: the row has no "…") */
  async function items(m: Awaited<ReturnType<typeof render>>, title: string) {
    const row = m.get('recents-list').querySelectorAll('li').find((li) => li.textContent?.includes(title))!
    const more = row.querySelector(`button[aria-label="${ko('chat.menu')}"]`)
    if (!more) return null
    await m.click(more)
    const out = row.querySelectorAll('[role="menuitem"]').map((e) => [e.getAttribute('data-testid'), e.textContent?.trim()])
    await m.click(more)
    return out
  }

  test('a chat of my own: pin, rename, "프로젝트로 옮기기" ("프로젝트 바꾸기" in a project), delete; a shared chat: never the move', async () => {
    useChats.setState({ chats: [chat(1), chat(2, { projectId: P }), chat(3, { projectId: P, shared: shared('mina', true) }), chat(4, { projectId: P, shared: shared('bob', true) }), chat(5, { projectId: P, shared: shared('bob', false), pinnedAt: '2026-11-02T00:00:00.000Z' })] })
    const m = await render()
    const pin = ['chat-row-pin', ko('chat.pin')]
    const link = ['chat-row-copy-link', ko('rooms.menu.copyLink')]
    try {
      // no 폴더로 옮기기: the Trina list has no folders (the owner, 2026-11-13); a project keeps chats together
      expect(await items(m, '채팅 1')).toEqual([pin, link, ['chat-row-rename', ko('chat.rename')], ['chat-row-move', ko('chat.project.add')], ['chat-row-delete', ko('common.delete')]])
      expect(await items(m, '채팅 2')).toEqual([pin, link, ['chat-row-rename', ko('chat.rename')], ['chat-row-move', ko('chat.project.change')], ['chat-row-delete', ko('common.delete')]])
      // shared project chats stay in their project: mine to rename and delete, an editor's to delete; a pin for anyone
      expect(await items(m, '채팅 3')).toEqual([pin, link, ['chat-row-rename', ko('chat.rename')], ['chat-row-delete', ko('common.delete')]])
      expect(await items(m, '채팅 4')).toEqual([pin, link, ['chat-row-delete', ko('common.delete')]])
      expect(await items(m, '채팅 5')).toEqual([['chat-row-unpin', ko('chat.unpin')], link])
    } finally {
      await m.unmount()
    }
  })

  test('링크 복사: the chat\'s address alone on this origin; the toast says who can open it (the project\'s people, or only me)', async () => {
    useChats.setState({ chats: [chat(1), chat(3, { projectId: P, shared: shared('bob', false) })] })
    const copied: string[] = []
    const g = globalThis as Record<string, unknown>
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const hadLocation = 'location' in g
    const loc = g.location
    g.location = { origin: 'https://team.acme.example', pathname: '/', search: '' }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { ...globalThis.navigator, clipboard: { writeText: async (x: string) => void copied.push(x) } } })
    const m = await render()
    try {
      for (const [title, n, text] of [['채팅 1', 1, ko('chat.linkCopiedPrivate')], ['채팅 3', 3, ko('chat.linkCopiedShared', { n: 3 })]] as const) {
        const row = m.get('recents-list').querySelectorAll('li').find((li) => li.textContent?.includes(title))!
        await m.click(row.querySelector(`button[aria-label="${ko('chat.menu')}"]`)!)
        await m.click(row.querySelector('[data-testid="chat-row-copy-link"]')!)
        await m.until(() => copied.length === (n === 1 ? 1 : 2), 'the copy')
        expect(copied.at(-1)).toBe(`https://team.acme.example/c/${chat(n).id}`)
        expect(useUi.getState().toasts.at(-1)?.text).toBe(text)
      }
      expect(ko('chat.linkCopiedShared', { n: 3 })).toBe('링크를 복사했어요 · 3명이 열 수 있어요')
      await m.settle(1600)
    } finally {
      if (nav) Object.defineProperty(globalThis, 'navigator', nav)
      if (hadLocation) g.location = loc
      else delete g.location
      await m.unmount()
    }
  })

  test('Esc closes the menu only, and the keyboard is back on "…"', async () => {
    useChats.setState({ chats: [chat(1)] })
    const closed: boolean[] = []
    const onKey = (e: { key?: string }) => { if (e.key === 'Escape') closed.push(true) }
    window.addEventListener('keydown', onKey as never)
    const m = await render()
    try {
      const row = m.get('recents-list').querySelector('li')!
      const more = row.querySelector(`button[aria-label="${ko('chat.menu')}"]`)!
      await m.click(more)
      const item = m.get('chat-row-move')
      item.focus()
      await act(async () => { item.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })) })
      expect(m.find('chat-row-move')).toBeNull()
      expect(document.activeElement).toBe(more as never)
      // not on to the page's own Esc (Layout: the side panel)
      expect(closed).toEqual([])
    } finally {
      window.removeEventListener('keydown', onKey as never)
      await m.unmount()
    }
  })

  test('the rooms\' row menu: a right-click on the row opens it; on a touch screen a long press does, with the chat\'s title on top, and the finger lifting opens no chat', async () => {
    useChats.setState({ chats: [chat(1)] })
    let path = ''
    const Where = () => { path = useLocation().pathname; return null }
    const m = await mount(<MemoryRouter initialEntries={['/']}><Nav /><Where /></MemoryRouter>)
    try {
      const row = m.get('recents-list').querySelector('li')!
      const link = row.querySelector('a')!
      const shown = () => row.querySelectorAll('[role="menuitem"]').length
      await m.settle(0)
      const e = new FakeEvent('contextmenu', { bubbles: true, cancelable: true })
      link.dispatchEvent(e)
      await m.until(() => shown() === 5, 'the menu')
      expect(e.defaultPrevented).toBe(true)
      await m.click(row.querySelector(`button[aria-label="${ko('chat.menu')}"]`)!)
      expect(shown()).toBe(0)
      const press = (type: string) => link.dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', clientX: 20, clientY: 20 }))
      press('pointerdown')
      await m.settle(600)
      press('pointerup')
      await m.until(() => shown() === 5, 'the sheet')
      expect(m.get('menu-sheet-title').textContent).toBe('채팅 1')
      // the click that follows the finger lifting is no tap on the row
      await m.click(link)
      expect(path).toBe('/')
      // the link holds no text a long press could start selecting on a touch screen
      expect(link.getAttribute('class')).toContain('pointer-coarse:select-none')
      // the "···" shows on a phone: a long press on it opens the menu, and the click of the finger lifting does not close it
      const more = row.querySelector(`button[aria-label="${ko('chat.menu')}"]`)!
      // a later click on it closes it as usual
      await m.settle(850)
      await m.click(more)
      expect(shown()).toBe(0)
      const hold = (type: string) => more.dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', clientX: 20, clientY: 20 }))
      hold('pointerdown')
      await m.settle(600)
      hold('pointerup')
      await m.until(() => shown() === 5, 'the sheet again')
      await m.click(more)
      expect(shown()).toBe(5)
    } finally {
      await m.unmount()
    }
  })

  test('the move opens the title menu\'s dialog; a save moves the chat and the list has it', async () => {
    const id = chat(1).id
    const sent: unknown[] = []
    routes = {
      'GET /api/projects': () => json({ items: [project] }),
      [`PATCH /api/chats/${id}`]: (init) => {
        const body = JSON.parse(String(init?.body)) as { projectId: string | null }
        sent.push(body)
        return json({ ...chat(1), projectId: body.projectId })
      },
    }
    useChats.setState({ chats: [chat(1)] })
    const m = await render()
    try {
      const row = m.get('recents-list').querySelector('li')!
      await m.click(row.querySelector(`button[aria-label="${ko('chat.menu')}"]`)!)
      await m.click('chat-row-move')
      // the menu closed; the dialog is in <body>, with the projects I can see
      expect(m.find('chat-row-move')).toBeNull()
      const choices = await m.until(() => (m.find('chat-project-choices')?.textContent?.includes('Acme launch') ? m.get('chat-project-choices') : null), 'the projects')
      const radio = choices.querySelectorAll('input').find((r) => r.parentNode?.textContent?.includes('Acme launch'))!
      // a click on a radio checks it (past React's value tracker, as a browser does), then React hears the click
      await act(async () => {
        Object.getOwnPropertyDescriptor(FakeElement.prototype, 'checked')!.set!.call(radio, true)
        radio.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true }))
      })
      await m.click('chat-project-save')
      await m.until(() => useChats.getState().chats.find((c) => c.id === id)?.projectId === P, 'the chat in the project')
      expect(sent).toEqual([{ projectId: P }])
      expect(useUi.getState().toasts.at(-1)?.text).toBe(ko('chat.project.moved', { name: 'Acme launch' }))
      await m.until(() => !m.find('chat-project-choices'), 'the dialog to close')
      // the row is under its project's header at once (docs/DECISIONS.md "Trina history by project")
      expect(m.get('history-group-name').textContent).toBe('Acme launch')
      expect(m.get('history-group-rows').querySelectorAll('a').map((a) => a.textContent)).toEqual(['채팅 1'])
    } finally {
      await m.unmount()
    }
  })
})


describe('pinned chats', () => {
  const at = (n: number) => `2026-11-02T00:${String(n).padStart(2, '0')}:00.000Z`
  const links = (el: { querySelectorAll: (s: string) => { map: <T>(f: (a: { textContent?: string | null; closest: (s: string) => { getAttribute: (n: string) => string | null } | null }) => T) => T[] } }) =>
    el.querySelectorAll('a[href^="/c/"]').map((a) => a.textContent)
  const pinned = (m: Awaited<ReturnType<typeof render>>) => m.get('recents-list').querySelectorAll('li[data-pinned]').map((li) => li.textContent)

  test('"상단에 고정" pins the chat and its row goes to the top; "고정 해제" puts it back', async () => {
    const id = chat(2).id
    const sent: string[] = []
    routes = {
      [`POST /api/chats/${id}/pin`]: () => (sent.push('pin'), json({ ...chat(2), pinnedAt: at(30) })),
      [`DELETE /api/chats/${id}/pin`]: () => (sent.push('unpin'), json(chat(2))),
    }
    useChats.setState({ chats: Array.from({ length: 8 }, (_, i) => chat(i + 1)) })
    const m = await render()
    const rowOf = (title: string) => m.get('recents-list').querySelectorAll('li').find((li) => li.textContent?.includes(title))!
    try {
      await m.click(rowOf('채팅 2').querySelector(`button[aria-label="${ko('chat.menu')}"]`)!)
      await m.click('chat-row-pin')
      await m.until(() => (pinned(m).length === 1 ? true : null), 'the pinned row')
      expect(links(m.get('recents-list') as never)[0]).toBe('채팅 2')
      expect(rowOf('채팅 2').querySelector('[data-testid="chat-pin-icon"]')).not.toBeNull()
      await m.click(rowOf('채팅 2').querySelector(`button[aria-label="${ko('chat.menu')}"]`)!)
      await m.click('chat-row-unpin')
      await m.until(() => (pinned(m).length === 0 ? true : null), 'no pinned row')
      expect(links(m.get('recents-list') as never).at(-1)).toBe('채팅 1')
      expect(sent).toEqual(['pin', 'unpin'])
    } finally {
      await m.unmount()
    }
  })
})


describe("the phone's ☰ drawer", () => {
  test('its history is by date by default (오늘, …), as before the redesign; the computer panel keeps its own default', async () => {
    const now = new Date().toISOString()
    useChats.setState({ chats: [chat(1, { projectId: '01900000-0000-7000-8000-0000000000aa', updatedAt: now, title: '오늘 채팅' })], chatsLoaded: true, chatsCursor: null })
    const { TrinaDrawer, useTrinaDrawer } = await import('../../src/components/phone/TrinaDrawer')
    const m = await mount(<MemoryRouter initialEntries={['/']}><TrinaDrawer /></MemoryRouter>)
    try {
      await act(async () => useTrinaDrawer.getState().setOpen(true))
      await m.until(() => m.find('trina-drawer'), 'the drawer', 2000)
      expect(m.html()).toContain(translate('ko', 'sidebar.today'))
      // nothing is filtered: no chip, the default is the drawer's own
      expect(m.find('recents-filter-label')).toBeNull()
      expect(m.html()).toContain('오늘 채팅')
    } finally {
      await act(async () => useTrinaDrawer.getState().setOpen(false))
      await m.unmount()
    }
  })
})

describe('the history filter\'s kept "Confidential" (QA TC-1031)', () => {
  const keep = () => localStorage.setItem('mycel.sidebar.historyView', JSON.stringify({ status: 'confidential' }))

  test('without Safe operations 1A and no confidential chat: the whole list, as "Active"', async () => {
    keep()
    const m = await render()
    try {
      await m.until(() => m.html().includes('채팅 8'), 'the list', 2000)
      expect(m.find('recents-no-match')).toBeNull()
      expect(m.get('recents-list').querySelectorAll('li').length).toBe(8)
    } finally {
      await m.unmount()
    }
  })

  test('with one confidential chat in the list: only that chat, the choice kept', async () => {
    keep()
    useChats.setState({ chats: [chat(1), chat(2, { confidential: true, title: '기밀 채팅' }), chat(3)], chatsLoaded: true, chatsCursor: null })
    const m = await render()
    try {
      await m.until(() => m.html().includes('기밀 채팅'), 'the list', 2000)
      expect(m.get('recents-list').querySelectorAll('li').length).toBe(1)
      expect(m.html()).not.toContain('채팅 3')
    } finally {
      await m.unmount()
    }
  })

  test('while 1A is on (Me.server.allChatsConfidential): the choice is kept', async () => {
    keep()
    const on = me('member')
    useSession.setState({ status: { kind: 'signed-in', me: { ...on, server: { ...on.server, allChatsConfidential: true } } } } as never)
    const m = await render()
    try {
      await m.until(() => m.find('recents-no-match'), 'the empty filter', 2000)
    } finally {
      await m.unmount()
    }
  })
})
