// A finished background job of the dev environment in 활동 (docs/AGENTS/plan/20261121-0250-devenv-job-notice-plain.md),
// at 1440 wide: one plain line about the result in the chat it was asked in ("‘…’에서 부탁한 작업을 트리나가 마쳤어요."),
// no job name, exit code or log, and the row opens that chat. With SHOTS=1 it saves the list and the notice's own view
// into $SHOTS_DIR (default test-results/devenv-job-notice). BEFORE=1 lists the job as dev's server did (with its log
// tail and English end note) and checks nothing, for the before shots of a dev build.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const id = (n: number) => `019a6100-0000-7000-8000-${String(n).padStart(12, '0')}`
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const CHAT = '019a6100-0000-7000-8000-00000000c4a7'
const TITLE = '미나 런칭 영상'
const TAIL = '@hf-progress {"code":"encode","done":815,"total":900}\n89% Encoding frame 822/900\n@hf-progress {"code":"encode","done":900,"total":900}\nrender.mp4 written'
const before = !!process.env.BEFORE
const job = (n: number, minutes: number, exitCode: number | null, name: string, extra: Record<string, unknown> = {}) => ({
  id: id(n), eventType: 'dev_env.job', sourceId: `run-${n}`, code: 'dev_env.job', createdAt: ago(minutes), readAt: null, chatId: CHAT, link: 'chat', outcome: null,
  devEnv: { projectId: '', projectName: '', job: { name, exitCode, ...(before ? { note: exitCode === null ? 'stopped: it reached its time limit' : '', tail: TAIL } : { chatTitle: TITLE }), ...extra } },
})
const DONE = job(1, 3, 0, 'render')
const FAILED = job(2, 40, null, 'render-2', { reason: 'timeout' })

async function route(page: Page) {
  const list = { items: [DONE, FAILED], nextCursor: null, unreadCount: 2, roomUnreadCount: 0, noticeUnreadCount: 2 }
  await page.route((u) => u.pathname === '/api/notifications', (r) => r.fulfill({ json: list }))
  // the notice's own view reads it and marks it read (the mock has no such notice)
  await page.route((u) => u.pathname.startsWith('/api/notifications/019a6100'), (r) => r.fulfill({ json: r.request().method() === 'GET' ? DONE : { ...DONE, readAt: ago(0) } }))
}

const dir = process.env.SHOTS_DIR ?? 'test-results/devenv-job-notice'
const tag = before ? 'before' : 'after'

test('1440 wide: a finished job says the result in plain words, with no log, and opens its chat', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' })
  const page = await ctx.newPage()
  await reset(page)
  await signIn(page)
  await route(page)
  await page.goto('/activity')
  const texts = page.getByTestId('activity-panel-text')
  await expect(texts.first()).toBeVisible()
  if (!before) {
    await expect(texts).toHaveText([`‘${TITLE}’에서 부탁한 작업을 트리나가 마쳤어요.`, `‘${TITLE}’에서 부탁한 작업을 트리나가 끝내지 못했어요. 채팅에서 확인해 보세요.`])
    for (const bad of ['render', '종료 코드', 'hf-progress', 'Encoding']) await expect(page.getByText(bad, { exact: false })).toHaveCount(0)
  }
  if (process.env.SHOTS) await page.screenshot({ path: `${dir}/${tag}-list-1440.png` })
  // the notice's own view (what a push or a link opens): the same line, no log under it, and a link to the chat
  await page.goto(`/activity?n=${encodeURIComponent(DONE.id)}`)
  await expect(page.getByTestId('notification-text').first()).toBeVisible()
  if (!before) {
    await expect(page.getByTestId('notification-text').first()).toHaveText(`‘${TITLE}’에서 부탁한 작업을 트리나가 마쳤어요.`)
    await expect(page.getByTestId('notification-job-tail')).toHaveCount(0)
    await expect(page.getByTestId('notification-chat-link').first()).toHaveAttribute('href', `/c/${CHAT}`)
  }
  if (process.env.SHOTS) await page.screenshot({ path: `${dir}/${tag}-detail-1440.png` })
  await ctx.close()
})
