// A chat's header says who shared it (components/chat/SharedChat.tsx sharedByOf and SharedByLine; plan
// docs/AGENTS/plan/20261121-0510-shared-chat-header-sharer.md): only to someone else in a chat shared with people and
// groups, never to its creator, never on a shared project chat (its header keeps "Project / Title") or a chat of one
// person. The words in the six languages.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Chat } from '@mycel/shared/api'
import { LOCALES, translate, useLocaleStore } from '../../src/i18n'
import { SharedByLine, sharedByOf } from '../../src/components/chat/SharedChat'
import { installDom, mount, removeDom } from './dom-host'

const OLGA = { id: 'olga', name: 'Olga' }
const shared = (kind: 'people' | 'project' | undefined): Pick<Chat, 'shared'> =>
  ({ shared: { ...(kind ? { kind } : {}), by: OLGA, audience: 2, answering: null, mine: false, canDelete: false } })
const before = useLocaleStore.getState().locale
const realFetch = globalThis.fetch

beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before })
})

describe('who shared it', () => {
  test('a recipient of a chat shared with people: its creator; anyone else: nobody', () => {
    expect(sharedByOf(shared('people'), 'bob')).toEqual(OLGA)
    // its creator
    expect(sharedByOf(shared('people'), 'olga')).toBeNull()
    // a shared project chat (also from an older server that sends no kind)
    expect(sharedByOf(shared('project'), 'bob')).toBeNull()
    expect(sharedByOf(shared(undefined), 'bob')).toBeNull()
    // a chat of one person, or none yet
    expect(sharedByOf({}, 'bob')).toBeNull()
    expect(sharedByOf(null, 'bob')).toBeNull()
  })

  test('the words, in every language, with the name', () => {
    for (const { id: l } of LOCALES) expect(translate(l, 'chat.sharedBy', { name: 'Muhammad Rayandika' })).toContain('Muhammad Rayandika')
    expect(translate('en', 'chat.sharedBy', { name: 'Muhammad Rayandika' })).toBe('Shared by Muhammad Rayandika')
    expect(translate('ko', 'chat.sharedBy', { name: 'Muhammad Rayandika' })).toBe('Muhammad Rayandika님이 공유')
  })

  test('the line: the face and the words, the whole of them as its tooltip; a phone\'s line lets taps through', async () => {
    const m = await mount(<SharedByLine by={OLGA} />)
    const el = m.get('chat-shared-by')
    expect(el.textContent).toBe('OOlga님이 공유')
    expect(el.getAttribute('title')).toBe('Olga님이 공유')
    expect(el.className).not.toContain('pointer-events-none')
    await m.unmount()
    const line = await mount(<SharedByLine by={OLGA} line />)
    expect(line.get('chat-shared-by').className).toContain('pointer-events-none')
    await line.unmount()
  })
})
