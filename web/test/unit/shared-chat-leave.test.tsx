// Leaving and losing a chat shared with people (docs/decisions/20261122-shared-chat-leave-and-lost-notices.md): the
// "added / removed / left" lines between the messages (components/chat/ChatEvents.tsx), the Inbox words of 'chat.lost'
// (components/settings/Notifications.tsx chatLostText), an answer stopped for its removed requester (Message.stoppedFor),
// and "Leave this chat" in the row and title menus for someone it was shared with, never its creator.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRef } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { Chat, type Me } from '@mycel/shared/api'
import { ChatEventLine, eventsBetween, type AudienceEvent } from '../../src/components/chat/ChatEvents'
import { chatLostText } from '../../src/components/settings/Notifications'
import { AssistantMessage } from '../../src/components/chat/Messages'
import { ChatTitleMenu } from '../../src/components/chat/ChatTitleMenu'
import { useChatMenuItems } from '../../src/components/chat/chatMenuItems'
import { translate, useLocaleStore } from '../../src/i18n'
import { useEngines } from '../../src/store/engines'
import { useSession } from '../../src/store/session'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

const en = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate('en', k, v)
const t = ((k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => en(k, v)) as never
const me = { user: { id: 'mia', username: 'mia', name: 'Mia', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', chatTrashRetentionDays: 7 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' } } as unknown as Me
const sharedChat = (by: string, named = by !== 'mia') => Chat.parse({ id: CHAT, projectId: null, title: 'Plan', engine: 'claude-code', model: null, createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', deletedAt: null, runState: 'idle',
  shared: { kind: 'people', by: { id: by, name: by === 'mia' ? 'Mia' : 'Bob' }, audience: 3, answering: null, mine: true, canDelete: by === 'mia', ...(named ? { named: true } : {}) } })

const before = { status: useSession.getState().status, locale: useLocaleStore.getState().locale, engines: useEngines.getState() }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  useEngines.setState({ loaded: true, canChoose: false, engines: ['claude-code'], models: {} })
})
afterAll(() => { useSession.setState({ status: before.status }); useLocaleStore.setState({ locale: before.locale }); useEngines.setState(before.engines); removeDom() })

describe('who changed its people', () => {
  const ev = (at: string, kind: AudienceEvent['kind'], names: string[] = []): AudienceEvent => ({ at, kind, actor: 'Mia', names })
  test('lines fall between the messages by time', () => {
    const all = [ev('2026-11-22T01:00:00.000Z', 'added', ['Bob']), ev('2026-11-22T03:00:00.000Z', 'left')]
    expect(eventsBetween(all, null, '2026-11-22T02:00:00.000Z').map((e) => e.kind)).toEqual(['added'])
    expect(eventsBetween(all, '2026-11-22T02:00:00.000Z', null).map((e) => e.kind)).toEqual(['left'])
    expect(eventsBetween(all, '2026-11-22T01:00:00.000Z', '2026-11-22T02:00:00.000Z')).toEqual([])
  })
  test('the words, as rooms say them', async () => {
    const m = await mount(<div><ChatEventLine e={ev('2026-11-22T01:00:00.000Z', 'added', ['Bob', 'Sales'])} /><ChatEventLine e={{ ...ev('2026-11-22T02:00:00.000Z', 'left'), actor: 'Bob' }} /></div>)
    const lines = m.container.querySelectorAll('[data-testid="chat-event"]') as unknown as FakeElement[]
    expect(lines.map((l) => l.textContent)).toEqual([en('chat.event.added', { actor: 'Mia', names: `Bob${en('rooms.nameSep')}Sales` }), en('chat.event.left', { actor: 'Bob' })])
    await m.unmount()
  })
})

describe("the Inbox's lost-access notice", () => {
  test('who and why; the deletion day when the creator left the team', () => {
    expect(chatLostText({ reason: 'stopped', name: 'Mia', title: null }, t, 'en')).toBe(en('notifications.event.chat.lostStopped', { name: 'Mia' }))
    expect(chatLostText({ reason: 'deleted', name: 'Mia', title: null }, t, 'en')).toBe(en('notifications.event.chat.lostDeleted', { name: 'Mia' }))
    expect(chatLostText({ reason: 'account', name: 'Mia', title: null, until: '2026-11-29T12:00:00.000Z' }, t, 'en')).toContain('Mia')
    expect(chatLostText({ reason: 'account', name: 'Mia', title: null }, t, 'en')).toBe(en('notifications.event.chat.lostAccountNow', { name: 'Mia' }))
    expect(chatLostText({ reason: 'stopped', name: null, title: null }, t, 'en')).toBe(en('notifications.event.chat.lost'))
  })
})

describe('an answer stopped for its removed requester', () => {
  test('says why, by name; any other stop keeps "Stopped"', async () => {
    const removed = { ...msg({ role: 'assistant', status: 'stopped', content: '' }), stoppedFor: { reason: 'requester_removed' as const, name: 'Hank' } }
    const m = await mount(<MemoryRouter><AssistantMessage m={removed} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} /></MemoryRouter>)
    expect(m.get('answer-stopped').textContent).toContain(en('chat.stoppedRemoved', { name: 'Hank' }))
    await m.unmount()
    const plain = await mount(<MemoryRouter><AssistantMessage m={msg({ role: 'assistant', status: 'stopped', content: '' })} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} /></MemoryRouter>)
    expect(plain.get('answer-stopped').textContent).toContain(en('chat.stopped'))
    await plain.unmount()
  })
})

describe('"Leave this chat" in the menus', () => {
  function Row({ c, out }: { c: Chat; out: { ids?: string[] } }) {
    out.ids = useChatMenuItems(c, { testId: 'row', more: createRef<HTMLButtonElement>() }).map((x) => x.testId ?? '')
    return null
  }
  test('someone it was shared with by name: Hide and Leave; through a group only: Hide; its creator: neither', async () => {
    const out0: { ids?: string[] } = {}
    const g = await mount(<MemoryRouter><Row c={sharedChat('bob', false)} out={out0} /></MemoryRouter>)
    expect(out0.ids?.includes('row-hide')).toBe(true)
    expect(out0.ids?.includes('row-leave')).toBe(false)
    await g.unmount()
    for (const [by, want] of [['bob', true], ['mia', false]] as const) {
      const out: { ids?: string[] } = {}
      const r = await mount(<MemoryRouter><Row c={sharedChat(by)} out={out} /></MemoryRouter>)
      expect(out.ids?.includes('row-leave')).toBe(want)
      expect(out.ids?.includes('row-hide')).toBe(want)
      await r.unmount()
      const m = await mount(<MemoryRouter><ChatTitleMenu chat={sharedChat(by)} title="Plan" onPin={() => {}} onHide={() => {}} onLeave={() => {}} /></MemoryRouter>)
      await m.click(m.container.querySelector('[data-testid="chat-menu"]') as unknown as FakeElement)
      const ids = (m.container.ownerDocument!.body.querySelectorAll('[role="menuitem"]') as unknown as FakeElement[]).map((e) => e.getAttribute('data-testid'))
      expect(ids.includes('chat-leave')).toBe(want)
      await m.unmount()
    }
  })
})
