// The Share dialog of a chat outside projects (components/chat/ChatShareDialog.tsx; docs/DECISIONS.md "Chats shared
// with people and groups", QA TC-1405), every exit:
// - nothing changed: Save is off, ✕ closes at once (no ask);
// - a pick: "new" on its row, Save (Share while not shared yet); ✕ asks "Discard changes?": Keep editing keeps the
//   pick, Discard closes;
// - ✕ on a saved row strikes it out with Undo; Undo puts it back and Save is off again;
// - a failed save keeps the picks with the error above the button; a refusal says the server's words;
// - one press (QA TC-3092): the preview after every change of the picks while someone is being added (Share off until
//   it is here), what is at stake in place, the button never changes, Share sends the preview's key; nothing at stake:
//   no box; answers nobody could check: one grey line; a failed preview: a grey line, and the server's check in place
//   after the press, then Share again; the widening line opens the list with the chat as its target;
// - someone else's shared chat: read only, who can change it; a personal project: why, and Move.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { ChatAudience, PutChatAudienceResult, ShareCheck } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ChatShareDialog } from '../../src/components/chat/ChatShareDialog'
import { whoNames } from '../../src/components/ShareWarning'
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
/** the warning's one line: what is at stake, then the places after " · " */
const summary = (names: string, ...sources: string[]) => `${en('share.warn.summary', { names })} · ${sources.join(', ')}`
const AUD = `/api/chats/${C1}/audience`
const PREVIEW = `POST ${AUD}/preview`
const NOTHING: ShareCheck = { added: 1, memoryAnswers: 0, fileAnswers: 0, accountAnswers: 0, places: [], otherPlaces: false, roomsUnseen: false, unchecked: 0 }
/** the preview's key: one per list of picks */
const keyFor = (subjects: { subjectId: string }[]) => 'pk:' + subjects.map((x) => x.subjectId).sort().join(',')
const routesWith = (a: ChatAudience, put?: (body: unknown) => Response, check: (body: unknown) => ShareCheck = () => NOTHING) => {
  routes = {
    'GET /api/people': () => json(200, PEOPLE),
    [`GET ${AUD}`]: () => json(200, a),
    [PREVIEW]: (body) => json(200, { check: check(body), previewKey: keyFor((body as { subjects: { subjectId: string }[] }).subjects) }),
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
/** the preview of these picks is here: Share is on */
const ready = (m: Mounted) => m.until(() => !m.get('chat-share-save').hasAttribute('disabled'), 'Share on', 3000)

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

  test('a guest is never added (a chat shared with people is no place of theirs): found, greyed out with why (QA TC-7284); a member is', async () => {
    routesWith(audience())
    routes['GET /api/people'] = () => json(200, { people: [...PEOPLE.people, { id: 'gina', name: 'Gina Park', guest: true, guestPlaces: [{ kind: 'room', id: 'r1', name: 'Quote prep' }] }] })
    const m = await open()
    await m.type('chat-share-picker-search', 'park')
    expect(m.find('participant-add-user-gina')).toBeNull()
    const row = await m.until(() => m.find('participant-elsewhere-user-gina'), 'the guest greyed out', 2000)
    expect(row.textContent).toContain(en('chat.share.guestNo'))
    await m.type('chat-share-picker-search', 'bob')
    expect(await m.until(() => m.find('participant-add-user-bob'), 'Bob to add', 2000)).toBeTruthy()
    await m.unmount()
  })

  test('a pick: new, Share on; ✕ asks; Keep editing keeps it; Discard closes', async () => {
    routesWith(audience())
    let closed = 0
    const m = await open(() => closed++)
    await addBob(m)
    await ready(m)
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
    expect(en('chat.share.onlyYou')).toBe('Only you will see this chat and its files. People who were in it lose both.')
    // one state, one message (QA TC-6951): no "Everyone here sees…" note and no Copy link for a chat only I will see
    expect(m.find('chat-share-note')).toBeNull()
    expect(m.find('chat-share-copy-link')).toBeNull()
    expect(m.get('chat-share-save').hasAttribute('disabled')).toBe(false)
    await m.click('participant-undo-user-sora')
    expect(m.get('participant-user-sora').getAttribute('data-state')).toBe('member')
    expect(m.find('chat-share-only-you')).toBeNull()
    expect(m.find('chat-share-note')).not.toBeNull()
    expect(m.find('chat-share-copy-link')).not.toBeNull()
    expect(m.get('chat-share-save').hasAttribute('disabled')).toBe(true)
    await m.unmount()
  })

  test('saving everyone out: the saved toast has no Copy link (QA TC-6951)', async () => {
    const { shared: _, ...mine } = chatOut
    routesWith(audience([SORA]), () => json(200, { status: 'saved', chat: mine, audience: audience() }))
    useUi.setState({ toasts: [] })
    let closed = 0
    const m = await open(() => closed++)
    try {
      await m.until(() => m.find('participant-user-sora'), 'Sora', 2000)
      await m.click('participant-remove-user-sora')
      await m.click('chat-share-save')
      await m.until(() => closed === 1, 'closed', 2000)
      const t = useUi.getState().toasts.at(-1)!
      expect(t.text).toBe(en('chat.share.saved'))
      expect(t.action).toBeUndefined()
    } finally { await m.unmount() }
  })

  test('the files step: one checkbox, unticked; Save stays off until it is ticked, then saves the files alone with their key', async () => {
    const files = { madeFiles: [{ name: 'summary.md', place: 'My files › QA22', size: 120 }], madeFilesKey: 'mk' }
    routesWith(audience([SORA], files), () => json(200, { status: 'saved', chat: chatOut, audience: audience([SORA]), filesAdded: 1 }))
    let closed = 0
    const m = await open(() => closed++)
    try {
      await m.until(() => m.find('chat-share-files-step'), 'the files step', 2000)
      expect(m.get('chat-share-files-step').textContent).toContain(en('chat.shareFiles.include', { n: 1 }))
      expect(m.get('chat-share-files-hint').textContent).toBe(en('chat.shareFiles.hint'))
      // the copies going with the chat: the hint's tooltip, not more text in the dialog
      expect(m.get('chat-share-files-hint').getAttribute('title')).toBe(en('chat.shareFiles.keep'))
      // one footer: Copy link, Cancel, Save; no "Share without files" / "Share with files"
      for (const id of ['chat-share-with-files', 'chat-share-without-files']) expect(m.find(id)).toBeNull()
      expect(m.find('chat-share-copy-link')).not.toBeNull()
      expect((m.get('chat-share-files-check') as unknown as { checked: boolean }).checked).toBe(false)
      expect(m.get('chat-share-save').hasAttribute('disabled')).toBe(true)
      // a browser checks the box before the click's listeners run, past React's value tracker (this small DOM does not)
      const box = m.get('chat-share-files-check')
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'checked')!.set!.call(box, true)
      await m.click(box)
      await m.until(() => !m.get('chat-share-save').hasAttribute('disabled'), 'Save on once ticked', 2000)
      await m.click('chat-share-save')
      await m.until(() => closed === 1, 'closed', 2000)
      const put = sent.find((x) => x.key === `PUT ${AUD}`)!.body as { withFiles?: boolean; confirmKey?: string }
      expect(put.withFiles).toBe(true)
      expect(put.confirmKey).toBe('mk')
    } finally { await m.unmount() }
  })

  test('adding someone with the files unticked: Share saves the picks without them', async () => {
    const madeFiles = [{ name: 'summary.md', place: 'My files › QA22', size: 120 }]
    routesWith(audience(), undefined, () => ({ ...NOTHING, madeFiles }))
    let closed = 0
    const m = await open(() => closed++)
    try {
      await addBob(m)
      await m.until(() => m.find('chat-share-files-step'), 'the files step', 3000)
      await ready(m)
      await m.click('chat-share-save')
      await m.until(() => closed === 1, 'closed', 2000)
      const put = sent.find((x) => x.key === `PUT ${AUD}`)!.body as { withFiles?: boolean }
      expect(put.withFiles).toBeUndefined()
    } finally { await m.unmount() }
  })

  test('ticked while adding someone: Share sends the files with the preview\'s key; a change of the people unticks it; nobody in it: no box', async () => {
    const madeFiles = [{ name: 'summary.md', place: 'My files › QA22', size: 120 }]
    routesWith(audience([], { madeFiles, madeFilesKey: 'mk' }), undefined, () => ({ ...NOTHING, madeFiles }))
    let closed = 0
    const m = await open(() => closed++)
    const tickBox = async () => {
      const box = m.get('chat-share-files-check')
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'checked')!.set!.call(box, true)
      await m.click(box)
    }
    try {
      // a chat never shared, nobody picked: no files box, so a tick can't turn Share on
      expect(m.find('chat-share-files-step')).toBeNull()
      expect(m.get('chat-share-save').hasAttribute('disabled')).toBe(true)
      await addBob(m)
      await m.until(() => m.find('chat-share-files-step'), 'the files step', 3000)
      await ready(m)
      await tickBox()
      await m.until(() => (m.get('chat-share-files-check') as unknown as { checked: boolean }).checked, 'ticked', 2000)
      // Sora too: a new list of people, the box unticked again (once the new check lists the files)
      await m.type('chat-share-picker-search', 'sora')
      await m.click(await m.until(() => m.find('participant-add-user-sora'), 'Sora to add', 2000))
      await ready(m)
      await m.until(() => { const b = m.find('chat-share-files-check') as unknown as { checked: boolean } | null; return !!b && !b.checked }, 'unticked', 2000)
      await m.click('participant-remove-user-sora')
      await ready(m)
      await tickBox()
      await m.until(() => (m.get('chat-share-files-check') as unknown as { checked: boolean }).checked, 'ticked again', 2000)
      await m.click('chat-share-save')
      await m.until(() => closed === 1, 'closed', 2000)
      const put = sent.find((x) => x.key === `PUT ${AUD}`)!.body as { withFiles?: boolean; confirmKey?: string; subjects: { subjectId: string }[] }
      expect(put.withFiles).toBe(true)
      expect(put.confirmKey).toBe('pk:bob')
      expect(put.subjects.map((x) => x.subjectId)).toEqual(['bob'])
    } finally { await m.unmount() }
  })

  test('the ✕ tooltip\'s words: removing does not take back what they saw (the tooltip itself: e2e share-chat-people)', () => {
    expect(en('chat.share.removeTip')).toBe("What they've already seen stays seen.")
    expect(translate('ko', 'chat.share.removeTip')).toBe('이미 본 내용은 되돌릴 수 없어요.')
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
    await ready(m)
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

  test('one press: what is at stake shows while picking, the button stays Share and sends the preview\'s key; the list is the chat\'s', async () => {
    const stake: ShareCheck = { ...NOTHING, memoryAnswers: 2, fileAnswers: 3, places: [{ kind: 'mine' }] }
    let closed = 0
    routesWith(audience(), (body) => (body as { confirmKey?: string }).confirmKey === 'pk:bob' ? json(200, { status: 'saved', chat: chatOut, audience: audience([{ subjectType: 'user', subjectId: 'bob', name: 'Bob' }]) }) : json(500, {}), () => stake)
    const m = await open(() => closed++)
    await addBob(m)
    // in place, before any press: one line naming every place, the one short note, the button as it was
    const warning = await m.until(() => m.find('chat-share-warning'), 'the warning', 3000)
    expect(m.get('chat-share-warning-lines').textContent).toBe(summary('Bob', en('share.src.memories'), en('share.src.files'), en('shareRoom.placeMineFiles')))
    expect(warning.textContent).toContain("Some answers used places Bob can't open · your personal memories, files, ")
    expect(m.get('chat-share-note').textContent).toBe(en('chat.share.note'))
    expect(en('chat.share.note')).toBe('People you add see the whole chat, from the start, and can ask the AI in it.')
    expect(m.get('chat-share-save').textContent).toBe(en('chat.share.share'))
    expect(m.get('chat-share-save').className).not.toMatch(/danger/)
    // the list, about this chat
    await m.click('chat-share-warning-show')
    await m.until(() => m.find('widening-list'), 'the list', 2000)
    expect((sent.find((x) => x.key === 'POST /api/sharing/widening-answers')!.body as { target: unknown }).target).toEqual({ kind: 'chat', chatId: C1 })
    expect(m.get('widening-list-title').textContent).toBe(en('share.widenList.title', { names: 'Bob' }))
    await m.click('widening-list-back')
    await m.until(() => m.find('chat-share-save'), 'back to the picks', 2000)
    // one press
    await m.click('chat-share-save')
    await m.until(() => closed === 1, 'shared', 2000)
    const puts = sent.filter((x) => x.key === `PUT ${AUD}`)
    expect(puts.length).toBe(1)
    expect((puts[0]!.body as { confirmKey?: string }).confirmKey).toBe('pk:bob')
    await m.unmount()
  })

  test('add two, remove one: asked again after every change, Share off until the answer for these picks, still one press', async () => {
    let closed = 0
    let release: (() => void) | null = null
    routesWith(audience(), (body) => (body as { confirmKey?: string }).confirmKey === keyFor((body as { subjects: { subjectId: string }[] }).subjects) ? json(200, { status: 'saved', chat: chatOut, audience: audience([{ subjectType: 'user', subjectId: 'bob', name: 'Bob' }]) }) : json(200, { status: 'confirm', check: NOTHING, confirmKey: 'x', reason: 'changed' }))
    const preview = routes[PREVIEW]!
    const m = await open(() => closed++)
    await addBob(m)
    // Share is off from the first change, during the wait too
    expect(m.get('chat-share-save').hasAttribute('disabled')).toBe(true)
    await ready(m)
    await m.type('chat-share-picker-search', 'sora')
    await m.click(await m.until(() => m.find('participant-add-user-sora'), 'Sora to add', 2000))
    expect(m.get('chat-share-save').hasAttribute('disabled')).toBe(true)
    await ready(m)
    // a removal asks again too: the answer is held, and Share stays off until it comes
    routes[PREVIEW] = (body) => { const r = preview(body); return new Promise<Response>((res) => { release = () => res(r) }) as unknown as Response }
    await m.click('participant-remove-user-sora')
    expect(m.get('chat-share-save').hasAttribute('disabled')).toBe(true)
    await m.until(() => release !== null, 'the preview asked', 3000)
    expect(m.get('chat-share-save').hasAttribute('disabled')).toBe(true)
    release!()
    await ready(m)
    const previews = sent.filter((x) => x.key === PREVIEW).map((x) => keyFor((x.body as { subjects: { subjectId: string }[] }).subjects))
    expect(previews).toEqual(['pk:bob', 'pk:bob,sora', 'pk:bob'])
    await m.click('chat-share-save')
    await m.until(() => closed === 1, 'shared in one press', 2000)
    expect(sent.filter((x) => x.key === `PUT ${AUD}`).map((x) => (x.body as { confirmKey?: string }).confirmKey)).toEqual(['pk:bob'])
    await m.unmount()
  })

  test('nothing at stake: no box, the full note, one press; only answers nobody could check: one grey line, no box', async () => {
    let closed = 0
    let check = NOTHING
    routesWith(audience(), undefined, () => check)
    let m = await open(() => closed++)
    await addBob(m)
    await ready(m)
    expect(m.find('chat-share-warning')).toBeNull()
    expect(m.find('chat-share-grey')).toBeNull()
    expect(m.get('chat-share-note').textContent).toBe(en('chat.share.note'))
    await m.unmount()
    check = { ...NOTHING, unchecked: 4 }
    m = await open(() => closed++)
    await addBob(m)
    await ready(m)
    expect(m.find('chat-share-warning')).toBeNull()
    expect(m.get('chat-share-grey').textContent).toBe(en('share.grey.unchecked', { n: 4 }))
    expect(en('share.grey.unchecked', { n: 4 })).toBe("4 older answers couldn't be checked.")
    expect(m.get('chat-share-save').textContent).toBe(en('chat.share.share'))
    await m.click('chat-share-save')
    await m.until(() => closed === 1, 'shared', 2000)
    await m.unmount()
  })

  test('the preview failed: a grey line, Share still on; the server answers with the check in place, then Share again', async () => {
    let closed = 0
    routesWith(audience(), (body) => (body as { confirmKey?: string }).confirmKey === 'k-check' ? json(200, { status: 'saved', chat: chatOut, audience: audience([{ subjectType: 'user', subjectId: 'bob', name: 'Bob' }]) }) : json(200, { status: 'confirm', check: { ...NOTHING, accountAnswers: 2, roomsUnseen: true }, confirmKey: 'k-check', reason: 'unchecked' } satisfies PutChatAudienceResult))
    routes[PREVIEW] = () => json(503, { error: { code: 'unavailable', message: 'down' } })
    const m = await open(() => closed++)
    await addBob(m)
    await ready(m)
    expect(m.get('chat-share-grey').textContent).toBe(en('share.grey.failed'))
    // never a silent share: the first press gets the check
    await m.click('chat-share-save')
    const warning = await m.until(() => m.find('chat-share-warning'), 'the check in place', 2000)
    expect(warning.textContent).toContain(summary('Bob', en('share.src.accounts'), en('share.src.rooms')))
    expect(m.get('chat-share-changed').textContent).toBe(en('share.again'))
    expect(m.get('chat-share-save').textContent).toBe(en('chat.share.share'))
    expect(closed).toBe(0)
    await m.click('chat-share-save')
    await m.until(() => closed === 1, 'shared', 2000)
    expect(sent.filter((x) => x.key === `PUT ${AUD}`).map((x) => (x.body as { confirmKey?: string }).confirmKey)).toEqual([undefined, 'k-check'])
    await m.unmount()
  })

  test('something changed since the preview: the new check in place, said so, Share again', async () => {
    let closed = 0
    routesWith(audience(), (body) => (body as { confirmKey?: string }).confirmKey === 'k-new' ? json(200, { status: 'saved', chat: chatOut, audience: audience([{ subjectType: 'user', subjectId: 'bob', name: 'Bob' }]) }) : json(200, { status: 'confirm', check: { ...NOTHING, fileAnswers: 1 }, confirmKey: 'k-new', reason: 'changed' } satisfies PutChatAudienceResult))
    const m = await open(() => closed++)
    await addBob(m)
    await ready(m)
    await m.click('chat-share-save')
    await m.until(() => m.find('chat-share-changed'), 'changed', 2000)
    expect(m.get('chat-share-changed').textContent).toBe(en('chat.shareChat.changed'))
    expect(m.get('chat-share-warning').textContent).toContain(summary('Bob', en('share.src.files')))
    await m.click('chat-share-save')
    await m.until(() => closed === 1, 'shared', 2000)
    await m.unmount()
  })

  test('a first share: the files I attached will be visible to them (a grey line, no box); what could not go is said after', async () => {
    let closed = 0
    routesWith(audience(), () => json(200, { status: 'saved', chat: chatOut, audience: audience([{ subjectType: 'user', subjectId: 'bob', name: 'Bob' }]), filesNotCopied: 1 }), () => ({ ...NOTHING, earlierFiles: 2 }))
    useUi.setState({ toasts: [] })
    const m = await open(() => closed++)
    await addBob(m)
    await ready(m)
    expect(m.get('chat-share-files').textContent).toBe(en('chat.share.earlierFiles', { n: 2 }))
    expect(m.find('chat-share-grey')).toBeNull()
    expect(en('chat.share.earlierFiles', { n: 2 })).toBe('2 files you attached will be visible to them.')
    expect(m.find('chat-share-warning')).toBeNull()
    expect(m.get('chat-share-note').textContent).toBe(en('chat.share.note'))
    await m.click('chat-share-save')
    await m.until(() => closed === 1, 'shared', 2000)
    expect(useUi.getState().toasts.map((t) => [t.level, t.text])).toContainEqual(['warn', en('chat.share.filesNotCopied', { n: 1 })])
    // one file is "it", more are "them" (QA TC-2022)
    expect(en('chat.share.filesNotCopied', { n: 1 })).toMatch(/^1 file you attached earlier wasn't shared .*Only you can open it\.$/)
    expect(en('chat.share.filesNotCopied', { n: 2 })).toMatch(/^2 files .*Only you can open them\.$/)
    useUi.setState({ toasts: [] })
    await m.unmount()
  })

  test('my earlier files always have a line of their own under a warning (security review); answers nobody could check go in the box', async () => {
    let closed = 0
    routesWith(audience(), undefined, () => ({ ...NOTHING, earlierFiles: 3, unchecked: 2, memoryAnswers: 1 }))
    const m = await open(() => closed++)
    await addBob(m)
    await ready(m)
    expect(m.get('chat-share-warning-lines').textContent).toBe(summary('Bob', en('share.src.memories')))
    // with a box, its short second line (no grey line of its own)
    expect(m.get('chat-share-warning-unchecked').textContent).toBe(en('share.grey.unchecked', { n: 2 }))
    expect(m.find('chat-share-grey')).toBeNull()
    expect(m.get('chat-share-files').textContent).toBe(en('chat.share.earlierFiles', { n: 3 }))
    expect(m.get('chat-share-live').textContent).toContain(en('share.grey.unchecked', { n: 2 }))
    // read out too
    expect(m.get('chat-share-live').textContent).toContain(en('chat.share.earlierFiles', { n: 3 }))
    await m.click('chat-share-save')
    await m.until(() => closed === 1, 'shared', 2000)
    await m.unmount()
  })

  test('one line, no bullets, "Show answers" after it; names with the language\'s honorific', async () => {
    routesWith(audience(), undefined, () => ({ ...NOTHING, memoryAnswers: 2, fileAnswers: 1, places: [{ kind: 'mine' }] }))
    const m = await open()
    await addBob(m)
    await ready(m)
    const items = [...m.get('chat-share-warning-lines').querySelectorAll('li')].map((li) => li.textContent)
    expect(items).toEqual([summary('Bob', en('share.src.memories'), en('share.src.files'), en('shareRoom.placeMineFiles'))])
    expect(m.get('chat-share-warning-lines').className).not.toContain('list-disc')
    // "Show answers" comes after the lines, inside the box
    const html = m.html()
    expect(html.indexOf('data-testid="chat-share-warning-show"')).toBeGreaterThan(html.indexOf('data-testid="chat-share-warning-lines"'))
    expect(m.get('chat-share-warning').querySelector('[data-testid="chat-share-warning-show"]')).toBeTruthy()
    // Korean: a person takes 님 ("Bob 님이", "Bob 님은"); a group never does, it reads as its people ("Sales 부서 사람들이");
    // no 이(가) / 은(는) left on screen; the project's members read "일부 프로젝트 멤버가"
    const ko = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars)
    const kt = ((key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => ko(key, vars)) as Parameters<typeof whoNames>[0]
    const bob = whoNames(kt, [{ subjectType: 'user', name: 'Bob' }])
    const sales = whoNames(kt, [{ subjectType: 'group', name: 'Sales' }])
    const both = whoNames(kt, [{ subjectType: 'user', name: 'Bob' }, { subjectType: 'group', name: 'Sales' }])
    expect(bob).toBe('Bob 님')
    expect(sales).toBe('Sales 부서 사람들')
    expect(sales).not.toContain('님')
    expect(ko('share.warn.summary', { names: bob })).toBe('Bob 님이 못 여는 곳을 참고한 답이 있어요')
    expect(ko('chat.shareFiles.hint')).toBe('채팅에 사본이 생겨요. 원본은 그대로예요.')
    expect(ko('share.warn.summary', { names: sales })).toBe('Sales 부서 사람들이 못 여는 곳을 참고한 답이 있어요')
    expect(ko('share.warn.files', { n: 1, names: bob })).toBe('답 1개가 Bob 님이 열 수 없는 파일을 참고했어요.')
    expect(ko('share.warn.places', { places: '내 파일', names: bob })).toBe('이 채팅은 내 파일도 참고했어요. Bob 님은 열 수 없는 곳이에요.')
    expect(ko('share.warn.files', { n: 1, names: sales })).toBe('답 1개가 Sales 부서 사람들이 열 수 없는 파일을 참고했어요.')
    expect(ko('share.warn.places', { places: '내 파일', names: sales })).toBe('이 채팅은 내 파일도 참고했어요. Sales 부서 사람들은 열 수 없는 곳이에요.')
    expect(ko('share.warn.rooms', { names: sales })).toBe('이 채팅은 Sales 부서 사람들이 없을 수도 있는 채널을 읽었어요.')
    expect(ko('share.warn.files', { n: 1, names: both })).toBe('답 1개가 Bob 님, Sales 부서 사람들이 열 수 없는 파일을 참고했어요.')
    expect(ko('share.widenList.title', { names: sales })).toBe('Sales 부서 사람들이 보게 될 답')
    expect(ko('chat.share.widen', { n: 2, names: both })).toContain('Bob 님, Sales 부서 사람들이 열 수 없는 곳')
    expect(ko('share.warn.files', { n: 1, names: ko('share.who.project') })).toBe('답 1개가 일부 프로젝트 멤버가 열 수 없는 파일을 참고했어요.')
    // a name with its own 님 does not get a second one
    expect(whoNames(kt, [{ subjectType: 'user', name: '김대표님' }])).toBe('김대표님')
    // names the server sends without saying person or group: no particle to choose
    expect(ko('share.widenList.whoMisses', { names: 'Sales, Bob' })).toBe('열 수 없는 사람: Sales, Bob')
    expect(ko('chat.share.sharedWith', { names: 'Sales, Bob' })).toBe('공유 대상: Sales, Bob')
    // English: names as picked
    const enT = ((key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => en(key, vars)) as Parameters<typeof whoNames>[0]
    expect(whoNames(enT, [{ subjectType: 'user', name: 'Bob' }, { subjectType: 'group', name: 'Sales' }])).toBe(en('share.who.person', { name: 'Bob' }) + en('rooms.nameSep') + 'Sales')
    await m.unmount()
  })

  test('a group picked: whoever joins it later sees it too', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role: 'member' }, groups: [{ id: 'g1', name: 'Sales' }], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
    routesWith(audience())
    const m = await open()
    expect(m.find('chat-share-grey')).toBeNull()
    await m.type('chat-share-picker-search', 'sales')
    await m.click(await m.until(() => m.find('participant-add-group-g1'), 'Sales to add', 2000))
    await ready(m)
    expect(m.get('chat-share-grey').textContent).toBe(en('chat.share.futureGroup'))
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

  test('someone else\'s shared chat: "Leave this chat" asks first, then leaves (QA TC-7651)', async () => {
    routesWith(audience([{ subjectType: 'user', subjectId: 'mia', name: 'Mia' }, SORA], { canEdit: false, by: { id: 'bob', name: 'Bob' } }))
    routes[`POST /api/chats/${C1}/leave`] = () => json(200, { ok: true })
    let closed = 0
    const m = await mount(<MemoryRouter initialEntries={['/']}><ChatShareDialog chat={chat} onClose={() => closed++} /><DialogHost /></MemoryRouter>)
    await m.until(() => m.find('chat-share-leave'), 'Leave', 2000)
    await m.click('chat-share-leave')
    expect(closed).toBe(1)
    await m.until(() => m.find('dialog-confirm'), 'the ask', 2000)
    expect(m.container.ownerDocument!.body.textContent).toContain(en('chat.leaveBody', { name: 'Bob' }))
    expect(sent.some((x) => x.key === `POST /api/chats/${C1}/leave`)).toBe(false)
    await m.click('dialog-confirm')
    await m.until(() => sent.some((x) => x.key === `POST /api/chats/${C1}/leave`), 'the leave', 2000)
    await m.unmount()
  })

  test('a personal project: why, and Move', async () => {
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
    routesWith(audience(), undefined, () => ({ ...NOTHING, places: [{ kind: 'mine' }] }))
    const m = await open()
    const live = m.get('chat-share-live')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe('')
    await addBob(m)
    const warning = await m.until(() => m.find('chat-share-warning'), 'the warning', 3000)
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
