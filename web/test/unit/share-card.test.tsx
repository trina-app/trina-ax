// The AI share card (components/chat/ShareCard.tsx, lib/shareCard.ts; docs/decisions/20261116-ai-share-card-and-stop.md):
// its words come from the server's record alone, in the plan's copy; the confirmation card (AskCard) shows the same rows
// and answers with the server's values; the result card's one button is Manage access after a share (the file's Share
// dialog) and Undo after a stop (the same people added again through the dialog's endpoint, then the card says so); a
// refusal has no button unless a next step was registered for its kind; no path is ever on the card.
import { useState } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { ShareCardState, StepShared, TurnRequest } from '@mycel/shared/api'
import AskCard from '../../src/components/chat/AskCard'
import ShareCard, { registerShareNext, ShareAskRows } from '../../src/components/chat/ShareCard'
import { FileShareHost } from '../../src/components/FileShareDialog'
import { askHeadline, isRestored, shareHeadline, shareNotes } from '../../src/lib/shareCard'
import { translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { installDom, mount, removeDom } from './dom-host'

const t = (key: MessageKey, params?: Record<string, string | number>) => translate('en', key, params)
const L1 = 'aaaaaaaaaaaaaaaaaaaaa1', L2 = 'aaaaaaaaaaaaaaaaaaaaa2', L3 = 'aaaaaaaaaaaaaaaaaaaaa3', L4 = 'aaaaaaaaaaaaaaaaaaaaa4'
const jun = { subjectType: 'user' as const, subjectId: 'jun', name: 'Jun' }
const sales = { subjectType: 'group' as const, subjectId: 'g-sales', name: 'Sales', members: 6 }
const file = (linkId: string, name: string) => ({ linkId, name, place: 'My files › Work' })
const sharedOne: StepShared = { op: 'share', outcome: 'done', files: [file(L1, 'Quote.pdf')], who: [jun], level: 'view', notified: ['jun'] }
const sharedMany: StepShared = { op: 'share', outcome: 'done', files: [file(L1, 'Quote.pdf'), file(L2, 'Budget.xlsx'), file(L3, 'Notes.docx'), file(L4, 'Plan.md')], who: [jun], level: 'view', notified: ['jun'] }
const stopped: StepShared = { op: 'stop', outcome: 'done', files: [file(L1, 'Quote.pdf')], who: [jun], level: 'view', still: [{ userId: 'jun', name: 'Jun', through: 'group', group: 'Sales', files: 1 }] }
const refused: StepShared = { op: 'share', outcome: 'refused', files: [], failed: [{ linkId: L1, name: 'Quote.xlsx', place: 'Team folder › Sales' }], who: [], level: 'view', refusal: { reason: 'not_owner', file: 'Quote.xlsx', owner: 'Mina' }, next: { kind: 'ask_owner', linkId: L1, userId: 'mina', name: 'Mina' } }

test('the words, from the record alone (the plan\'s copy)', () => {
  expect(askHeadline(t, 'en', { op: 'share', files: [file(L1, 'Quote.pdf')], who: [jun] })).toBe('Share Quote.pdf with Jun?')
  expect(askHeadline(t, 'en', { op: 'stop', files: sharedMany.files, who: [jun] })).toBe('Stop sharing 4 files with Jun?')
  expect(shareHeadline(t, 'en', sharedOne)).toBe('Shared Quote.pdf with Jun')
  expect(shareNotes(t, 'en', sharedOne)).toEqual(['Jun got a notification.'])
  // several files: one card
  expect(shareHeadline(t, 'en', sharedMany)).toBe('Shared 4 files with Jun: Quote.pdf, Budget.xlsx, Notes.docx and 1 more')
  // a group, with its size; new members get it too; the people told are counted
  const group: StepShared = { op: 'share', outcome: 'done', files: [file(L1, 'Q4 plan.md')], who: [sales], level: 'view', notified: ['a', 'b', 'c'] }
  expect(shareHeadline(t, 'en', group)).toBe('Shared Q4 plan.md with the Sales group (6 people)')
  expect(shareNotes(t, 'en', group)).toEqual(['New members of the group get it too.', '3 people got a notification.'])
  // a stop, and who can still open it through what
  expect(shareHeadline(t, 'en', stopped)).toBe('Stopped sharing Quote.pdf with Jun')
  expect(shareNotes(t, 'en', stopped)).toEqual(['Jun can still open it through the Sales group.'])
  expect(shareNotes(t, 'en', { ...stopped, files: [file(L1, 'a'), file(L2, 'b'), file(L3, 'c')], still: [{ userId: 'jun', name: 'Jun', through: 'group', group: 'Sales', files: 2 }], stillMore: 1 }))
    .toEqual(['Jun can still open 2 files through the Sales group.', '1 more person can still open it.'])
  expect(shareNotes(t, 'en', { ...stopped, still: [{ userId: 'jun', name: 'Jun', through: 'folder', files: 1 }] })).toEqual(['Jun can still open it because they can open its folder.'])
  // a refusal: what, and why with whose file it is
  expect(shareHeadline(t, 'en', refused)).toBe("Couldn't share Quote.xlsx.")
  expect(shareNotes(t, 'en', refused)).toEqual(["It's Mina's file, so only Mina can add people."])
  // a partial result names what was done and where it stopped
  const partial: StepShared = { op: 'share', outcome: 'partial', files: [file(L1, 'a.txt')], failed: [{ name: 'b.txt', place: 'My files' }], who: [jun], level: 'view', refusal: { reason: 'limit', file: 'b.txt' } }
  expect(shareHeadline(t, 'en', partial)).toBe('Shared 1 of 2 files with Jun')
  expect(shareNotes(t, 'en', partial)).toEqual(["Couldn't share b.txt. You've shared a lot in a short time. Try again in a minute."])
  // every language has the headline (no key falls back to its name)
  for (const l of ['ko', 'ja', 'zh', 'es', 'id'] as const) {
    const tl = (key: MessageKey, params?: Record<string, string | number>) => translate(l, key, params)
    const h = shareHeadline(tl, l, sharedMany)
    expect(h).toContain('Jun')
    expect(h).toContain('Quote.pdf')
    expect(h).not.toContain('shareCard.')
  }
})

test('already open (checked before the card): the headline says who could already open it; a partial says it under the rows', () => {
  const all: StepShared = { op: 'share', outcome: 'done', files: [file(L1, 'Quote.pdf')], who: [], already: [jun], level: 'view' }
  expect(shareHeadline(t, 'en', all)).toBe('Jun can already open Quote.pdf')
  expect(shareNotes(t, 'en', all)).toEqual([])
  const some: StepShared = { ...sharedOne, who: [{ subjectType: 'user', subjectId: 'bo', name: 'Bo' }], notified: ['bo'], already: [jun] }
  expect(shareHeadline(t, 'en', some)).toBe('Shared Quote.pdf with Bo')
  expect(shareNotes(t, 'en', some)).toEqual(['Bo got a notification.', 'Jun could already open it, so nothing changed for them.'])
})

test('the confirmation rows carry the server\'s "why it asks" line (Always allow on, other people\'s words read): one line', async () => {
  const why = 'A file someone shared with you (other people\'s words) was read here, so changes are asked first.'
  const m = await mount(<ShareAskRows ask={{ op: 'share', files: [file(L1, 'Quote.pdf')], who: [jun], why }} titleId="q1" />)
  try {
    expect(m.container.querySelectorAll('[data-testid="share-ask-why"]').length).toBe(1)
    expect(m.get('share-ask-why').textContent).toBe(why)
  } finally { await m.unmount() }
  const none = await mount(<ShareAskRows ask={{ op: 'share', files: [file(L1, 'Quote.pdf')], who: [jun] }} titleId="q2" />)
  try { expect(none.find('share-ask-why')).toBeNull() } finally { await none.unmount() }
})

test('isRestored: a stop is undone once every person of the card is on every file the viewer still sees', () => {
  const on = (id: string, people: { subjectType: 'user' | 'group'; subjectId: string; name: string }[]): ShareCardState => ({ id, path: `users/me/${id}`, name: id, canShare: true, canStop: true, people })
  expect(isRestored(stopped, null)).toBe(false)
  expect(isRestored(stopped, [on(L1, [])])).toBe(false)
  expect(isRestored(stopped, [on(L1, [jun])])).toBe(true)
  expect(isRestored(stopped, [{ id: L1, gone: true }])).toBe(false)
  expect(isRestored(sharedOne, [on(L1, [jun])])).toBe(false)
})

// ---- the components ----
type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
let live: ShareCardState[] = []
const calls: { url: string; method: string; body: unknown }[] = []
beforeAll(() => { installDom() })
afterAll(() => { removeDom(); globalThis.fetch = realFetch })
beforeEach(() => {
  calls.length = 0
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, method: init?.method ?? 'GET', body })
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/files/shares/take-back')) return json({ removed: 1, skipped: 0 })
    if (url.includes('/api/files/shares/cards')) return json({ items: live.filter((x) => (body as { ids: string[] }).ids.includes(x.id)) })
    if (url.includes('/api/files/shares') && init?.method === 'PUT') {
      const b = body as { path: string; add: { subjectType: 'user' | 'group'; subjectId: string }[] }
      live = live.map((x) => ('path' in x && x.path === b.path ? { ...x, people: [...x.people, ...b.add.map((a) => ({ ...a, name: 'Jun' }))] } : x))
      return json({ path: b.path, link: null, canShare: true, canStop: true, owner: null, mine: true, teamFile: false, people: [] })
    }
    if (url.includes('/api/files/shares')) return json({ path: 'users/me/Quote.pdf', link: null, canShare: true, canStop: true, owner: null, mine: true, teamFile: false, people: [] })
    return json({})
  }) as unknown as typeof fetch
})
afterEach(() => { useLocaleStore.setState({ locale }); registerShareNext('ask_owner', null) })
const mine = (id: string, name: string, people: ShareCardState extends infer S ? S extends { people: infer P } ? P : never : never = []): ShareCardState => ({ id, path: `users/me/${name}`, name, canShare: true, canStop: true, people })

test('the confirmation card shows the record\'s rows (file, place, person, Can view) and answers with the server\'s values', async () => {
  const answers: unknown[] = []
  const ask: Ask = {
    kind: 'ask_user', origin: 'server', requestId: 'r1', question: 'Share 1 file with Jun?', multiple: false, allowText: false,
    options: [{ label: 'Share', value: 'share' }, { label: "Don't share", value: 'no' }],
    details: [{ label: 'Files', text: 'Quote.pdf', noSize: true }],
    share: { op: 'share', files: [{ name: 'Quote.pdf', place: 'My files › Work' }], who: [jun] },
  }
  const m = await mount(<AskCard req={{ request: ask }} onAnswer={async (_id, body) => void answers.push(body)} />)
  try {
    expect(m.get('share-ask-title').textContent).toBe('Share Quote.pdf with Jun?')
    expect(m.get('share-card-file-name').textContent).toBe('Quote.pdf')
    expect(m.get('share-card-file-place').textContent).toBe('My files › Work')
    expect(m.get('share-card-person').textContent).toContain('Jun')
    expect(m.get('share-card-person').textContent).toContain('Can view')
    // the rows replace the plain question and the plain file list
    expect(m.find('ask-detail-text')).toBeNull()
    expect(m.html()).not.toContain('Share 1 file with Jun?')
    await m.click('ask-yes')
    expect(answers).toEqual([{ kind: 'ask_user', answer: 'share' }])
  } finally { await m.unmount() }
})

test('after a share: the headline, the rows, who was told, and Manage access opens the file\'s Share dialog', async () => {
  live = [mine(L1, 'Quote.pdf', [jun])]
  const m = await mount(<><ShareCard shared={sharedOne} /><FileShareHost /></>)
  try {
    expect(m.get('share-card').getAttribute('data-state')).toBe('done')
    expect(m.get('action-card-title').textContent).toBe('Shared Quote.pdf with Jun')
    expect(m.get('share-card-file-place').textContent).toBe('My files › Work')
    expect(m.get('share-card-person').textContent).toContain('Can view')
    expect(m.get('share-card-note').textContent).toBe('Jun got a notification.')
    // no path on the card, only words
    expect(m.get('share-card').innerHTML).not.toContain('users/')
    await m.until(() => m.find('share-card-manage'), 'Manage access')
    expect(m.find('share-card-undo')).toBeNull()
    await m.click('share-card-manage')
    expect((await m.until(() => m.find('file-share-dialog'), 'the Share dialog')).getAttribute('data-path')).toBe('users/me/Quote.pdf')
  } finally { await m.unmount() }
})

test('several files: one card; Manage access lists them, each opens its own dialog', async () => {
  live = [mine(L1, 'Quote.pdf', [jun]), mine(L2, 'Budget.xlsx', [jun]), mine(L3, 'Notes.docx', [jun]), mine(L4, 'Plan.md', [jun])]
  const m = await mount(<><ShareCard shared={sharedMany} /><FileShareHost /></>)
  try {
    expect(m.get('action-card-title').textContent).toBe('Shared 4 files with Jun: Quote.pdf, Budget.xlsx, Notes.docx and 1 more')
    expect(m.find('share-card-file')).toBeNull()
    await m.until(() => m.find('share-card-manage'), 'Manage access')
    await m.click('share-card-manage')
    const rows = m.get('share-card-rows').querySelectorAll('[data-testid="share-card-file"]')
    expect(rows).toHaveLength(4)
    await m.click(rows[1]!)
    expect((await m.until(() => m.find('file-share-dialog'), 'the Share dialog')).getAttribute('data-path')).toBe('users/me/Budget.xlsx')
  } finally { await m.unmount() }
})

test('after a stop: who can still open it, and Undo shares it with the same people again; the card then says so', async () => {
  live = [mine(L1, 'Quote.pdf', [])]
  const m = await mount(<ShareCard shared={stopped} />)
  try {
    expect(m.get('action-card-title').textContent).toBe('Stopped sharing Quote.pdf with Jun')
    expect(m.get('share-card-note').textContent).toBe('Jun can still open it through the Sales group.')
    // (nobody is listed with "Can view" on a stop)
    expect(m.find('share-card-person')).toBeNull()
    await m.until(() => m.find('share-card-undo'), 'Undo')
    expect(m.find('share-card-manage')).toBeNull()
    await m.click('share-card-undo')
    await m.until(() => m.get('share-card').getAttribute('data-state') === 'restored', 'the card to say it is shared again')
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.body).toEqual({ path: 'users/me/Quote.pdf', add: [{ subjectType: 'user', subjectId: 'jun' }], remove: [] })
    expect(m.get('action-card-title').textContent).toBe('Shared Quote.pdf with Jun again')
    expect(m.find('share-card-undo')).toBeNull()
    expect(m.find('share-card-manage')).not.toBeNull()
    expect(m.get('share-card-person').textContent).toContain('Can view')
  } finally { await m.unmount() }
})

test('a post to a room uses the same card frame and keeps View (the way the step row goes)', async () => {
  const { default: PostedCard } = await import('../../src/components/chat/PostedCard')
  const { StepPostView } = await import('../../src/components/chat/Steps')
  const posted = { roomId: '019a5f00-0000-7000-8000-00000000a001', messageId: '019a5f00-0000-7000-8000-00000000a002' }
  const went: unknown[] = []
  const m = await mount(<StepPostView.Provider value={(p) => went.push(p)}><PostedCard posted={posted} /></StepPostView.Provider>)
  try {
    // a room the viewer does not have in their list is not named (the record holds ids alone)
    expect(m.get('posted-card').getAttribute('data-kind')).toBe('post')
    expect(m.get('action-card-title').textContent).toBe('Posted to a conversation')
    expect(m.get('posted-card-view').textContent).toBe('View')
    await m.click('posted-card-view')
    expect(went).toEqual([posted])
    // nothing about what went: no lines
    expect(m.find('posted-card-preview')).toBeNull()
  } finally { await m.unmount() }
  // what went, from the posted message: its first words and the files sent with it (the coordinator's fix 7)
  const full = { ...posted, preview: 'Here is the price list for December', files: ['Price list.md'] }
  const w = await mount(<StepPostView.Provider value={(p) => went.push(p)}><PostedCard posted={full} /></StepPostView.Provider>)
  try {
    expect(w.get('posted-card-preview').textContent).toBe('“Here is the price list for December”')
    expect(w.get('posted-card-file').textContent).toContain('Price list.md')
    expect(w.get('posted-card-view').textContent).toBe('View')
  } finally { await w.unmount() }
  // a team room the viewer has: named with "#", as the offer and the AI's answer name it
  const { useRooms } = await import('../../src/store/rooms')
  useRooms.setState({ rooms: [{ id: posted.roomId, kind: 'team', name: 'Sales', peers: [], memberCount: 4 }] } as never)
  const named = await mount(<StepPostView.Provider value={(p) => went.push(p)}><PostedCard posted={posted} /></StepPostView.Provider>)
  try { expect(named.get('action-card-title').textContent).toBe('Posted in #Sales') } finally { await named.unmount() }
})

test('a file the viewer can no longer open: the card keeps its words and has no button', async () => {
  live = [{ id: L1, gone: true }]
  const m = await mount(<ShareCard shared={sharedOne} />)
  try {
    await m.settle(50)
    expect(m.get('action-card-title').textContent).toBe('Shared Quote.pdf with Jun')
    expect(m.find('share-card-manage')).toBeNull()
    expect(m.find('action-card-footer')).toBeNull()
  } finally { await m.unmount() }
})

test('a refusal: what and why from the record; a button only for a next step someone registered', async () => {
  live = []
  const bare = await mount(<ShareCard shared={refused} />)
  try {
    expect(bare.get('share-card').getAttribute('data-state')).toBe('refused')
    expect(bare.get('action-card-title').textContent).toBe("Couldn't share Quote.xlsx.")
    expect(bare.get('share-card-note').textContent).toBe("It's Mina's file, so only Mina can add people.")
    expect(bare.get('share-card-file-place').textContent).toBe('Team folder › Sales')
    expect(bare.find('action-card-footer')).toBeNull()
  } finally { await bare.unmount() }
  const got: unknown[] = []
  registerShareNext('ask_owner', ({ next }) => <button type="button" data-testid="next-ask-owner" onClick={() => got.push(next)}>Ask {next.name}</button>)
  const m = await mount(<ShareCard shared={refused} />)
  try {
    expect(m.get('next-ask-owner').textContent).toBe('Ask Mina')
    await m.click('next-ask-owner')
    expect(got).toEqual([{ kind: 'ask_owner', linkId: L1, userId: 'mina', name: 'Mina' }])
  } finally { await m.unmount() }
})

// Do then undo (docs/decisions/20261123-do-then-undo.md): a post or a share that just went offers 취소 for a few seconds
// (the room's delete; the share taken back from exactly the people it added), then 지우기 / Manage access
test('a post just sent: Undo deletes the message, then the card says it was taken back; an older post offers Delete', async () => {
  const { default: PostedCard } = await import('../../src/components/chat/PostedCard')
  const posted = { roomId: '019a5f00-0000-7000-8000-00000000a011', messageId: '019a5f00-0000-7000-8000-00000000a012' }
  const m = await mount(<PostedCard posted={posted} endedAt={new Date().toISOString()} />)
  try {
    expect(m.get('posted-card-undo').textContent).toBe('Undo 10')
    await m.click('posted-card-undo')
    const del = calls.find((c) => c.method === 'DELETE')!
    expect(del.url).toContain(`/api/rooms/${posted.roomId}/messages/${posted.messageId}`)
    expect(m.get('action-card-title').textContent).toBe(t('postedCard.undone'))
    expect(m.find('posted-card-view')).toBeNull()
  } finally { await m.unmount() }
  const old = await mount(<PostedCard posted={posted} endedAt={new Date(Date.now() - 60_000).toISOString()} />)
  try { expect(old.get('posted-card-delete').textContent).toBe('Delete') } finally { await old.unmount() }
  // where it went, named in the Undo text (a 1:1 chat the viewer's list does not have yet too)
  const dm = await mount(<PostedCard posted={{ ...posted, to: '박준호' }} endedAt={new Date().toISOString()} />)
  try {
    await dm.click('posted-card-undo')
    expect(dm.get('action-card-title').textContent).toBe(t('postedCard.undoneTo', { to: '박준호' }))
    expect(dm.get('action-card-title').textContent).toContain('박준호')
  } finally { await dm.unmount() }
  // a post that notified everyone: taking it back says the notices already went
  const all = await mount(<PostedCard posted={{ ...posted, mentionsAll: true }} endedAt={new Date().toISOString()} />)
  try {
    await all.click('posted-card-undo')
    expect(all.get('action-card-title').textContent).toBe(t('postedCard.undoneNotified'))
    expect(t('postedCard.undoneNotified')).toContain('notices already went out')
  } finally { await all.unmount() }
})

// The Undo line names where it went with the right words: a person (a 1:1 chat) "박준호님에게", a room or a group chat
// "#영업팀에" (QA: "박준호에 보낸 글을 지웠어요"). Every send kind, in Korean, and the person keys in all six languages.
test('Undo names a 1:1 chat\'s person and a room each with their own words', async () => {
  const { default: PostedCard } = await import('../../src/components/chat/PostedCard')
  const { useRooms } = await import('../../src/store/rooms')
  const roomsBefore = useRooms.getState().rooms
  const base = { roomId: '019a5f00-0000-7000-8000-00000000b011', messageId: '019a5f00-0000-7000-8000-00000000b012' }
  const room = (kind: string, extra: Record<string, unknown> = {}) => ({ id: base.roomId, kind, name: null, peers: [], ...extra })
  const title = async (posted: Record<string, unknown>, rooms: unknown[] = []) => {
    useRooms.setState({ rooms: rooms as never })
    const m = await mount(<PostedCard posted={{ ...base, ...posted } as never} endedAt={new Date().toISOString()} />)
    try {
      const sent = m.get('action-card-title').textContent
      await m.click('posted-card-undo')
      return [sent, m.get('action-card-title').textContent]
    } finally { await m.unmount() }
  }
  useLocaleStore.setState({ locale: 'ko' })
  try {
    // a 1:1 chat in the viewer's list: the person, with 님에게 (the room's title is the person's name)
    expect(await title({ to: '박준호', toPerson: true }, [room('dm', { peers: [{ id: 'u-park', name: '박준호' }] })])).toEqual(['박준호님에게 보냈어요', '박준호님에게 보낸 글을 지웠어요. 이제 아무도 볼 수 없어요'])
    // a 1:1 chat made by this send, not in the list yet: the server's mark
    expect(await title({ to: '박준호', toPerson: true })).toEqual(['박준호님에게 보냈어요', '박준호님에게 보낸 글을 지웠어요. 이제 아무도 볼 수 없어요'])
    // a name that carries its own honorific gets no second one
    expect((await title({ to: '김대표님', toPerson: true }))[1]).toBe('김대표님에게 보낸 글을 지웠어요. 이제 아무도 볼 수 없어요')
    // a team room and a named group chat: the place, with 에
    expect(await title({ to: '#영업팀' }, [room('team', { name: '영업팀' })])).toEqual(['#영업팀에 올렸어요', '#영업팀에 보낸 글을 지웠어요. 이제 아무도 볼 수 없어요'])
    expect((await title({ to: '주간회의' }, [room('group', { name: '주간회의' })]))[1]).toBe('주간회의에 보낸 글을 지웠어요. 이제 아무도 볼 수 없어요')
    // an older record (no mark) whose 1:1 chat is in the list: the list says it is a person
    expect((await title({ to: '박준호' }, [room('dm', { peers: [{ id: 'u-park', name: '박준호' }] })]))[1]).toBe('박준호님에게 보낸 글을 지웠어요. 이제 아무도 볼 수 없어요')
    // a 1:1 chat whose person is gone: named as the list names it, with the room words
    expect((await title({ to: '박준호', toPerson: true }, [room('dm')]))[1]).not.toContain('님에게')
    // an unnamed group chat, its people listed: the place words
    expect((await title({ to: '박준호, 이서연' }, [room('group', { peers: [{ id: 'u-park', name: '박준호' }, { id: 'u-lee', name: '이서연' }] })]))[1]).not.toContain('님에게')
    // a room not in the list (no mark): the place
    expect((await title({ to: '#전체' }))[1]).toBe('#전체에 보낸 글을 지웠어요. 이제 아무도 볼 수 없어요')
    // with @everyone in a room: the notices already went
    expect((await title({ to: '#전체', mentionsAll: true }))[1]).toBe('#전체에 보낸 글을 지웠어요. 이제 아무도 볼 수 없어요. 알림은 이미 갔어요.')
    // a thread reply in a 1:1 chat is still to the person
    expect((await title({ to: '박준호', toPerson: true, threadRootId: '019a5f00-0000-7000-8000-00000000b013' }))[1]).toBe('박준호님에게 보낸 글을 지웠어요. 이제 아무도 볼 수 없어요')
  } finally {
    useLocaleStore.setState({ locale: 'en' })
    useRooms.setState({ rooms: roomsBefore })
  }
  // every language has the person wording, with the name in it and no Korean particle outside Korean
  for (const l of ['en', 'ko', 'ja', 'zh', 'es', 'id'] as const) {
    for (const k of ['shareCard.postedToPerson', 'postedCard.undoneToPerson', 'postedCard.undoneToPersonNotified'] as const) {
      const s = translate(l, k, { to: 'Mina' })
      expect(s).toContain('Mina')
      expect(s).not.toBe(k)
      if (l !== 'ko') expect(s).not.toMatch(/님|에게/)
    }
  }
  expect(translate('ja', 'postedCard.undoneToPerson', { to: '田中' })).toStartWith('田中さんへ')
  expect(translate('zh', 'postedCard.undoneToPerson', { to: '王伟' })).toContain('发给王伟')
})

test('a share just done: Undo takes back what it added by the server\'s record (never earlier access)', async () => {
  live = [mine(L1, 'Quote.pdf', [{ subjectType: 'user', subjectId: 'jun', name: 'Jun' }] as never)]
  const takeBack = { id: 't'.repeat(22), until: new Date(Date.now() + 600_000).toISOString() }
  const m = await mount(<ShareCard shared={{ ...sharedOne, takeBack }} endedAt={new Date().toISOString()} />)
  try {
    await m.until(() => m.find('share-card-takeback'), 'Undo')
    await m.click('share-card-takeback')
    const tb = calls.find((c) => c.url.includes('/api/files/shares/take-back'))!
    expect(tb.body).toEqual({ id: takeBack.id })
    // the card never removes people itself (it could take a file they had before)
    expect(calls.find((c) => c.method === 'PUT')).toBeUndefined()
    expect(m.get('action-card-title').textContent).toBe(t('shareCard.takenBack'))
  } finally { await m.unmount() }
  // a record without the server's take-back offers no 취소
  const old = await mount(<ShareCard shared={sharedOne} endedAt={new Date().toISOString()} />)
  try { await old.until(() => old.find('share-card-manage'), 'Manage'); expect(old.find('share-card-takeback')).toBeNull() } finally { await old.unmount() }
})

test('a scheduled task made from my words: next run, Pause, and Delete through the Scheduled route', async () => {
  const { default: ScheduledCard } = await import('../../src/components/chat/ScheduledCard')
  const m = await mount(<ScheduledCard scheduled={{ id: 's1', title: 'Morning notes', nextRunAt: new Date(Date.now() + 86_400_000).toISOString(), quiet: true }} />)
  try {
    expect(m.get('action-card-title').textContent).toBe('Scheduled "Morning notes"')
    expect(m.get('scheduled-card-next').textContent).toContain('Next run')
    // (Delete answers 204; Pause goes through the same Scheduled page route, PATCH enabled false)
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    try {
      await m.click('scheduled-card-delete')
      await m.until(() => m.get('action-card-title').textContent === '"Morning notes" is deleted', 'deleted')
      expect(calls.find((c) => c.method === 'DELETE')!.url).toContain('/api/schedules/s1')
      expect(m.find('scheduled-card-pause')).toBeNull()
    } finally { globalThis.fetch = real }
  } finally { await m.unmount() }
})

test('a post whose step is still running offers Undo at once; it counts down from the end and becomes Delete', async () => {
  const { default: PostedCard } = await import('../../src/components/chat/PostedCard')
  const posted = { roomId: '019a5f00-0000-7000-8000-00000000a021', messageId: '019a5f00-0000-7000-8000-00000000a022' }
  // the step ends while the card is on screen, with a server clock an hour behind this device's
  let end: (at: string) => void = () => {}
  const Live = () => { const [at, set] = useState<string | null>(null); end = set; return <PostedCard posted={posted} endedAt={at} /> }
  const m = await mount(<Live />)
  try {
    expect(m.get('posted-card-undo').textContent).toBe('Undo 10')
    end(new Date(Date.now() - 3_600_000).toISOString())
    await m.settle(50)
    expect(m.get('posted-card-undo').textContent).toBe('Undo 10')
  } finally { await m.unmount() }
  // a device clock an hour behind never shows more than the window
  const skew = await mount(<PostedCard posted={posted} endedAt={new Date(Date.now() + 3_600_000).toISOString()} />)
  try { expect(skew.get('posted-card-undo').textContent).toBe('Undo 10') } finally { await skew.unmount() }
  const late = await mount(<PostedCard posted={posted} endedAt={new Date(Date.now() - 8_500).toISOString()} />)
  try {
    expect(late.get('posted-card-undo').textContent).toBe('Undo 2')
    await late.until(() => late.find('posted-card-delete'), 'Delete', 4_000)
  } finally { await late.unmount() }
})
