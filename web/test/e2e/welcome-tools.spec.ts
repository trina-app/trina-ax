// Onboarding v6 in a real browser against the mock (docs/DECISIONS.md "W6 — Onboarding v6"):
// - the step order AI 연결 (only without AI) → 회사 소개 → 내 스킬 → 팀 파일 → 도구 연결 → 팀원 초대 → 준비 끝, n/5;
// - 도구 연결: the Drive row where this server has Drive (members may not connect yet: the line names both effects; the
//   confirmed account turns that switch on, a cancel or "다른 계정" changes nothing; the hosting service down says so),
//   the one "다른 도구 연결하기 (MCP)" line (today's add-a-connection dialog: 취소 leaves the step as it was, a saved one
//   with its sign-in is one line under it), 나중에 하기 / 다음 and ← 이전;
// - after the setup the one way back is Settings › 커넥터: the Drive card's owner/admin button names both effects;
// - 준비 끝: "'카드뉴스' 만들어 보기" for the first kept skill the team has, which opens that skill's form on 팀 스킬 only.
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

/** The owner's steps up to 도구 연결: 회사 소개, 내 스킬 and 팀 파일 put off. */
async function toTools(page: Page) {
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await expect(page.getByTestId('welcome-progress')).toContainText('2/5 스킬')
  await page.getByTestId('skills-later').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
}

test('도구 연결 with Drive: the step order (n/5); [연결] names both effects; Google\'s window; 다른 계정 changes nothing; 맞아요 turns the members\' switch on with the connection; 다음: 팀원 초대; ← 이전 both ways', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  const drive = await fakeDrive(page)
  await signIn(page)
  await toTools(page)
  const bar = page.getByTestId('welcome-progress')
  await expect(bar.locator('li')).toHaveText(['1/5 회사 소개 · 나중에 하기로 했어요', '2/5 스킬 · 나중에 하기로 했어요', '3/5 팀 파일 · 나중에 하기로 했어요', '4/5 도구 연결', '5/5 팀원 초대'])
  await expect(bar.locator('[aria-current="step"]')).toContainText('4/5 도구 연결')
  const tools = page.getByTestId('welcome-tools')
  await expect(tools.getByRole('heading', { name: '자주 쓰는 도구를 연결해 둘까요?' })).toBeVisible()
  await expect(tools).toContainText('지금 안 해도 나중에 커넥터에서 할 수 있어요.')
  await expect(page.getByTestId('welcome-tools-drive-line')).toHaveText('트리나가 내 드라이브를 읽어요(읽기만) · 연결하면 팀원도 각자 자기 드라이브를 연결할 수 있게 돼요')
  await expect(page.getByTestId('welcome-tools-mcp-add')).toHaveText('다른 도구 연결하기')
  // nothing connected: no primary, 나중에 하기 only; Higgsfield is not offered
  await expect(page.getByTestId('welcome-tools-next')).toHaveCount(0)
  await expect(page.getByTestId('welcome-later')).toBeVisible()
  await expect(tools).not.toContainText(/Higgsfield|힉스필드/)

  // [연결]: Google's window; the row waits; the account to confirm
  const popup = page.waitForEvent('popup')
  await page.getByTestId('welcome-tools-drive-connect').click()
  await popup
  expect(drive.authorized).toBe(1)
  await expect(page.getByTestId('welcome-tools-drive-confirm')).toContainText('olga@acme.example 계정이 맞나요?')
  // 다른 계정: back to [연결], nothing confirmed or switched
  await page.getByTestId('welcome-tools-drive-other').click()
  await expect(page.getByTestId('welcome-tools-drive-connect')).toBeVisible()
  expect(drive.completed).toEqual([])
  expect(drive.cancelled).toBe(1)
  // again, 맞아요: confirmed with the switch named (membersOn), connected; the primary replaces 나중에 하기
  const again = page.waitForEvent('popup')
  await page.getByTestId('welcome-tools-drive-connect').click()
  await again
  await page.getByTestId('welcome-tools-drive-yes').click()
  await expect(page.getByTestId('welcome-tools-drive-connected')).toHaveText('연결됨 · olga@acme.example')
  expect(drive.completed).toEqual([{ membersOn: true }])
  await expect(page.getByTestId('welcome-tools-next')).toHaveText('다음: 팀원 초대')
  await expect(page.getByTestId('welcome-later')).toHaveCount(0)
  // ← 이전: 팀 파일 (its 다음 says 도구 연결), and back
  await page.getByTestId('welcome-back').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('welcome-tools-drive-connected')).toBeVisible()
  await page.getByTestId('welcome-tools-next').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  expect((await (await page.request.get('/api/onboarding/welcome')).json()).progress.steps.tools).toBe('done')
  // ← 이전 from the invite: 도구 연결, still connected
  await page.getByTestId('welcome-back').click()
  await expect(page.getByTestId('welcome-tools-drive-connected')).toBeVisible()
  await expect(page.getByTestId('welcome-tools-next')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('도구 연결\'s exits: a refused or closed sign-in says "연결하지 않았어요"; the hosting service down says so; 나중에 하기 puts it off', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await fakeDrive(page, { flow: 'failed' })
  await signIn(page)
  await toTools(page)
  const popup = page.waitForEvent('popup')
  await page.getByTestId('welcome-tools-drive-connect').click()
  await popup
  await expect(page.getByTestId('welcome-tools-drive-note')).toHaveText('연결하지 않았어요 · 회사 Google 계정은 Google 관리자가 허용해야 연결돼요')
  await expect(page.getByTestId('welcome-tools-drive-connect')).toBeVisible()
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  // the hosting service's Google sign-in is down at the press
  await fakeDrive(page, { authorize: 'broker_down' })
  await page.reload()
  await expect(page.getByTestId('welcome-tools-drive-connect')).toBeVisible()
  await page.getByTestId('welcome-tools-drive-connect').click()
  await expect(page.getByTestId('welcome-tools-drive-note')).toHaveText('지금은 Google 연결을 할 수 없어요 · 나중에 커넥터에서 해요')
  // 나중에 하기: put off, on to the invite
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  expect((await (await page.request.get('/api/onboarding/welcome')).json()).progress.steps.tools).toBe('skipped')
  // the 503 and the closed popup are the only errors the browser logs
  expect(realErrors(errors).filter((e) => !/status of 503/.test(e))).toEqual([])
})

test('no Drive on this server: the MCP line alone; its dialog (today\'s, a team connection) closes with nothing changed; a saved one signs in and is one line under it; the primary appears', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await toTools(page)
  await expect(page.getByTestId('welcome-tools-mcp-add')).toBeVisible()
  await expect(page.getByTestId('welcome-tools-drive')).toHaveCount(0)
  // the dialog opens over the step; 취소 leaves it as it was
  await page.getByTestId('welcome-tools-mcp-add').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('integration-name')).toBeVisible()
  await dialog.getByRole('button', { name: '취소' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('welcome-tools-mcp-list')).toHaveCount(0)
  await expect(page.getByTestId('welcome-tools-next')).toHaveCount(0)
  // a connection saved: its sign-in in the window reserved during the click, then "연결됨 · {name}"
  await page.getByTestId('welcome-tools-mcp-add').click()
  await dialog.getByTestId('integration-name').fill('Acme Tools')
  await dialog.getByTestId('integration-url').fill('https://mcp.acme.example/mcp')
  await expect(dialog.getByTestId('integration-save')).toHaveText('저장하고 로그인')
  const popup = page.waitForEvent('popup')
  await dialog.getByTestId('integration-save').click()
  await popup
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('welcome-tools-mcp-item')).toHaveText('연결됨 · Acme Tools', { timeout: 10_000 })
  await expect(page.getByTestId('welcome-tools-next')).toHaveText('다음: 팀원 초대')
  // an ordinary team connection in Admin › 커넥터
  const team = (await (await page.request.get('/api/admin/integrations')).json()).items as { name: string; scope: string }[]
  expect(team.map((x) => [x.name, x.scope])).toContainEqual(['Acme Tools', 'team'])
  await page.getByTestId('welcome-tools-next').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('준비 끝: "\'카드뉴스\' 만들어 보기" for the first kept skill in the team; it opens that skill\'s form on 팀 스킬 only, nothing runs; closing the form stays on 팀 스킬', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  // the team put the general pack in on a press (the Team skills page)
  expect((await page.request.post('/api/onboarding/packs/general/install', { headers: { [CSRF_HEADER]: '1' } })).ok()).toBe(true)
  await toTools(page)
  await page.getByTestId('welcome-later').click()
  await page.getByTestId('invite-step-done').click()
  const make = page.getByTestId('welcome-done-make')
  await expect(make).toHaveText("'카드뉴스' 만들어 보기")
  await expect(page.getByTestId('welcome-done-home')).toHaveText('홈으로')
  const chats = ((await (await page.request.get('/api/chats')).json()).items as unknown[]).length
  await make.click()
  await expect.poll(() => { const u = new URL(page.url()); return `${u.pathname} ${u.searchParams.get('run')}` }).toBe('/skills skills/general/card-news/SKILL.md')
  const form = page.getByTestId('skill-form')
  await expect(form).toBeVisible()
  await expect(form).toContainText('카드뉴스')
  // the form's defaults read the company intro (its own placeholder); nothing was sent from 준비 끝
  await expect(form.getByPlaceholder('비워 두면 회사 소개 전체')).toBeVisible()
  expect(((await (await page.request.get('/api/chats')).json()).items as unknown[]).length).toBe(chats)
  // closing the form: 팀 스킬, nothing ran
  await page.keyboard.press('Escape')
  await expect(form).toHaveCount(0)
  await expect(page).toHaveURL(/\/skills$/)
  expect(((await (await page.request.get('/api/chats')).json()).items as unknown[]).length).toBe(chats)
  expect(realErrors(errors)).toEqual([])
})

test('after the setup, Connectors (old Settings address): an owner with the members\' switch off gets one button that names both effects; it confirms with membersOn; a member still reads "관리자가 먼저 켜야 해요"', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  const drive = await fakeDrive(page)
  await signIn(page)
  await page.goto('/settings/drive')
  const detail = page.getByTestId('drive-detail')
  await expect(detail.getByTestId('drive-connect')).toHaveText('팀원도 연결할 수 있게 켜고 내 드라이브 연결하기')
  await expect(detail).not.toContainText('관리자가 먼저 켜야 해요')
  const popup = page.waitForEvent('popup')
  await detail.getByTestId('drive-connect').click()
  await popup
  await detail.getByTestId('drive-confirm').click()
  await expect(detail.getByTestId('drive-detail-line')).toHaveText('olga@acme.example')
  expect(drive.completed).toEqual([{ membersOn: true }])
  expect(realErrors(errors)).toEqual([])
  // a member, with the switch off: the admin turns it on first, as before (a member's Home asks for a few things only
  // admins have, answered 404)
  drive.now = { ...drive.now, status: 'disconnected', account: null, personalAllowed: false }
  await page.context().clearCookies()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await page.goto('/settings/drive')
  await expect(page.getByTestId('drive-detail').getByTestId('drive-detail-line')).toHaveText('관리자가 먼저 켜야 해요')
  await expect(page.getByTestId('drive-detail').getByTestId('drive-connect')).toBeDisabled()
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
})
