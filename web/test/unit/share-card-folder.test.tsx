// The AI share card for a FOLDER (share_folder: server chat/share-folder.ts; docs/decisions/20261116-share-folder-tool.md):
// the same card as for files, with a folder row (its name, its place in words, what it holds) and the line that files
// added later follow; after a stop or a removal its Undo is the server's (POST /api/files/shares/undo with the record's
// snapshot id), and past its time the button is Manage access; a refusal says why in the Share dialog's own words.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { ShareCardState, StepShared, TurnRequest } from '@mycel/shared/api'
import AskCard from '../../src/components/chat/AskCard'
import ShareCard from '../../src/components/chat/ShareCard'
import { serverUndo, shareHeadline, shareNotes } from '../../src/lib/shareCard'
import { translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { installDom, mount, removeDom } from './dom-host'

const t = (key: MessageKey, params?: Record<string, string | number>) => translate('en', key, params)
const L1 = 'bbbbbbbbbbbbbbbbbbbbb1'
const UNDO = 'uuuuuuuuuuuuuuuuuuuuu1'
const jun = { subjectType: 'user' as const, subjectId: 'jun', name: 'Jun' }
const work = { linkId: L1, name: 'QA-test', place: 'My files', folder: { files: 3, folders: 1 } }
const later = () => new Date(Date.now() + 10 * 60_000).toISOString()
const shared: StepShared = { op: 'share', outcome: 'done', files: [work], who: [jun], level: 'view', notified: ['jun'] }
const stopped = (): StepShared => ({ op: 'stop', outcome: 'done', files: [work], who: [jun], level: 'view', undo: { id: UNDO, until: later() }, keptOwn: { files: 2, folders: 1 } })

test('the words: a folder share says later files follow; a stop names what stays shared on its own; a refusal the dialog\'s reason', () => {
  expect(shareHeadline(t, 'en', shared)).toBe('Shared QA-test with Jun')
  expect(shareNotes(t, 'en', shared)).toEqual([t('fileShare.folderLater'), 'Jun got a notification.'])
  expect(shareHeadline(t, 'en', stopped())).toBe('Stopped sharing QA-test with Jun')
  expect(shareNotes(t, 'en', stopped())).toEqual(['Still shared on their own inside it: 2 files and 1 folder.'])
  const place: StepShared = { op: 'share', outcome: 'refused', files: [], failed: [work], who: [], level: 'view', refusal: { reason: 'place', file: 'QA-test', block: 'run_active' } }
  expect(shareNotes(t, 'en', place)).toEqual([t('fileShare.blocked.run_active')])
  expect(shareNotes(t, 'en', { ...place, refusal: { reason: 'paused', file: 'QA-test' } })).toEqual([t('fileShare.paused')])
  // the server's Undo only while it is offered
  expect(serverUndo(stopped())).toBe(UNDO)
  expect(serverUndo({ ...stopped(), undo: { id: UNDO, until: new Date(Date.now() - 1000).toISOString() } })).toBeNull()
  expect(serverUndo(shared)).toBeNull()
  for (const l of ['ko', 'ja', 'zh', 'es', 'id'] as const) {
    const n = shareNotes((k, p) => translate(l, k, p), l, stopped())
    expect(n.join(' ')).not.toContain('shareCard.')
  }
})

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
    if (url.includes('/api/files/shares/cards')) return json({ items: live.filter((x) => (body as { ids: string[] }).ids.includes(x.id)) })
    if (url.includes('/api/files/shares/undo')) {
      live = live.map((x) => ('path' in x ? { ...x, people: [{ ...jun }] } : x))
      return json({ path: 'users/me/QA-test', link: null, canShare: true, canStop: true, owner: null, mine: true, teamFile: false, people: [jun], kind: 'folder', restored: 1, skipped: 0 })
    }
    return json({})
  }) as unknown as typeof fetch
})
afterEach(() => { useLocaleStore.setState({ locale }) })
const mineFolder = (people: typeof jun[]): ShareCardState => ({ id: L1, path: 'users/me/QA-test', name: 'QA-test', canShare: true, canStop: true, people })

test('the confirmation card: the folder row with what it holds, the later-files line, no path', async () => {
  const answers: unknown[] = []
  const ask: Ask = {
    kind: 'ask_user', origin: 'server', requestId: 'r1', question: 'Share QA-test with Jun?', multiple: false, allowText: false,
    options: [{ label: 'Share', value: 'yes' }, { label: "Don't share", value: 'no' }],
    share: { op: 'share', files: [{ name: 'QA-test', place: 'My files', folder: { files: 3, folders: 1 } }], who: [jun] },
  }
  const m = await mount(<AskCard req={{ request: ask }} onAnswer={async (_id, body) => void answers.push(body)} />)
  try {
    expect(m.get('share-ask-title').textContent).toBe('Share QA-test with Jun?')
    expect(m.find('share-card-folder')).not.toBeNull()
    expect(m.get('share-card-file-place').textContent).toBe('My files · 3 files, 1 folder')
    expect(m.get('share-ask-folder-later').textContent).toBe(t('fileShare.folderLater'))
    expect(m.html()).not.toContain('users/')
    await m.click('ask-yes')
    expect(answers).toEqual([{ kind: 'ask_user', answer: 'yes' }])
  } finally { await m.unmount() }
})

test('after a stop: Undo is the server\'s, by the record\'s snapshot, and the card turns into "shared again"', async () => {
  live = [mineFolder([])]
  const m = await mount(<ShareCard shared={stopped()} />)
  try {
    await m.until(() => m.find('share-card-undo'), 'Undo')
    await m.click('share-card-undo')
    await m.until(() => m.get('share-card').getAttribute('data-state') === 'restored', 'restored')
    const undo = calls.find((c) => c.url.includes('/api/files/shares/undo'))!
    expect(undo.method).toBe('POST')
    expect(undo.body).toEqual({ id: UNDO })
    // never the client's re-add for a folder
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    expect(m.get('action-card-title').textContent).toBe('Shared QA-test with Jun again')
  } finally { await m.unmount() }
})

test('past the Undo\'s time: Manage access, never a client re-add', async () => {
  live = [mineFolder([])]
  const m = await mount(<ShareCard shared={{ ...stopped(), undo: { id: UNDO, until: new Date(Date.now() - 1000).toISOString() } }} />)
  try {
    await m.until(() => m.find('share-card-manage'), 'Manage access')
    expect(m.find('share-card-undo')).toBeNull()
  } finally { await m.unmount() }
})
