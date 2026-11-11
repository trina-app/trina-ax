// The Inbox's own notices (components/settings/Notifications.tsx NoticeRow): read like a conversation row. A scheduled
// run names its task while the server still has it; a notice with a place to open is one link, the whole row, that
// reads it (no "결과 열기" under it, a dot while unread); one with none is still and keeps 읽음 표시; a job's log stays
// out of the link.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { InboxNotification, uuidv7, type Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { noticeLink, noticeText } from '../../src/components/settings/Notifications'
import Activity from '../../src/pages/Activity'
import { installDom, mount, removeDom } from './dom-host'
import { ME } from './rooms-fixtures'

setDefaultTimeout(30_000)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const CHAT = uuidv7()

/** a notice as the server sends it (parsed with the contract, so a change there breaks this) */
const notice = (o: Partial<InboxNotification> = {}) => InboxNotification.parse({
  id: uuidv7(), eventType: 'schedule.success', sourceId: uuidv7(), code: 'schedule.success', createdAt: '2026-11-07T01:00:00.000Z', readAt: null, chatId: CHAT, link: 'chat', outcome: 'succeeded', ...o,
})
const failure = (o: Partial<InboxNotification> = {}) => notice({ eventType: 'schedule.failure', code: 'schedule.failure', outcome: 'failed', ...o })
const text = (item: InboxNotification, locale: 'ko' | 'en' = 'ko') => renderToStaticMarkup(<>{noticeText(item, locale === 'ko' ? ko : en, locale)}</>)

test('a scheduled run says which task, in <bdi>; without a title (a deleted task, an older server) the line it had', () => {
  const schedule = { title: '주간 보고' }
  expect(text(notice({ schedule }))).toBe('&quot;<bdi>주간 보고</bdi>&quot; 예약 작업이 끝났어요.')
  expect(text(notice({ schedule: { title: 'Weekly report' } }), 'en')).toBe('Scheduled task &quot;<bdi>Weekly report</bdi>&quot; finished.')
  expect(text(failure({ schedule }))).toBe(ko('notifications.event.schedule.failureNamed', { title: '<bdi>주간 보고</bdi>' }).replaceAll('"', '&quot;'))
  expect(text(failure({ schedule, outcome: 'problems' }))).toBe('&quot;<bdi>주간 보고</bdi>&quot; 예약 작업은 끝났지만 일부 단계가 안 됐어요. 실행 결과를 확인해 주세요.')
  expect(text(failure({ schedule, link: 'integrations', chatId: null, needsKey: { templateId: 't', name: 'Tasks' } }))).toBe('&quot;<bdi>주간 보고</bdi>&quot; 예약 작업이 실행되지 않았어요. <bdi>Tasks</bdi>에 내 키가 필요해요.')
  // no title: as before
  expect(text(notice())).toBe(ko('notifications.event.schedule.success'))
  expect(text(failure())).toBe(ko('notifications.event.schedule.failure'))
  expect(text(failure({ outcome: 'problems' }))).toBe(ko('notifications.event.schedule.problems'))
  expect(text(failure({ needsKey: { templateId: 't', name: 'Tasks' } }))).toBe(ko('notifications.event.schedule.needsKey', { name: 'Tasks' }))
  expect(text(failure({ review: true, link: null, chatId: null, outcome: null }))).toBe(ko('notifications.event.schedule.review'))
  expect(text(notice({ eventType: 'connection.reconnect', code: 'connection.reconnect', link: 'connections', chatId: null, outcome: null }))).toBe(ko('notifications.event.connection.reconnect'))
})

test('where a row goes: the result chat of a run, the page of the rest; none when the server gave no place', () => {
  expect(noticeLink(notice())).toEqual({ to: `/c/${CHAT}`, testId: 'notification-chat-link' })
  expect(noticeLink(notice({ link: null, chatId: null }))).toBeNull()
  expect(noticeLink(failure({ review: true, link: null, chatId: null }))).toEqual({ to: '/scheduled', testId: 'notification-review-link' })
  expect(noticeLink(failure({ link: 'integrations', chatId: null, needsKey: { templateId: 't 1', name: 'Tasks' } }))).toEqual({ to: '/connectors?template=t%201', testId: 'notification-template-link' })
  expect(noticeLink(notice({ eventType: 'connection.reconnect', code: 'connection.reconnect', link: 'connections', chatId: null }))).toEqual({ to: '/connectors/google-drive', testId: 'notification-connections-link' })
  expect(noticeLink(notice({ eventType: 'dev_env.box', code: 'dev_env.box', link: 'project', chatId: null, devEnv: { projectId: 'p1', projectName: 'Site' } }))).toEqual({ to: '/projects/p1', testId: 'notification-project-link' })
  expect(noticeLink(notice({ eventType: 'team.joined', code: 'team.joined', link: null, chatId: null }))).toEqual({ to: '/admin/members', testId: 'notification-joined-link' })
})

test('someone joined a project I am in (docs/DECISIONS.md "Project contents only for members"): who and where, while there; the project\'s page', () => {
  const joined = (projectJoined: InboxNotification['projectJoined'], link: InboxNotification['link'] = projectJoined?.project ? 'project' : null) =>
    notice({ eventType: 'project.joined', code: 'project.joined', link, chatId: null, outcome: null, projectJoined })
  const acme = { id: 'p1', name: 'Acme launch' }
  expect(text(joined({ name: 'Dana', project: acme }))).toBe("Dana님이 &#x27;Acme launch&#x27; 프로젝트에 들어왔어요.")
  expect(text(joined({ name: 'Dana', project: acme }), 'en')).toBe('Dana joined &#x27;Acme launch&#x27;.')
  // the project no longer mine to see: no name of it, no link
  expect(text(joined({ name: 'Dana', project: null }))).toBe('Dana님이 프로젝트에 들어왔어요.')
  expect(text(joined({ name: 'Dana', project: null }), 'en')).toBe('Dana joined a project.')
  // the account gone: nobody named
  expect(text(joined({ name: null, project: acme }))).toBe("누군가 &#x27;Acme launch&#x27; 프로젝트에 들어왔어요.")
  expect(text(joined({ name: null, project: acme }), 'en')).toBe('Someone joined &#x27;Acme launch&#x27;.')
  expect(text(joined({ name: null, project: null }), 'en')).toBe(en('notifications.event.project.joined'))
  // an older server without the details: the line of its kind
  expect(text(notice({ eventType: 'project.joined', code: 'project.joined', link: null, chatId: null, outcome: null }), 'en')).toBe('Someone joined a project.')
  expect(noticeLink(joined({ name: 'Dana', project: acme }))).toEqual({ to: '/projects/p1', testId: 'notification-project-link' })
  expect(noticeLink(joined({ name: 'Dana', project: null }))).toBeNull()
})

// ---------------- in the Inbox ----------------
const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'Asia/Seoul' } } as unknown as Me
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const reads: string[] = []
let items: InboxNotification[] = []
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    if (key === 'GET /api/notifications') return json({ items, nextCursor: null, unreadCount: items.filter((x) => !x.readAt).length })
    const read = /^POST \/api\/notifications\/(.+)\/read$/.exec(key)
    if (read) { reads.push(read[1]!); items = items.map((x) => (x.id === read[1] ? { ...x, readAt: '2026-11-07T02:00:00.000Z' } : x)); return json(items.find((x) => x.id === read[1])) }
    if (key === 'GET /api/notification-preferences') return json({ scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true, skillSuggestions: true })
    if (key === 'GET /api/push') return json({ configured: false, enabled: false, publicKey: null, subscriptionId: null })
    return json({ error: { code: 'not_found', message: key } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  reads.length = 0
  useRooms.getState().reset()
  useSession.setState({ status })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale })
})

test('the Inbox: a run is one link with its task, time and dot that reads it; no link, 읽음 표시; a job log under the link', async () => {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const run = notice({ schedule: { title: '주간 보고' } })
  const read = notice({ readAt: '2026-11-07T01:30:00.000Z' })
  const still = notice({ link: null, chatId: null })
  const job = notice({ eventType: 'dev_env.job', code: 'dev_env.job', outcome: null, devEnv: { projectId: 'p1', projectName: 'Site', job: { name: 'build', exitCode: 1, note: '', tail: 'npm ERR! missing script' } } })
  items = [run, read, still, job]
  const m = await mount(<MemoryRouter><Activity /></MemoryRouter>)
  try {
    await m.until(() => m.find('notification-chat-link'), 'the rows')
    const rows = m.container.ownerDocument!.body.querySelectorAll('[data-testid="notification-item"]')
    expect(rows).toHaveLength(4)
    // the run: the row is the link, with the bell, the words naming the task, the time and the unread dot
    const link = rows[0]!.querySelector('a')!
    expect(link.getAttribute('href')).toBe(`/c/${CHAT}`)
    expect(link.getAttribute('data-testid')).toBe('notification-chat-link')
    expect(link.getAttribute('data-unread')).toBe('')
    expect(link.querySelector('[data-testid="notification-text"]')!.innerHTML).toBe('"<bdi>주간 보고</bdi>" 예약 작업이 끝났어요.')
    expect(link.querySelector('time')!.getAttribute('dateTime') ?? link.querySelector('time')!.getAttribute('datetime')).toBe(run.createdAt)
    expect(link.querySelector('[data-testid="notification-unread"]')!.textContent).toBe(ko('notifications.unreadMark'))
    // no separate link and no button in it, and no date line
    expect(rows[0]!.querySelectorAll('a')).toHaveLength(1)
    expect(rows[0]!.querySelector('button')).toBeNull()
    expect(rows[0]!.textContent).not.toContain('결과 열기')
    // read: no dot
    expect(rows[1]!.querySelector('a')!.getAttribute('data-unread')).toBeNull()
    expect(rows[1]!.querySelector('[data-testid="notification-unread"]')).toBeNull()
    // nowhere to go: no link, 읽음 표시 instead of the dot
    expect(rows[2]!.querySelector('a')).toBeNull()
    expect(rows[2]!.querySelector('button')!.textContent).toBe(ko('notifications.markRead'))
    // a job: the row opens its chat; the log is under the link, not in it (to be selected)
    const jobLink = rows[3]!.querySelector('a')!
    expect(jobLink.querySelector('[data-testid="notification-job-tail"]')).toBeNull()
    expect(rows[3]!.querySelector('[data-testid="notification-job-tail"]')!.textContent).toBe('npm ERR! missing script')
    // the click reads the notice
    await m.click(link)
    await m.until(() => reads.length > 0, 'the read')
    expect(reads).toEqual([run.id])
  } finally { await m.unmount() }
})

test('"tried to use Trina but it isn\'t set up yet": the name while the account is there, else a team member; the AI accounts page', () => {
  const ask = (o: Partial<InboxNotification> = {}) => notice({ eventType: 'onboarding.ai_request', code: 'onboarding.ai_request', sourceId: 'not-ready:u1', chatId: null, link: 'admin_credentials', outcome: null, ...o })
  expect(text(ask({ notReady: true, requester: { name: 'Mia' } }), 'en')).toBe("Mia tried to use Trina but it isn&#x27;t set up yet.")
  expect(text(ask({ notReady: true }), 'en')).toBe("A team member tried to use Trina but it isn&#x27;t set up yet.")
  // the ask for an AI connection keeps its words
  expect(text(ask({ sourceId: 'u1', requester: { name: 'Mia' } }), 'en')).toBe(en('notifications.event.onboarding.ai_requestNamed', { name: 'Mia' }))
  expect(noticeLink(ask({ notReady: true }))?.to).toBe('/admin/providers')
})
