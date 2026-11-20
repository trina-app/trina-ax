// Onboarding v6 in a real browser against the mock (docs/DECISIONS.md "W6 — Onboarding v6"):
// - the step order AI 연결 (only without AI) → 회사 소개 → 내 스킬 → 팀 파일 → 도구 연결 → 팀원 초대 → 준비 끝, n/5;
// - 팀이 쓸 도구 (docs/decisions/20261120-team-vs-personal-onboarding.md): one list: Notion as a team connection
//   ([팀으로 연결], one team connection everyone may use, signed in for the team), Google Drive (where this server has it)
//   as [팀 추천], saved at once, never a personal sign-in; the one "다른 도구 보기" line (Settings › Connectors over the
//   step: its close, Esc and Back come back to the step; a tool's page has the same 팀 추천 switch); recommended tools
//   first in a member's list; 나중에 하기 / 다음 and ← 이전;
// - after the setup the one way back is Settings › 커넥터: the Drive card's owner/admin button names both effects;
// - 준비 끝: the five steps summed up (✓ and a fact, or 나중에 하기로 했어요 with 지금 하기), "내 설정 시작" to Home.
// Google is answered by the page's own routes (the mock has no Google client), as in drive.spec.ts.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const account = { name: 'Olga Kim', email: 'olga@acme.example' }
const expiresAt = '2099-01-01T00:00:00.000Z'

/** Answers the Drive addresses like a server with a Google client whose members' switch is off (`personalAllowed`
 * false); `state` says what was asked. `flow`: what each poll of the sign-in answers. */
async function fakeDrive(page: Page, o: { authorize?: 'ok' | 'broker_down'; flow?: 'ready' | 'failed' } = {}) {
  const state = {
    now: { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null, personalAllowed: false, teamShares: [] } as Record<string, unknown>,
    authorized: 0, completed: [] as unknown[], cancelled: 0,
  }
  await page.context().route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic Google consent</p>' }))
  await page.route('**/api/integrations/google-drive', (r) => r.fulfill({ json: state.now }))
  await page.route('**/api/integrations/google-drive/authorize', (r) => {
    state.authorized++
    if (o.authorize === 'broker_down') return r.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'drive_broker_unavailable' } } })
    return r.fulfill({ json: { flowId: 'fixture-flow', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic', expiresAt } })
  })
  await page.route('**/api/integrations/google-drive/flows/**', (r) => {
    const m = r.request().method()
    if (m === 'DELETE') { state.cancelled++; return r.fulfill({ status: 204 }) }
    if (m === 'POST') {
      state.completed.push(r.request().postDataJSON())
      state.now = { ...state.now, status: 'connected', account, personalAllowed: true }
      return r.fulfill({ json: state.now })
    }
    return r.fulfill({ json: o.flow === 'failed'
      ? { flowId: 'fixture-flow', state: 'failed', account: null, expiresAt, reason: 'consent_denied' }
      : { flowId: 'fixture-flow', state: 'ready', account, expiresAt, reason: null } })
  })
  return state
}

const recommended = async (page: Page) => (await (await page.request.get('/api/admin/settings')).json()).recommendedTools

/** The owner's steps up to 팀이 쓸 도구: 회사 소개, 내 스킬 and 팀 파일 put off. */
async function toTools(page: Page) {
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await expect(page.getByTestId('welcome-progress')).toContainText('2/5 스킬')
  await page.getByTestId('skills-later').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
}

test('팀이 쓸 도구 with Drive: the step order (n/5); one list (Notion for the team, Drive 팀 추천); 팀 추천 saves the team\'s list, no Google window; 다음: 팀원 초대; ← 이전 both ways', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  const drive = await fakeDrive(page)
  await signIn(page)
  let popups = 0
  page.on('popup', () => { popups++ })
  await toTools(page)
  const bar = page.getByTestId('welcome-progress')
  await expect(bar.locator('li')).toHaveText(['1/5 회사 소개 · 나중에 하기로 했어요', '2/5 스킬 · 나중에 하기로 했어요', '3/5 팀 파일 · 나중에 하기로 했어요', '4/5 팀 도구', '5/5 팀원 초대'])
  await expect(bar.locator('[aria-current="step"]')).toContainText('4/5 팀 도구')
  const tools = page.getByTestId('welcome-tools')
  await expect(tools.getByRole('heading', { name: '팀이 쓸 도구' })).toBeVisible()
  await expect(tools).toContainText('팀이 같이 쓸 도구는 여기서 한 번 연결하고, 각자 자기 계정으로 쓰는 도구는 추천해 두세요. 언제든 설정 › 커넥터에서 바꿀 수 있어요.')
  const notion = page.locator('[data-testid="welcome-tools-service"][data-id="notion"]')
  await expect(notion).toHaveAttribute('data-kind', 'team')
  await expect(notion).toContainText('팀 전체가 이 연결을 같이 써요')
  await expect(notion.getByTestId('welcome-tools-team-connect')).toHaveText('팀으로 연결')
  const drv = page.locator('[data-testid="welcome-tools-service"][data-id="google-drive"]')
  await expect(drv).toHaveAttribute('data-kind', 'recommend')
  await expect(drv).toContainText('각자 자기 계정으로 연결해요')
  await expect(page.getByTestId('welcome-tools-mcp-add')).toHaveText('다른 도구 보기')
  // nothing done: no primary, 나중에 하기 only; Higgsfield is not offered
  await expect(page.getByTestId('welcome-tools-next')).toHaveCount(0)
  await expect(page.getByTestId('welcome-later')).toBeVisible()
  await expect(tools).not.toContainText(/Higgsfield|힉스필드/)
  // 팀 추천 on Drive: saved for the team at once, no Google sign-in (the switch's label takes the press, its checkbox
  // sits under the track, as in admin-engines.spec.ts)
  await drv.locator('label').click()
  await expect(drv.getByRole('checkbox', { name: '팀 추천' })).toBeChecked()
  await expect(drv).toHaveAttribute('data-state', 'recommended')
  await expect.poll(() => recommended(page)).toEqual(['google-drive'])
  expect(drive.authorized).toBe(0)
  expect(popups).toBe(0)
  await expect(page.getByTestId('welcome-tools-next')).toHaveText('다음: 팀원 초대')
  await expect(page.getByTestId('welcome-later')).toHaveCount(0)
  // ← 이전: 팀 파일 (its 다음 says the step), and back: still recommended
  await page.getByTestId('welcome-back').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(drv).toHaveAttribute('data-state', 'recommended')
  await page.getByTestId('welcome-tools-next').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  expect((await (await page.request.get('/api/onboarding/welcome')).json()).progress.steps.tools).toBe('done')
  // ← 이전 from the invite: the step, as it was
  await page.getByTestId('welcome-back').click()
  await expect(drv).toHaveAttribute('data-state', 'recommended')
  await expect(page.getByTestId('welcome-tools-next')).toBeVisible()
  // nothing was connected on the way
  expect((await (await page.request.get('/api/integrations')).json()).items).toEqual([])
  expect(drive.completed).toEqual([])
  expect(realErrors(errors)).toEqual([])
})

test('팀이 쓸 도구: 나중에 하기 puts it off with nothing done', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await toTools(page)
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  expect((await (await page.request.get('/api/onboarding/welcome')).json()).progress.steps.tools).toBe('skipped')
  expect(await recommended(page)).toEqual([])
  expect(realErrors(errors)).toEqual([])
})

test('Notion [팀으로 연결]: ONE team connection everyone may use (never the owner\'s own), its sign-in for the team, then 연결됨 and the primary', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await toTools(page)
  const notion = page.locator('[data-testid="welcome-tools-service"][data-id="notion"]')
  await expect(notion).toHaveAttribute('data-state', 'available')
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/admin/integrations') && r.method() === 'POST')
  const popup = page.waitForEvent('popup')
  await notion.getByTestId('welcome-tools-team-connect').click()
  expect((await sent).postDataJSON()).toEqual({ kind: 'mcp', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } })
  await popup
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(notion).toHaveAttribute('data-state', 'connected', { timeout: 10_000 })
  await expect(notion.getByTestId('welcome-tools-team-on')).toContainText('연결됨')
  await expect(page.getByTestId('welcome-tools-next')).toHaveText('다음: 팀원 초대')
  // a team connection, for everyone; the owner has no connection of their own
  const team = (await (await page.request.get('/api/admin/integrations')).json()).items as { name: string; scope: string; access: { everyone: boolean } }[]
  expect(team.map((x) => [x.name, x.scope, x.access.everyone])).toEqual([['Notion', 'team', true]])
  const mine = (await (await page.request.get('/api/integrations')).json()).items as { scope: string }[]
  expect(mine.filter((x) => x.scope === 'personal')).toEqual([])
  expect(realErrors(errors)).toEqual([])
})

test('no Drive on this server: Notion and "다른 도구 보기"; that line opens Settings › Connectors over the step, and its close, Esc and Back come back to it; 팀 추천 on a tool\'s page there counts', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await toTools(page)
  await expect(page.getByTestId('welcome-tools-mcp-add')).toBeVisible()
  // not on this server: no Drive row in the setup (Connectors says why)
  await expect(page.locator('[data-testid="welcome-tools-service"][data-id="google-drive"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="welcome-tools-service"][data-id="notion"]')).toBeVisible()
  await expect(page.getByTestId('welcome-tools')).not.toContainText(/Linear|Atlassian|Canva|Figma/)
  // the full list: Settings › Connectors, a dialog over the step
  await page.getByTestId('welcome-tools-mcp-add').click()
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  const settings = page.getByTestId('settings-dialog')
  await expect(settings.getByTestId('connector-discover')).toBeVisible()
  await settings.getByTestId('settings-close').click()
  await expect(settings).toHaveCount(0)
  await expect(page).toHaveURL(/\/welcome$/)
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
  await expect(page.getByTestId('welcome-tools-next')).toHaveCount(0)
  await expect(page.getByTestId('welcome-later')).toBeVisible()
  // the browser's Back from there: the step too
  await page.getByTestId('welcome-tools-mcp-add').click()
  await expect(settings.getByTestId('connector-discover')).toBeVisible()
  await page.goBack()
  await expect(settings).toHaveCount(0)
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
  // Esc: the step too
  await page.getByTestId('welcome-tools-mcp-add').click()
  await expect(settings.getByTestId('connector-discover')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
  // Linear's page in the list: the owner's "팀에 추천하기" (no sign-in); it counts here once Settings closes
  await page.getByTestId('welcome-tools-mcp-add').click()
  await settings.locator('[data-testid="connector-card"][data-id="linear"]').getByTestId('connector-open').click()
  const row = settings.getByTestId('team-recommend')
  await expect(row).toContainText('팀에 추천하기')
  await expect(row).toContainText('모두의 목록 맨 위에 보여요. 연결은 각자 자기 계정으로 해요.')
  await row.locator('label').last().click()
  await expect(row.getByRole('checkbox', { name: '팀에 추천하기' })).toBeChecked()
  await expect.poll(() => recommended(page)).toEqual(['linear'])
  await settings.getByTestId('settings-close').click()
  await expect(settings).toHaveCount(0)
  await expect(page).toHaveURL(/\/welcome$/)
  await expect(page.getByTestId('welcome-tools-next')).toHaveText('다음: 팀원 초대', { timeout: 10_000 })
  await page.getByTestId('welcome-tools-next').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  expect((await (await page.request.get('/api/onboarding/welcome')).json()).progress.steps.tools).toBe('done')
  expect(realErrors(errors)).toEqual([])
})

test('"Set up" in the list opened from the step (Google Drive on a server without a Google client) goes to Admin with "Back to getting started", which returns to the step', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await toTools(page)
  await page.getByTestId('welcome-tools-mcp-add').click()
  const settings = page.getByTestId('settings-dialog')
  const drive = settings.locator('[data-testid="connector-card"][data-id="google-drive"]')
  await drive.getByTestId('connector-set-up').click()
  await expect(page).toHaveURL(/\/admin\/connectors/)
  await expect(settings).toHaveCount(0)
  // Admin shows the steps' way back
  await page.getByTestId('setup-return-button').click()
  await expect(page).toHaveURL(/\/welcome$/)
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
  await expect(page.getByTestId('welcome-later')).toBeVisible()
  // opened from anywhere else (Settings directly), "Set up" carries no way back to the steps
  await page.goto('/settings/connectors')
  await settings.locator('[data-testid="connector-card"][data-id="google-drive"]').getByTestId('connector-set-up').click()
  await expect(page).toHaveURL(/\/admin\/connectors/)
  await expect(page.getByTestId('setup-return')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('a member\'s list: the team\'s picks first, marked 팀 추천; nothing gated (every other tool still there); no 팀 추천 switch for a member', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  expect((await page.request.patch('/api/admin/settings', { headers: { [CSRF_HEADER]: '1' }, data: { recommendedTools: ['linear', 'notion'] } })).ok()).toBe(true)
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/settings/connectors')
  const settings = page.getByTestId('settings-dialog')
  await expect(settings.getByTestId('connector-discover')).toBeVisible()
  const cards = settings.locator('[data-testid="connector-card"]')
  await expect(cards.nth(0)).toHaveAttribute('data-id', 'linear')
  await expect(cards.nth(1)).toHaveAttribute('data-id', 'notion')
  await expect(cards.nth(0)).toContainText('팀 추천 ·')
  await expect(cards.nth(2)).not.toContainText('팀 추천')
  expect(await cards.count()).toBeGreaterThan(2)
  // a tool's page: Connect as ever, no team switch for a member
  await cards.nth(1).getByTestId('connector-open').click()
  await expect(settings.getByTestId('connector-connect')).toBeVisible()
  await expect(settings.getByTestId('team-recommend')).toHaveCount(0)
  expect(realErrors(errors).filter((e) => !/status of 40[34]/.test(e))).toEqual([])
})

test('준비 끝: the five steps summed up (✓ with a fact, or 나중에 하기로 했어요 with 지금 하기); no first result; "내 설정 시작" goes Home', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await toTools(page)
  await page.getByTestId('welcome-later').click()
  await page.getByTestId('invite-step-done').click()
  const done = page.getByTestId('welcome-done')
  await expect(done).toContainText('준비 끝났어요')
  const rows = page.getByTestId('welcome-done-row')
  await expect(rows).toHaveCount(5)
  await expect(rows.nth(0)).toHaveAttribute('data-step', 'profile')
  await expect(rows.nth(3)).toHaveAttribute('data-state', 'later')
  await expect(rows.nth(3)).toContainText('팀 도구 · 나중에 하기로 했어요')
  await expect(rows.nth(3).getByTestId('welcome-done-later-open')).toHaveText('지금 하기')
  await expect(rows.nth(4)).toHaveAttribute('data-state', 'done')
  await expect(done).not.toContainText('만들어 보기')
  await expect(done).not.toContainText('회사 소개서')
  await expect(page.getByTestId('welcome-done-next')).toHaveText('다음은 내 설정이에요 · 내 도구 연결, 사진, 앱')
  await expect(page.getByTestId('welcome-done-home')).toHaveText('내 설정 시작')
  // 지금 하기 on 팀 도구: the step opens here; put off again, back to the end screen
  await rows.nth(3).getByTestId('welcome-done-later-open').click()
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(done).toBeVisible()
  await page.getByTestId('welcome-done-home').click()
  await expect(page).toHaveURL(/\/$/)
  expect(realErrors(errors)).toEqual([])
})

test('after the setup, Connectors (old Settings address): Connect for everyone, even with an old "members off" (no members\' switch)', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  const drive = await fakeDrive(page)
  await signIn(page)
  await page.goto('/settings/drive')
  const detail = page.getByTestId('drive-detail')
  await expect(detail.getByTestId('drive-connect')).toHaveText('연결')
  const popup = page.waitForEvent('popup')
  await detail.getByTestId('drive-connect').click()
  await popup
  await detail.getByTestId('drive-confirm').click()
  await expect(detail.getByTestId('drive-detail-line')).toHaveText('olga@acme.example')
  expect(drive.completed).toEqual([{}])
  expect(realErrors(errors)).toEqual([])
  // a member, on a server that still says "personalAllowed: false" (an older one): Connect all the same
  drive.now = { ...drive.now, status: 'disconnected', account: null, personalAllowed: false }
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/settings/drive')
  await expect(page.getByTestId('drive-detail').getByTestId('drive-connect')).toBeEnabled()
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})
