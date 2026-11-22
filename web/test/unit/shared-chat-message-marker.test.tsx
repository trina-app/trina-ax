// A chat shared with people shows its unread messages as a number (docs/decisions/20261122-shared-chat-new-message-notices.md):
// the marker, the one count n (messages, as a group chat in a room) and the row's pill (the number: the main box mentions
// nobody, docs/decisions/20261122-ai-session-no-main-mention.md).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { attentionCount, markerOf } from '../../src/lib/sessionMarkers'
import { SessionMarker } from '../../src/components/chat/ChatState'
import { installDom, mount, removeDom } from './dom-host'

const idle = { id: 'c1', runState: 'idle' as const }

describe('a chat shared with people: unread messages', () => {
  test('its number comes before the ring of a running answer, and not while the chat is on screen', () => {
    expect(markerOf({ ...idle, unseen: true, unreadCount: 3 })).toEqual({ kind: 'new', reason: 'message', count: 3 })
    expect(markerOf({ ...idle, runState: 'running', unseen: true, unreadCount: 2 })).toEqual({ kind: 'new', reason: 'message', count: 2 })
    expect(markerOf({ ...idle, unseen: true, unreadCount: 2 }, { here: true })).toBeNull()
    // a card still wins
    expect(markerOf({ ...idle, waiting: true, unseen: true, unreadCount: 2 })?.kind).toBe('ask')
  })

  test('n counts its messages; a plain new answer still counts once', () => {
    const a = attentionCount([{ ...idle, unseen: true, unreadCount: 4 }, { id: 'c2', runState: 'idle', unseen: true }], [])
    expect(a).toMatchObject({ n: 5, chats: 5 })
    expect(attentionCount([{ ...idle, unseen: true, unreadCount: 4 }], [], { here: 'c1' }).n).toBe(0)
  })

  describe('the pill', () => {
    beforeAll(() => { installDom() })
    afterAll(() => removeDom())
    const html = async (ui: Parameters<typeof mount>[0]) => { const p = await mount(ui); const h = p.html(); await p.unmount(); return h }
    test('the number in the rooms\' count pill, 99+ above 99', async () => {
      expect(await html(<SessionMarker marker={{ kind: 'new', reason: 'message', count: 3 }} label="New messages" />)).toMatch(/data-testid="marker-count"[^>]*>.*>3</)
      expect(await html(<SessionMarker marker={{ kind: 'new', reason: 'message', count: 120 }} label="New messages" />)).toContain('>99+<')
    })
  })
})
