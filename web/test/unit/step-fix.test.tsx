// The next step under an AI answer (components/chat/StepFix.tsx; docs/decisions/20261116-ai-share-who-can-open.md): the
// line is built from what the server sent (names, counts), the button runs POST /api/share-fixes/:id/run once and the
// line then says what happened; a refusal says the server's words in a toast and the button stays; "Share with project"
// runs nothing and opens the app's own share flow; an offer the server calls done or gone shows no button. The words
// exist in every language. A request asked for someone else reads "Alice asked you to share … with Bob" in Activity.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import type { InboxNotification, Step, StepFix } from '@mycel/shared/api'
import { fixDone, fixLabel, fixText, NextStep, StepFixes, StepFixRow } from '../../src/components/chat/StepFix'
import { fileShareText } from '../../src/components/settings/Notifications'
import { translate, useLocaleStore } from '../../src/i18n'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

setDefaultTimeout(30_000)
const t = ((k: string, v?: Record<string, unknown>) => translate('en', k as never, v as never)) as never
const view: StepFix = { id: 'f1', kind: 'let_view', file: 'Quote.pdf', place: '#Sales', people: ['Jun Park', 'Mina Seo', 'Leo Kim'], count: 4, guests: 1, state: 'open' }
const owner: StepFix = { id: 'f2', kind: 'ask_owner', file: 'Quote.pdf', place: '#Sales', owner: 'Mina Seo', count: 3, state: 'open' }
const admin: StepFix = { id: 'f3', kind: 'ask_admin', file: 'Contracts', owner: 'Dana Choi', people: ['Jun Park'], count: 1, state: 'open' }
const project: StepFix = { id: 'f4', kind: 'share_project', file: 'Launch', chatId: 'c1', count: 0, state: 'open' }

const realFetch = globalThis.fetch
const calls: { url: string; method: string }[] = []
let answer: { status: number; body: unknown } = { status: 200, body: { state: 'done', doneCount: 4, left: 1 } }
const locale = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(typeof input === 'string' || input instanceof URL ? input : input.url), method: init?.method ?? 'GET' })
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})
beforeEach(() => {
  calls.length = 0
  answer = { status: 200, body: { state: 'done', doneCount: 4, left: 1 } }
  useUi.setState({ toasts: [] } as never)
  useLocaleStore.setState({ locale: 'en' })
})
afterEach(() => { useLocaleStore.setState({ locale }) })
afterAll(() => { globalThis.fetch = realFetch; removeDom() })

test('the lines: names and "and N more", the place, guests; counted when the server gave no names; several files', () => {
  expect(fixText(view, t)).toBe("Jun Park, Mina Seo, Leo Kim and 1 more in #Sales can't open Quote.pdf yet. Guests can't be given files.")
  expect(fixText({ ...view, people: ['Jun Park'], count: 1, guests: undefined, place: undefined }, t)).toBe("Jun Park can't open Quote.pdf yet.")
  expect(fixText({ ...view, moreFiles: 2, guests: undefined }, t)).toContain('Quote.pdf and 2 more files')
  expect(fixText(owner, t)).toBe("3 people in #Sales can't open Quote.pdf yet. It's Mina Seo's file, so only they can share it.")
  expect(fixText({ ...owner, owner: undefined, count: 1, place: undefined }, t)).toBe("1 person can't open Quote.pdf yet. Only an admin can share it.")
  expect(fixText(admin, t)).toBe('Only admins can share the folder Contracts. This sends Dana Choi a message from you.')
  expect(fixText(project, t)).toBe('Only you can see this chat.')
  expect([view, owner, { ...owner, owner: undefined }, admin, project].map((f) => fixLabel(f, t))).toEqual(['Let them view', 'Ask Mina Seo', 'Ask an admin', 'Ask an admin', 'Share with project'])
})

test('what the line says afterwards', () => {
  expect(fixDone({ ...view, state: 'done', doneCount: 3, left: 1 }, t)).toBe("3 people can now view Quote.pdf. 1 more person there still can't open it.")
  expect(fixDone({ ...view, state: 'done', doneCount: 1 }, t)).toBe('1 person can now view Quote.pdf.')
  expect(fixDone({ ...owner, state: 'done' }, t)).toBe('Asked Mina Seo to share Quote.pdf.')
  expect(fixDone({ ...admin, state: 'done' }, t)).toBe('Asked Dana Choi about the folder Contracts.')
  expect(fixDone({ ...project, state: 'done' }, t)).toBe('Shared with the project Launch.')
  expect(fixDone({ ...view, state: 'gone' }, t)).toBe('Nothing left to do here.')
})

test('every language has its own words, with the names in them', () => {
  for (const l of ['ko', 'ja', 'zh', 'es', 'id'] as const) {
    const tl = ((k: string, v?: Record<string, unknown>) => translate(l, k as never, v as never)) as never
    for (const f of [view, owner, admin, project]) {
      expect(fixText(f, tl)).not.toBe(fixText(f, t))
      expect(fixLabel(f, tl)).not.toBe(fixLabel(f, t))
    }
    expect(fixText(view, tl)).toContain('Jun Park')
    expect(fixText(view, tl)).toContain('Quote.pdf')
    expect(fixText(owner, tl)).toContain('Mina Seo')
    expect(translate(l, 'chat.project.movedPrivate', { name: 'Launch' })).toContain('Launch')
  }
})

test('NextStep: one line, one button; the action runs once while busy; done shows the result and no button', async () => {
  let n = 0
  let release = () => {}
  const m = await mount(<NextStep text="Something is in the way." label="Fix it" action={() => { n++; return new Promise<void>((r) => { release = r }) }} testId="ns" />)
  try {
    expect(m.get('ns').getAttribute('data-state')).toBe('open')
    expect(m.get('ns-text').textContent).toBe('Something is in the way.')
    expect(m.get('ns-button').textContent?.trim()).toBe('Fix it')
    await m.click('ns-button')
    await m.click('ns-button')
    expect(n).toBe(1)
    release()
    await m.settle(20)
  } finally { await m.unmount() }
  const d = await mount(<NextStep text="x" label="y" action={() => {}} done="All set." testId="ns" />)
  try {
    expect(d.get('ns').getAttribute('data-state')).toBe('done')
    expect(d.get('ns-text').textContent).toBe('All set.')
    expect(d.container.querySelector('[data-testid="ns-button"]')).toBeNull()
  } finally { await d.unmount() }
})

test('Let them view: the press posts the offer\'s id once, and the line becomes what the server answered', async () => {
  const m = await mount(<StepFixRow fix={view} />)
  try {
    await m.click('step-fix-button')
    await m.until(() => m.get('step-fix').getAttribute('data-state') === 'done', 'done')
    expect(calls).toEqual([{ url: '/api/share-fixes/f1/run', method: 'POST' }])
    expect(m.get('step-fix-text').textContent).toBe("4 people can now view Quote.pdf. 1 more person there still can't open it.")
    expect(m.container.querySelector('[data-testid="step-fix-button"]')).toBeNull()
  } finally { await m.unmount() }
})

test('refused by the server: its words in a toast, the button stays', async () => {
  answer = { status: 403, body: { error: { code: 'forbidden', message: "Only the file's owner can share it.", requestId: 'r', params: { reason: 'file_share_not_owner' } } } }
  const m = await mount(<StepFixRow fix={view} />)
  try {
    await m.click('step-fix-button')
    await m.until(() => useUi.getState().toasts.length > 0, 'the toast')
    expect(useUi.getState().toasts.at(-1)?.level).toBe('error')
    expect(useUi.getState().toasts.at(-1)?.text).toContain('owner')
    expect(m.get('step-fix').getAttribute('data-state')).toBe('open')
    expect(m.get('step-fix-button').textContent?.trim()).toBe('Let them view')
  } finally { await m.unmount() }
})

test('nothing left to do (they can open it already): said, no button', async () => {
  answer = { status: 200, body: { state: 'gone', doneCount: 0 } }
  const m = await mount(<StepFixRow fix={view} />)
  try {
    await m.click('step-fix-button')
    await m.until(() => m.get('step-fix').getAttribute('data-state') === 'done', 'gone')
    expect(m.get('step-fix-text').textContent).toBe('Nothing left to do here.')
  } finally { await m.unmount() }
})

test('Share with project runs nothing on the server; an offer the server calls done shows no button', async () => {
  const m = await mount(<StepFixRow fix={project} />)
  try {
    await m.click('step-fix-button')
    await m.settle(20)
    expect(calls).toEqual([])
    expect(m.get('step-fix').getAttribute('data-state')).toBe('open')
  } finally { await m.unmount() }
  const d = await mount(<StepFixRow fix={{ ...view, state: 'done', doneCount: 4 }} />)
  try {
    expect(d.container.querySelector('[data-testid="step-fix-button"]')).toBeNull()
    expect(d.get('step-fix-text').textContent).toBe('4 people can now view Quote.pdf.')
  } finally { await d.unmount() }
})

test('StepFixes: every offer of an answer\'s steps, nothing for steps without one', async () => {
  const step = (id: string, fixes?: StepFix[]): Step => ({ id, kind: 'tool', tool: 'post_to_room', label: 'x', status: 'ok', startedAt: '2026-11-16T00:00:00.000Z', endedAt: '2026-11-16T00:00:01.000Z', ...(fixes ? { fixes } : {}) })
  const none = await mount(<StepFixes steps={[step('a')]} />)
  try { expect(none.container.querySelector('[data-testid="step-fix"]')).toBeNull() } finally { await none.unmount() }
  const two = await mount(<StepFixes steps={[step('a', [view]), step('b'), step('c', [owner])]} />)
  try { expect(two.container.querySelectorAll('[data-testid="step-fix"]').length).toBe(2) } finally { await two.unmount() }
})

test('Activity: a request asked for someone else names who asked and who would get it', () => {
  const item = { id: 'n1', eventType: 'file.access_requested', code: 'file.access_requested', sourceId: 's', createdAt: '', readAt: null, chatId: null, link: 'file', fileShare: { by: 'Alice Kim', for: 'Bob Lee', name: 'rates.txt', linkId: 'x', requestId: 'q', state: 'pending' } } as unknown as InboxNotification
  expect(fileShareText(item, t)).toBe('Alice Kim asked you to share "rates.txt" with Bob Lee')
  expect(fileShareText({ ...item, fileShare: { ...item.fileShare!, for: undefined } }, t)).toBe('Alice Kim asked to open "rates.txt"')
})
