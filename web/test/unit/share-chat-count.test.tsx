// The share dialog of an existing chat (components/chat/ShareChat.tsx ShareChatFlow) says how many people in the project
// will see it the way the line under the box (whoSees, 'chat.shared') and the copy-link toast ('chat.linkCopiedShared')
// count them: everyone who sees the project, me included. The server's check answers with the others (QA TC-070: the
// dialog said 2 people where the line and the toast said 3).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { translate, useLocaleStore } from '../../src/i18n'
import { ShareChatFlow } from '../../src/components/chat/ShareChat'
import { seenOnceShared, whoSees } from '../../src/lib/sharedChat'
import { installDom, mount, removeDom } from './dom-host'

const CHAT = '01900000-0000-7000-8000-0000000000c7'
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  // the share check: two other people in the project, one of them cannot see something the chat used
  globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'confirm', audience: 2, provenance: { people: 1, places: [], otherPlaces: false }, memories: false, confirmKey: 'k' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  useLocaleStore.setState({ locale })
  removeDom()
})

test('the dialog counts me in, like the line under the box and the copy-link toast', () => {
  expect(seenOnceShared(2)).toBe(3)
  // once shared, Chat.shared.audience is the project's people, me included: 3
  expect(whoSees({ audience: 3 })).toEqual({ kind: 'people', n: 3 })
  for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
    expect(translate(l, 'chat.shareChat.title', { n: 3 })).toContain('3')
    expect(translate(l, 'chat.shared', { n: 3 })).toContain('3')
    expect(translate(l, 'chat.linkCopiedShared', { n: 3 })).toContain('3')
  }
  // the footer's words: "N members can see it"
  expect(translate('en', 'chat.shareChat.title', { n: 3 })).toBe('Share this chat so 3 members can see it?')
  expect(translate('en', 'chat.shared', { n: 3 })).toBe('Shared chat · 3 members can see it')
  expect(translate('ko', 'chat.shareChat.title', { n: 3 })).toBe('이 채팅을 공유해서 멤버 3명이 볼 수 있게 할까요?')
  expect(translate('ko', 'chat.shared', { n: 3 })).toBe('공유 채팅 · 멤버 3명이 볼 수 있어요')
})

for (const l of ['en', 'ko'] as const) {
  test(`${l}: the confirm's title says 3 for two others; the provenance line still counts the others who cannot see`, async () => {
    useLocaleStore.setState({ locale: l })
    const m = await mount(<ShareChatFlow chatId={CHAT} onClose={() => {}} />)
    try {
      const dialog = await m.until(() => m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the confirm')
      expect(dialog.querySelector('h2')!.textContent).toBe(translate(l, 'chat.shareChat.title', { n: 3 }))
      expect(m.get('share-chat-provenance').textContent).toBe(translate(l, 'chat.shareChat.provenanceNoPlace', { m: 1 }))
    } finally {
      await m.unmount()
    }
  })
}
