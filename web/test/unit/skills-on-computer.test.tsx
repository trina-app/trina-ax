// A phone owner who put 내 스킬 off for a computer (docs/DECISIONS.md "W5"; the walk of PR #100, SHOULD 1): the step
// promised "컴퓨터에서 이어서 해요", and the phone's Home showed nothing about it (the setup row and Home's quiet row both
// hide: nothing there can be resumed). Now one quiet line on the phone's Home keeps the promise, no button; nothing on a
// computer (its sign-in opens the step), once the steps are finished or hidden, or for an admin.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me, WelcomeProgress } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { HomeTop } from '../../src/pages/Home'
import { skillsWaitForComputer } from '../../src/lib/welcome'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { installDom, mount, removeDom } from './dom-host'

const me = (role: 'owner' | 'admin'): Me => ({
  user: { id: 'olga', username: 'olga', name: '김하나', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me)
/** everything answered on the phone, 내 스킬 put off for a computer */
const later = (o: Partial<WelcomeProgress> = {}): WelcomeProgress => ({
  startedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', teamType: null,
  steps: { profile: 'done', result: null, skills: 'skipped', files: 'done', invite: 'done' }, resultChatId: '01900000-0000-7000-8000-0000000000c1', inviteShownAt: null,
  site: null, dismissedAt: null, finishedAt: null, skillsLater: true, doneShownAt: '2026-11-01T00:10:00.000Z', ...o,
})

let welcome: WelcomeProgress | null = null
const realFetch = globalThis.fetch
const media = globalThis.matchMedia
const status = useSession.getState().status
const locale = useLocaleStore.getState().locale
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input)
    if (u.includes('/api/onboarding/welcome')) return json({ progress: welcome })
    if (u.includes('/api/onboarding/goal')) return json({ goal: null })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  globalThis.matchMedia = media
  removeDom()
  useLocaleStore.setState({ locale })
  useSession.setState({ status })
  useWelcome.getState().reset()
})
const width = (phone: boolean) => {
  globalThis.matchMedia = ((q: string) => ({ matches: phone && q === '(max-width: 767.98px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof matchMedia
}
const line = async (role: 'owner' | 'admin' = 'owner') => {
  useSession.setState({ status: { kind: 'signed-in', me: me(role) } } as never)
  useWelcome.getState().reset()
  const m = await mount(<MemoryRouter><HomeTop owner={role === 'owner'} /></MemoryRouter>)
  try {
    await m.settle(60)
    return { line: m.find('welcome-skills-computer')?.textContent ?? null, resume: !!m.find('welcome-resume') }
  } finally { await m.unmount() }
}

test('a phone, only 내 스킬 left for a computer: one quiet line on Home, no button, no resume row', async () => {
  width(true)
  welcome = later()
  expect(skillsWaitForComputer(welcome)).toBe(true)
  const got = await line()
  expect(got).toEqual({ line: translate('ko', 'welcome.skills.onComputer'), resume: false })
  expect(got.line).toBe('내 스킬은 컴퓨터에서 이어서 해요')
})

test('no line: on a computer, once finished or hidden, with 내 스킬 done, for an admin; a step still open on the phone shows its resume row instead', async () => {
  width(false)
  welcome = later()
  expect((await line()).line).toBeNull()
  width(true)
  for (const p of [later({ finishedAt: '2026-11-02T00:00:00.000Z' }), later({ dismissedAt: '2026-11-02T00:00:00.000Z' }), later({ steps: { profile: 'done', result: null, skills: 'done', files: 'done', invite: 'done' } })]) {
    welcome = p
    expect((await line()).line).toBeNull()
  }
  welcome = later()
  expect((await line('admin')).line).toBeNull()
  welcome = later({ steps: { profile: 'done', result: null, skills: 'skipped', files: null, invite: 'done' } })
  expect(await line()).toEqual({ line: null, resume: true })
})
