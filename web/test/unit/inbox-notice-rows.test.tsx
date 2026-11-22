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
  // a template each member signs in to: sign in with your own account, never "your own key" (QA TC-3052)
  expect(text(failure({ schedule, link: 'integrations', chatId: null, needsKey: { templateId: 't', name: 'Wiki', signIn: true } }))).toBe('&quot;<bdi>주간 보고</bdi>&quot; 예약 작업이 실행되지 않았어요. <bdi>Wiki</bdi>에 내 계정으로 로그인해야 해요.')
  expect(text(failure({ schedule: { title: 'Weekly report' }, needsKey: { templateId: 't', name: 'Wiki', signIn: true } }), 'en')).toBe('Scheduled task &quot;<bdi>Weekly report</bdi>&quot; did not run: sign in to <bdi>Wiki</bdi> with your own account.')
  expect(text(failure({ needsKey: { templateId: 't', name: 'Wiki', signIn: true } }), 'en')).toBe('A scheduled task did not run: sign in to Wiki with your own account.')
  expect(text(failure({ review: true, link: null, chatId: null, outcome: null }))).toBe(ko('notifications.event.schedule.review'))
  expect(text(notice({ eventType: 'connection.reconnect', code: 'connection.reconnect', link: 'connections', chatId: null, outcome: null }))).toBe(ko('notifications.event.connection.reconnect'))
})

test('where a row goes: the result chat of a run, the page of the rest; none when the server gave no place', () => {
  expect(noticeLink(notice())).toEqual({ to: `/c/${CHAT}`, testId: 'notification-chat-link' })
  expect(noticeLink(notice({ link: null, chatId: null }))).toBeNull()
  expect(noticeLink(failure({ review: true, link: null, chatId: null }))).toEqual({ to: '/scheduled', testId: 'notification-review-link' })
  expect(noticeLink(failure({ link: 'integrations', chatId: null, needsKey: { templateId: 't 1', name: 'Tasks' } }))).toEqual({ to: '/settings/connectors?template=t%201', testId: 'notification-template-link' })
  expect(noticeLink(notice({ eventType: 'connection.reconnect', code: 'connection.reconnect', link: 'connections', chatId: null }))).toEqual({ to: '/settings/connectors/google-drive', testId: 'notification-connections-link' })
  expect(noticeLink(notice({ eventType: 'dev_env.job', code: 'dev_env.job', link: 'project', chatId: null, devEnv: { projectId: 'p1', projectName: 'Site' } }))).toEqual({ to: '/projects/p1', testId: 'notification-project-link' })
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

test('a reset link made for me says who made it, and how to stop it while it still works (QA TC-202)', () => {
  const reset = (resetLink: { server: boolean; by: string | null; open: boolean }) => notice({ eventType: 'account.reset_link', code: 'account.reset_link', link: null, chatId: null, outcome: null, resetLink })
  expect(text(reset({ server: true, by: null, open: true }))).toBe('서버에서 내 계정의 비밀번호 재설정 링크를 만들었어요. 내가 부탁한 게 아니면 보안·기기에서 비밀번호를 바꿔 주세요. 그러면 링크가 바로 막혀요.')
  expect(text(reset({ server: false, by: 'Adam', open: false }), 'en')).toBe('Adam made a password reset link for your account.')
  expect(text(reset({ server: false, by: null, open: false }))).toBe(ko('notifications.resetLink.admin'))
  // an older server without the details: the plain line
  expect(text(notice({ eventType: 'account.reset_link', code: 'account.reset_link', link: null, chatId: null, outcome: null }))).toBe(ko('notifications.event.account.reset_link'))
  // while it works the row opens Settings › 보안·기기, where changing the password ends it; after, it opens nothing
  expect(noticeLink(reset({ server: true, by: null, open: true }))).toEqual({ to: '/settings/security', testId: 'notification-reset-link-link' })
  expect(noticeLink(reset({ server: true, by: null, open: false }))).toBeNull()
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

test('the Inbox: a run is one link with its task, time and dot that reads it; no link, 읽음 표시; a job log is never shown', async () => {
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
    // a job: the row opens its chat; it says the result in plain words and never shows the log (older servers still send it)
    expect(rows[3]!.querySelector('a')).not.toBeNull()
    expect(rows[3]!.querySelector('[data-testid="notification-job-tail"]')).toBeNull()
    expect(rows[3]!.textContent).not.toContain('npm ERR!')
    // the click reads the notice
    await m.click(link)
    await m.until(() => reads.length > 0, 'the read')
    expect(reads).toEqual([run.id])
  } finally { await m.unmount() }
})

test('a job\'s result in plain words: done, ended with the result unknown (no code, not stopped), not done (QA TC-6586)', () => {
  const job = (exitCode: number | null, reason?: string) => notice({ eventType: 'dev_env.job', code: 'dev_env.job', outcome: null, devEnv: { projectId: '', projectName: '', job: { name: 'j', exitCode, ...(reason ? { reason } : {}) } } })
  expect(text(job(0), 'en')).toBe(en('notifications.event.dev_env.jobDone').replaceAll("'", '&#x27;'))
  expect(text(job(null, 'lost'), 'en')).toBe(en('notifications.event.dev_env.jobUnknown').replaceAll("'", '&#x27;'))
  expect(text(job(null, 'lost'), 'en')).not.toContain("couldn")
  expect(text(job(3), 'en')).toBe(en('notifications.event.dev_env.jobFailed').replaceAll("'", '&#x27;'))
  expect(text(job(null, 'setting'), 'en')).toBe(en('notifications.event.dev_env.jobFailed').replaceAll("'", '&#x27;'))
})

test('a request whose job ended while its answer ran: "finished" only when the answer finished, else stopped and why (owner 11-22)', () => {
  const req = (request: NonNullable<InboxNotification['devEnv']>['request']) => notice({ eventType: 'dev_env.job', code: 'dev_env.job', sourceId: 'turn-t1', outcome: null, devEnv: { projectId: '', projectName: '', request } })
  expect(text(req({ outcome: 'done', chatTitle: '트리숲 홍보영상 제작' }))).toBe('‘<bdi>트리숲 홍보영상 제작</bdi>’에서 부탁한 작업을 트리나가 마쳤어요.')
  expect(text(req({ outcome: 'stopped', reason: 'limit', chatTitle: '트리숲 홍보영상 제작' }))).toBe('‘<bdi>트리숲 홍보영상 제작</bdi>’에서 부탁한 작업이 멈췄어요 — 한 번에 할 수 있는 단계나 시간 한도에 닿았어요. 채팅에서 이어서 부탁해 보세요.')
  expect(text(req({ outcome: 'stopped', reason: 'error' }))).toBe('부탁한 작업이 멈췄어요 — 오류가 났어요. 채팅에서 확인해 보세요.')
  for (const reason of ['limit', 'error', 'stopped', 'restart', 'question'] as const) {
    const t = text(req({ outcome: 'stopped', reason, chatTitle: 'Launch' }), 'en')
    expect(t).toContain(en(`notifications.event.dev_env.requestWhy.${reason}`).replaceAll("'", '&#x27;'))
    expect(t).not.toContain('finished')
  }
})

test('"tried to use Trina but it isn\'t set up yet": the name while the account is there, else a team member; the AI accounts page', () => {
  const ask = (o: Partial<InboxNotification> = {}) => notice({ eventType: 'onboarding.ai_request', code: 'onboarding.ai_request', sourceId: 'not-ready:u1', chatId: null, link: 'admin_credentials', outcome: null, ...o })
  expect(text(ask({ notReady: true, requester: { name: 'Mia' } }), 'en')).toBe("Mia tried to use Trina but it isn&#x27;t set up yet.")
  expect(text(ask({ notReady: true }), 'en')).toBe("A team member tried to use Trina but it isn&#x27;t set up yet.")
  // the ask for an AI connection keeps its words
  expect(text(ask({ sourceId: 'u1', requester: { name: 'Mia' } }), 'en')).toBe(en('notifications.event.onboarding.ai_requestNamed', { name: 'Mia' }))
  expect(noticeLink(ask({ notReady: true }))?.to).toBe('/admin/providers')
})

test('a team template\'s notices follow how it signs in, and one no longer for me says so (QA TC-2980)', () => {
  const tpl = (o: Partial<InboxNotification>) => notice({ eventType: 'integration.template', code: 'integration.template', chatId: null, link: 'integrations', outcome: null, ...o })
  const re = (o: Partial<InboxNotification>) => tpl({ eventType: 'integration.template_reconnect', code: 'integration.template_reconnect', ...o })
  const key = { id: 't1', name: 'Acme Tasks' }
  const signIn = { id: 't2', name: 'Acme Wiki', signIn: true as const }
  expect(text(tpl({ template: key }), 'en')).toBe('Acme Tasks is ready: connect it with your own key.')
  expect(text(tpl({ template: signIn }), 'en')).toBe('Acme Wiki is ready: sign in with your own account.')
  expect(text(re({ template: key }), 'en')).toBe('Acme Tasks changed its address or sign-in: enter your own key again.')
  expect(text(re({ template: signIn }), 'en')).toBe('Acme Wiki changed its address or sign-in: sign in again with your own account.')
  // a sign-in template never says "key"
  for (const item of [tpl({ template: signIn }), re({ template: signIn })]) for (const l of ['en', 'ko'] as const) expect(text(item, l)).not.toMatch(/key|키/)
  expect(text(re({ template: signIn }), 'ko')).toBe('Acme Wiki의 주소나 로그인 방식이 바뀌었어요. 내 계정으로 다시 로그인해 주세요.')
  // no longer for me: one plain line, nothing to connect, no link
  const left = re({ template: { id: 't3', name: 'Acme Board' }, templateLeft: true, link: null })
  expect(text(left, 'en')).toBe('You no longer have access to Acme Board.')
  expect(noticeLink(left)).toBeNull()
  // the template gone: no name, and no key or sign-in named
  expect(text(re({ templateLeft: true, link: null }), 'en')).toBe('You no longer have access to a team template.')
  expect(text(re({ link: null }), 'en')).toBe('A team template changed: connect it again.')
  expect(text(tpl({ link: null }), 'en')).toBe('A team template is ready to connect.')
})
