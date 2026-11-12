// The chat's own title menu pins it too (QA TC-422; docs/DECISIONS.md "Pinned chats" said it was not built): "상단에
// 고정" / "고정 해제" first, the row menu's own item (its words, its icon, its call: components/chat/chatMenuItems.tsx),
// for anyone who sees the chat; the page passes the call (pages/Chat.tsx), and without it there is no item.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { createRef } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { Chat, type Me } from '@mycel/shared/api'
import { ChatTitleMenu } from '../../src/components/chat/ChatTitleMenu'
import { useChatMenuItems } from '../../src/components/chat/chatMenuItems'
import { translate, useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

const ID = '01900000-0000-7000-8000-0000000000c2'
const me = {
  user: { id: 'alex', username: 'alex', name: 'Alex', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const chat = (o: { pinned?: boolean; shared?: boolean } = {}) => Chat.parse({
  id: ID, projectId: o.shared ? '01900000-0000-7000-8000-000000000001' : null, title: 'Acme board summary', engine: 'claude-code', model: null,
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', deletedAt: null, runState: 'idle',
  ...(o.pinned ? { pinnedAt: '2026-11-09T00:00:00.000Z' } : {}),
  // someone else's shared chat: I may neither rename, move nor delete it, but I may pin it
  ...(o.shared ? { shared: { by: { id: 'ben', name: 'Ben' }, audience: 3, answering: null, mine: false, canDelete: false } } : {}),
})
const ko = (k: Parameters<typeof translate>[1]) => translate('ko', k)

const status = useSession.getState().status
const locale = useLocaleStore.getState().locale
beforeAll(() => installDom())
beforeEach(() => {
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
})
afterEach(() => {
  useSession.setState({ status })
  useLocaleStore.setState({ locale })
})
afterAll(() => removeDom())

const items = (m: Awaited<ReturnType<typeof mount>>) => (m.container.ownerDocument!.body.querySelectorAll('[role="menuitem"]') as unknown as FakeElement[])
const iconOf = (e: FakeElement) => (e.querySelector('svg')?.getAttribute('class') ?? '').split(/\s+/).find((c) => c.startsWith('lucide-'))

/** the row menu's first item for this chat, as the sidebar's "···" has it */
function RowFirst({ c, out }: { c: Chat; out: { label?: string; icon?: string } }) {
  const [first] = useChatMenuItems(c, { testId: 'chat-row', more: createRef<HTMLButtonElement>() })
  out.label = first!.label
  return <span data-testid="row-first">{first!.icon}</span>
}

for (const pinned of [false, true]) {
  test(`the title menu's first item is the row menu's (${pinned ? '고정 해제' : '상단에 고정'}), and it runs the page's call`, async () => {
    const c = chat({ pinned })
    let calls = 0
    const row: { label?: string } = {}
    const r = await mount(<MemoryRouter><RowFirst c={c} out={row} /></MemoryRouter>)
    const rowIcon = iconOf(r.get('row-first'))
    await r.unmount()
    const m = await mount(<ChatTitleMenu chat={c} title={c.title} onPin={() => calls++} onRename={() => {}} onDelete={() => {}} />)
    try {
      await m.click('chat-menu')
      const list = items(m)
      expect(list.map((e) => e.getAttribute('data-testid'))).toEqual([pinned ? 'chat-unpin' : 'chat-pin', 'chat-copy-link', 'chat-rename', 'chat-delete'])
      expect(list[0]!.textContent?.trim()).toBe(ko(pinned ? 'chat.unpin' : 'chat.pin'))
      expect(list[0]!.textContent?.trim()).toBe(row.label!)
      expect(iconOf(list[0]!)).toBe(rowIcon!)
      expect(rowIcon).toBe(pinned ? 'lucide-pin-off' : 'lucide-pin')
      await m.click(list[0]!)
      expect(calls).toBe(1)
    } finally {
      await m.unmount()
    }
  })
}

test("someone else's shared chat: the pin is there though nothing else is mine to change", async () => {
  const c = chat({ shared: true })
  const m = await mount(<ChatTitleMenu chat={c} title={c.title} onPin={() => {}} />)
  try {
    await m.click('chat-menu')
    expect(items(m).map((e) => e.getAttribute('data-testid'))).toEqual(['chat-pin', 'chat-copy-link'])
  } finally {
    await m.unmount()
  }
})

test('no call from the page: no item (the menu as before)', async () => {
  const c = chat()
  const m = await mount(<ChatTitleMenu chat={c} title={c.title} />)
  try {
    await m.click('chat-menu')
    expect(items(m).map((e) => e.getAttribute('data-testid'))).toEqual(['chat-copy-link'])
  } finally {
    await m.unmount()
  }
})
