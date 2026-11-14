// The Share dialog of a chat outside projects (components/chat/ChatShareDialog.tsx; docs/DECISIONS.md "Chats shared
// with people and groups", QA TC-1405), every exit:
// - nothing changed: Save is off, ✕ closes at once (no ask);
// - a pick: "new" on its row, Save (Share while not shared yet); ✕ asks "Discard changes?": Keep editing keeps the
//   pick, Discard closes;
// - ✕ on a saved row strikes it out with Undo; Undo puts it back and Save is off again;
// - a failed save keeps the picks with the error above the button; a refusal says the server's words;
// - the server's check comes back in place: the lines, "Share anyway", which sends the key back; another pick asks
//   again; the widening line opens the list with the chat as its target;
// - someone else's shared chat: read only, who can change it; a personal project: why, and Move….
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { ChatAudience, PutChatAudienceResult } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ChatShareDialog } from '../../src/components/chat/ChatShareDialog'
import { DialogHost } from '../../src/components/ui'
import { usePeople } from '../../src/store/people'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const C1 = '01900000-0000-7000-8000-0000000000c1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const PEOPLE = { people: [{ id: 'mia', name: 'Mia' }, { id: 'bob', name: 'Bob' }, { id: 'sora', name: 'Sora' }] }
const chat = { id: C1, title: 'Q3 budget questions' }
const audience = (subjects: ChatAudience['subjects'] = [], o: Partial<ChatAudience> = {}): ChatAudience => ({ kind: subjects.length ? 'people' : 'private', canEdit: true, by: { id: 'mia', name: 'Mia' }, subjects, count: subjects.length + 1, ...o })
const SORA = { subjectType: 'user' as const, subjectId: 'sora', name: 'Sora' }
const chatOut = { id: C1, title: 'Q3 budget questions', projectId: null, engine: 'claude-code', model: null, deletedAt: null, createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z', runState: 'idle', shared: { kind: 'people', by: { id: 'mia', name: 'Mia' }, audience: 2, answering: null, mine: true, canDelete: true } }

let sent: { key: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
let routes: Record<string, (body: unknown) => Response> = {}
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = init?.body ? JSON.parse(String(init.body)) : null
    sent.push({ key, body })
    return routes[key]?.(body) ?? json(500, { error: { code: 'internal', message: `no route ${key}` } })
  }) as unknown as typeof fetch
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role: 'member' }, groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
})
afterEach(() => { sent = []; usePeople.getState().reset() })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars)
const AUD = `/api/chats/${C1}/audience`
const routesWith = (a: ChatAudience, put?: (body: unknown) => Response) => {
  routes = {
    'GET /api/people': () => json(200, PEOPLE),
    [`GET ${AUD}`]: () => json(200, a),
    [`PUT ${AUD}`]: put ?? (() => json(200, { status: 'saved', chat: chatOut, audience: a })),
    'POST /api/sharing/widening-answers': () => json(200, { total: 0, totalCapped: false, nextCursor: null, items: [] }),
  }
}
const closeButton = (m: Mounted) => m.container.ownerDocument!.body.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === en('common.close'))!
async function open(onClose: () => void = () => {}) {
  const m = await mount(<MemoryRouter initialEntries={[`/c/${C1}`]}><ChatShareDialog chat={chat} onClose={onClose} /><DialogHost /></MemoryRouter>)
  await m.until(() => m.find('participant-user-mia'), 'the creator\'s row', 2000)
  return m
}
async function addBob(m: Mounted) {
  await m.type('chat-share-picker-search', 'bob')
  await m.click(await m.until(() => m.find('participant-add-user-bob'), 'Bob to add', 2000))
  await m.until(() => m.find('participant-user-bob')?.getAttribute('data-state') === 'new', 'Bob new', 2000)
}

describe('the save model and every exit', () => {
  test('empty: the creator "Started this chat" without ✕, Save off; ✕ closes at once, no ask', async () => {
    routesWith(audience())
    let closed = 0
    const m = await open(() => closed++)
    expect(m.get('participant-tags-user-mia').textContent).toContain(en('chat.share.started'))
    // a phone shows "You" alone (no cut tag); the whole tag is its tooltip
    expect(m.get('participant-tags-user-mia').getAttribute('title')).toBe(`${en('projects.youTag')} · ${en('chat.share.started')}`)
    expect(m.get('participant-tags-user-mia').querySelector('span[class="sm:hidden"]')?.textContent).toContain(en('projects.youTag'))
    expect(m.find('participant-remove-user-mia')).toBeNull()
    expect(m.get('chat-share-save').hasAttribute('disabled')).toBe(true)
    expect(m.get('chat-share-save').textContent).toBe(en('chat.share.share'))
    expect(m.get('chat-share-note').textContent).toBe(en('chat.share.note'))
    expect(m.get('chat-share-title').textContent).toBe('Share "Q3 budget questions"')
    // me is never offered
    await m.type('chat-share-picker-search', 'mia')
    expect(m.find('participant-add-user-mia')).toBeNull()
    // Cancel beside Save: with nothing changed it just closes, as ✕ does
    expect(m.get('chat-share-cancel').textContent).toBe(en('common.cancel'))
    await m.click('chat-share-cancel')
    expect(closed).toBe(1)
    await m.click(closeButton(m))
    expect(closed).toBe(2)
    expect(m.find('dialog-confirm')).toBeNull()
    await m.unmount()
  })

  test('a pick: new, Share on; ✕ asks; Keep editing keeps it; Discard closes', async () => {
    routesWith(audience())
    let closed = 0
    const m = await open(() => closed++)
    await addBob(m)
    expect(m.get('chat-share-save').hasAttribute('disabled')).toBe(false)
    await m.click(closeButton(m))
    await m.until(() => m.find('dialog-confirm'), 'the discard ask', 2000)
    expect(m.get('dialog-cancel').textContent).toBe(en('chat.share.keepEditing'))
    expect(m.get('dialog-confirm').textContent).toBe(en('chat.share.discard'))
    await m.click('dialog-cancel')
    await m.until(() => !m.find('dialog-confirm'), 'the ask gone', 2000)
    expect(closed).toBe(0)
    expect(m.get('participant-user-bob').getAttribute('data-state')).toBe('new')
    // Cancel asks the same
    await m.click('chat-share-cancel')
    await m.click(await m.until(() => m.find('dialog-confirm'), 'the discard ask again', 2000))
    await m.until(() => closed === 1, 'closed', 2000)
    expect(sent.some((x) => x.key === `PUT ${AUD}`)).toBe(false)
    await m.unmount()
  })

  test('✕ on a saved row strikes it out with Undo; Undo puts it back and Save is off again; everyone out says so', async () => {
    routesWith(audience([SORA]))
    const m = await open()
    await m.until(() => m.find('participant-user-sora'), 'Sora', 2000)
    expect(m.get('chat-share-save').textContent).toBe(en('common.save'))
    await m.click('participant-remove-user-sora')
    expect(m.get('participant-user-sora').getAttribute('data-state')).toBe('removed')
    expect(m.get('chat-share-only-you').textContent).toBe(en('chat.share.onlyYou'))
    expect(m.get('chat-share-save').hasAttribute('disabled')).toBe(false)
    await m.click('participant-undo-user-sora')
    expect(m.get('participant-user-sora').getAttribute('data-state')).toBe('member')
    expect(m.find('chat-share-only-you')).toBeNull()
    expect(m.get('chat-share-save').hasAttribute('disabled')).toBe(true)
    await m.unmount()
  })

  test('a failed save keeps the picks with the error above the button; a refusal says why; then it saves', async () => {
    let calls = 0
    routesWith(audience(), () => {
      calls++
      if (calls === 1) return json(500, { error: { code: 'internal', message: 'boom' } })
      if (calls === 2) return json(409, { error: { code: 'conflict', message: 'An answer is still running. Share it when it is done.', params: { reason: 'chat_busy' } } })
      return json(200, { status: 'saved', chat: chatOut, audience: audience([{ subjectType: 'user', subjectId: 'bob', name: 'Bob' }]) })
    })
    let closed = 0
    const m = await open(() => closed++)
    await addBob(m)
    await m.click('chat-share-save')
    const err = await m.until(() => m.find('chat-share-error'), 'the error', 2000)
    expect(err.textContent).toBe(en('chat.share.saveFailed'))
    expect(m.get('participant-user-bob').getAttribute('data-state')).toBe('new')
    expect(closed).toBe(0)
    await m.click('chat-share-save')
    await m.until(() => m.find('chat-share-error')?.textContent === 'An answer is still running. Share it when it is done.', 'the refusal', 2000)
    expect(m.get('participant-user-bob').getAttribute('data-state')).toBe('new')
    await m.click('chat-share-save')
    await m.until(() => closed === 1, 'saved and closed', 2000)
    expect((sent.filter((x) => x.key === `PUT ${AUD}`).at(-1)!.body as { subjects: unknown[] }).subjects).toEqual([{ subjectType: 'user', subjectId: 'bob' }])
    await m.unmount()
  })

  test('the check in place: lines, Share anyway with the key; another pick asks again; the widening list is the chat\'s', async () => {
    const confirm: PutChatAudienceResult = { status: 'confirm', added: 1, memories: true, hiddenAnswers: 3, confirmKey: 'k1', provenance: { people: 1, places: [{ kind: 'mine' }], otherPlaces: false } }
    let closed = 0
    routesWith(audience(), (body) => (body as { confirmKey?: string }).confirmKey === 'k1' ? json(200, { status: 'saved', chat: chatOut, audience: audience([{ subjectType: 'user', subjectId: 'bob', name: 'Bob' }]) }) : json(200, confirm))
    const m = await open(() => closed++)
    await addBob(m)
    await m.click('chat-share-save')
    // one warning (the answers, with the place I may open), the memories a quiet line of their own, the note shorter
    const warning = await m.until(() => m.find('chat-share-warning'), 'the warning', 2000)
    expect(warning.textContent).toContain(en('chat.share.warnPlaces', { n: 3, names: 'Bob', places: en('shareRoom.placeMineFiles') }))
    expect(m.get('chat-share-memories').textContent).toBe(en('chat.shareChat.memories'))
    expect(m.get('chat-share-note').textContent).toBe(en('chat.share.noteShort'))
    expect(m.get('chat-share-save').textContent).toBe(en('chat.share.shareAnyway'))
    // the list, about this chat
    await m.click('chat-share-widen-show')
    await m.until(() => m.find('widening-list'), 'the list', 2000)
    expect((sent.find((x) => x.key === 'POST /api/sharing/widening-answers')!.body as { target: unknown }).target).toEqual({ kind: 'chat', chatId: C1 })
    expect(m.get('widening-list-title').textContent).toBe(en('share.widenList.title', { names: 'Bob' }))
    await m.click('widening-list-back')
    await m.until(() => m.find('chat-share-save'), 'back to the picks', 2000)
    // another pick: the confirm goes, Share again
    await m.type('chat-share-picker-search', 'sora')
    await m.click(await m.until(() => m.find('participant-add-user-sora'), 'Sora to add', 2000))
    await m.until(() => !m.find('chat-share-warning'), 'the lines gone', 2000)
    expect(m.get('chat-share-save').textContent).toBe(en('chat.share.share'))
    await m.click('participant-remove-user-sora')
    await m.click('chat-share-save')
    await m.until(() => m.get('chat-share-save').textContent === en('chat.share.shareAnyway'), 'asked again', 2000)
    await m.click('chat-share-save')
    await m.until(() => closed === 1, 'shared', 2000)
    expect((sent.filter((x) => x.key === `PUT ${AUD}`).at(-1)!.body as { confirmKey?: string }).confirmKey).toBe('k1')
    await m.unmount()
  })

  test('a first share: the files I attached will be visible to them (a quiet line, asked even alone); what could not go is said after', async () => {
    const confirm: PutChatAudienceResult = { status: 'confirm', added: 1, memories: false, hiddenAnswers: 0, earlierFiles: 2, confirmKey: 'k2', provenance: null }
    let closed = 0
    routesWith(audience(), (body) => (body as { confirmKey?: string }).confirmKey === 'k2' ? json(200, { status: 'saved', chat: chatOut, audience: audience([{ subjectType: 'user', subjectId: 'bob', name: 'Bob' }]), filesNotCopied: 1 }) : json(200, confirm))
    useUi.setState({ toasts: [] })
    const m = await open(() => closed++)
    await addBob(m)
    await m.click('chat-share-save')
    const line = await m.until(() => m.find('chat-share-earlier-files'), 'the files line', 2000)
    expect(line.textContent).toBe(en('chat.share.earlierFiles', { n: 2 }))
    expect(en('chat.share.earlierFiles', { n: 2 })).toBe('2 files you attached will be visible to them.')
    // no warning about the people, so the note is the whole one
    expect(m.find('chat-share-warning')).toBeNull()
    expect(m.get('chat-share-note').textContent).toBe(en('chat.share.note'))
    expect(m.get('chat-share-save').textContent).toBe(en('chat.share.shareAnyway'))
    await m.click('chat-share-save')
    await m.until(() => closed === 1, 'shared', 2000)
    expect(useUi.getState().toasts.map((t) => [t.level, t.text])).toContainEqual(['warn', en('chat.share.filesNotCopied', { n: 1 })])
    useUi.setState({ toasts: [] })
    await m.unmount()
  })

  test('a group picked: whoever joins it later sees it too', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role: 'member' }, groups: [{ id: 'g1', name: 'Sales' }], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
    routesWith(audience())
    const m = await open()
    expect(m.find('chat-share-future-group')).toBeNull()
    await m.type('chat-share-picker-search', 'sales')
    await m.click(await m.until(() => m.find('participant-add-group-g1'), 'Sales to add', 2000))
    expect((await m.until(() => m.find('chat-share-future-group'), 'the line', 2000)).textContent).toBe(en('chat.share.futureGroup'))
    await m.unmount()
  })
})

describe('not mine to change, or not here', () => {
  test('someone else\'s shared chat: who is in it, no search, no ✕, who can change it, Close', async () => {
    routesWith(audience([{ subjectType: 'user', subjectId: 'mia', name: 'Mia' }, SORA], { canEdit: false, by: { id: 'bob', name: 'Bob' } }))
    let closed = 0
    const m = await mount(<MemoryRouter><ChatShareDialog chat={chat} onClose={() => closed++} /></MemoryRouter>)
    await m.until(() => m.find('participant-user-sora'), 'the rows', 2000)
    expect(m.find('chat-share-picker-search')).toBeNull()
    expect(m.find('participant-remove-user-sora')).toBeNull()
    expect(m.get('chat-share-read-only').textContent).toBe(en('chat.share.readOnly', { name: 'Bob' }))
    expect(m.find('chat-share-save')).toBeNull()
    await m.click('chat-share-close')
    expect(closed).toBe(1)
    await m.unmount()
  })

  test('a personal project: why, and Move…', async () => {
    routes = { 'GET /api/projects': () => json(200, { items: [] }) }
    const m = await mount(<MemoryRouter><ChatShareDialog chat={{ ...chat, projectId: '01900000-0000-7000-8000-0000000000a1' }} personal onClose={() => {}} /></MemoryRouter>)
    expect(m.get('chat-share-personal').textContent).toContain(en('chat.share.personalProject'))
    expect(sent.some((x) => x.key === `GET ${AUD}`)).toBe(false)
    await m.click('chat-share-move')
    await m.until(() => m.find('chat-project-save'), 'the move dialog', 2000)
    await m.unmount()
  })
})

describe('QA 11-15: kept through a group, the focus, the live line', () => {
  const SALES = { subjectType: 'group' as const, subjectId: 'g1', name: 'Sales', members: 3 }
  test('taking someone out by name who is in a picked group says they keep access through it, and the save says it again (TC-2264)', async () => {
    let closed = 0
    routesWith(audience([{ ...SORA, inGroups: ['g1'] }, SALES]), () => json(200, { status: 'saved', chat: chatOut, audience: audience([SALES]), keptThrough: [{ name: 'Sora', groups: ['Sales'] }] }))
    useUi.setState({ toasts: [] })
    const m = await open(() => closed++)
    await m.until(() => m.find('participant-user-sora'), 'Sora', 2000)
    expect(m.find('chat-share-keeps-through')).toBeNull()
    await m.click('participant-remove-user-sora')
    const line = await m.until(() => m.find('chat-share-keeps-through'), 'the kept line', 2000)
    expect(line.textContent).toBe(en('chat.share.keepsThrough', { name: 'Sora', groups: 'Sales' }))
    expect(en('chat.share.keepsThrough', { name: 'Sora', groups: 'Sales' })).toBe('Sora keeps access through Sales.')
    // read out too
    expect(m.get('chat-share-live').textContent).toContain('Sora keeps access through Sales.')
    // the group taken out as well: nothing keeps her in
    await m.click('participant-remove-group-g1')
    await m.until(() => !m.find('chat-share-keeps-through'), 'no kept line', 2000)
    await m.click('participant-undo-group-g1')
    await m.until(() => m.find('chat-share-keeps-through'), 'the kept line again', 2000)
    await m.click('chat-share-save')
    await m.until(() => closed === 1, 'saved', 2000)
    expect(useUi.getState().toasts.map((t) => t.text)).toContainEqual('Sora keeps access through Sales.')
    useUi.setState({ toasts: [] })
    await m.unmount()
  })

  test('the check\'s warning is in a polite live region (TC-2271)', async () => {
    const confirm: PutChatAudienceResult = { status: 'confirm', added: 1, memories: false, hiddenAnswers: 0, confirmKey: 'k3', provenance: { people: 1, places: [{ kind: 'mine' }], otherPlaces: false } }
    routesWith(audience(), () => json(200, confirm))
    const m = await open()
    const live = m.get('chat-share-live')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe('')
    await addBob(m)
    await m.click('chat-share-save')
    const warning = await m.until(() => m.find('chat-share-warning'), 'the warning', 2000)
    expect(m.get('chat-share-live').textContent).toBe(warning.textContent)
    await m.unmount()
  })

  test('after Discard the focus goes back to what opened it (TC-2271)', async () => {
    routesWith(audience())
    let closed = 0
    const trigger = document.createElement('button')
    trigger.textContent = 'Share'
    document.body.appendChild(trigger)
    // opened from a menu item, which goes with its menu: focus must not fall back to it (or to the page)
    const item = document.createElement('button')
    document.body.appendChild(item)
    item.focus()
    const m = await mount(<MemoryRouter initialEntries={[`/c/${C1}`]}><ChatShareDialog chat={chat} returnTo={trigger} onClose={() => closed++} /><DialogHost /></MemoryRouter>)
    document.body.removeChild(item)
    await m.until(() => m.find('participant-user-mia'), 'the creator\'s row', 2000)
    await addBob(m)
    await m.click('chat-share-cancel')
    await m.click(await m.until(() => m.find('dialog-confirm'), 'the discard ask', 2000))
    await m.until(() => closed === 1, 'closed', 2000)
    await m.unmount()
    expect(document.activeElement).toBe(trigger)
    document.body.removeChild(trigger)
  })
})
