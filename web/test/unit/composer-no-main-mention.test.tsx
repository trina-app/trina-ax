// The main box of an AI chat has no "@" people (owner 2026-11-22, docs/decisions/20261122-ai-session-no-main-mention.md):
// also in a chat shared with people or a project's shared chat, "@" opens no member list and a send carries no
// mentions (the text goes as typed, to the AI). A person is mentioned in a thread under an AI answer
// (chat-thread-mentions.test.tsx); a room's box keeps its own list (room-mention-tokens.test.tsx).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Attachment } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import Composer from '../../src/components/chat/Composer'
import { CHAT } from './fixtures'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

const before = useLocaleStore.getState().locale
const realFetch = globalThis.fetch
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
afterAll(() => { globalThis.fetch = realFetch; removeDom(); useLocaleStore.setState({ locale: before }) })

test('a shared or project chat\'s main box: "@" lists nobody, the send carries the text alone', async () => {
  for (const kind of ['people', 'project'] as const) {
    const sent: unknown[][] = []
    const m = await mount(
      <Composer draftId={CHAT} ensureChat={async () => CHAT} running={false} onSend={async (...args: [string, Attachment[]]) => void sent.push(args)} onStop={async () => {}}
        engine={{ engine: undefined, model: undefined }} sharedUploads={{ audience: 3, allowed: true, kind }} projectId={kind === 'project' ? 'p1' : null} />,
    )
    try {
      const box = m.get('composer-input') as FakeElement & { value: string }
      await m.type(box, '@')
      expect(m.find('mention-menu')).toBeNull()
      await m.type(box, '@dion hi')
      expect(m.find('mention-menu')).toBeNull()
      await m.click('send')
      expect(sent).toEqual([['@dion hi', []]])
    } finally { await m.unmount() }
  }
})

test('the chat page gives its main box no people to mention', () => {
  const page = readFileSync(join(import.meta.dir, '../../src/pages/Chat.tsx'), 'utf8')
  expect(page).not.toContain('mentionPeople')
  expect(page).not.toContain('mentionable')
})
