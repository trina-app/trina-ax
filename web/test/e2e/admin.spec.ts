import { expect, test, type Page } from '@playwright/test'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'
import { DICTS, translate } from '../../src/i18n'
import { PRODUCT } from '@mycel/shared'
import { CSRF_HEADER, ERROR_MESSAGES } from '@mycel/shared/api'

test('admin screens: members, groups, folder rules with "who sees what", engines, usage, audit, system', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.getByRole('link', { name: '관리자' }).click()
  // Admin opens on Home; members are first in the menu after it
  await expect(page.getByTestId('admin-home')).toBeVisible()
  await page.getByRole('navigation', { name: '관리자' }).getByRole('link', { name: DICTS.ko['admin.members'], exact: true }).click()
  await expect(page.getByTestId('members-table')).toContainText('Bob')

  // add a member: the temporary password field comes pre-filled with an easy one (word + digits), ↻ makes another,
  // the admin may type their own (8+ characters); after creating, the username and password are shown once
  await page.getByRole('button', { name: '직접 추가' }).click()
  await page.getByRole('dialog').getByLabel('이름', { exact: true }).fill('Carol')
  await page.getByRole('dialog').getByLabel('아이디').fill('carol')
  const temp = page.getByTestId('temp-password')
  const first = await temp.inputValue()
  expect(first).toMatch(/^[a-z]{4,7}[0-9]{4}$/)
  expect(first.length).toBeGreaterThanOrEqual(8)
  let other = first
  for (let i = 0; i < 5 && other === first; i++) {
    await page.getByTestId('temp-password-new').click()
    other = await temp.inputValue()
  }
  expect(other).not.toBe(first)
  expect(other).toMatch(/^[a-z]{4,7}[0-9]{4}$/)
  // the field is the input's own label (not the ↻ / copy buttons), and its hint is attached to the input
  await expect(page.getByRole('dialog').getByLabel('임시 비밀번호', { exact: true })).toHaveAttribute('data-testid', 'temp-password')
  // too short: the create button waits until it has 8 characters
  await temp.fill('short1')
  await expect(page.getByTestId('add-member-submit')).toBeDisabled()
  await expect(page.getByTestId('temp-password-error')).toHaveText('비밀번호는 8자 이상이어야 해요.')
  await expect(temp).toHaveAttribute('aria-invalid', 'true')
  // empty: says what to do instead of only greying out the button
  await temp.fill('')
  await expect(page.getByTestId('temp-password-error')).toContainText('↻')
  // spaces are dropped as typed (they would be invisible on the hand-over screen)
  await temp.fill('  tiger427 ')
  await expect(temp).toHaveValue('tiger427')
  // Hangul from a 한/영 key left on is refused with a hint
  await temp.fill('노ㅑㅜㄷ1234')
  await expect(page.getByTestId('temp-password-error')).toContainText('한/영')
  await expect(page.getByTestId('add-member-submit')).toBeDisabled()
  // the server's reason shows under the field, not as a toast, and goes away on the next try
  await temp.fill('12345678')
  await page.getByTestId('add-member-submit').click()
  await expect(page.getByTestId('temp-password-error')).toContainText('너무 흔한 비밀번호')
  await expect(page.getByRole('status').filter({ hasText: '너무 흔한' })).toHaveCount(0)
  await temp.fill('maple2026')
  await expect(page.getByTestId('temp-password-error')).toHaveCount(0)
  // another refusal (username taken) shows at the bottom of the dialog
  await page.getByRole('dialog').getByLabel('아이디').fill('bob')
  await page.getByTestId('add-member-submit').click()
  await expect(page.getByTestId('dialog-error')).toContainText('이미 쓰고 있는 아이디')
  await page.getByRole('dialog').getByLabel('아이디').fill('carol')
  await page.getByTestId('add-member-submit').click()
  // hand-over: the address, username and password (large) and the date it stops working
  await expect(page.getByTestId('handover-url')).toHaveText('https://team.example.com')
  await expect(page.getByTestId('handover-username')).toHaveText('carol')
  await expect(page.getByTestId('handover-password')).toHaveText('maple2026')
  await expect(page.getByTestId('handover-password')).toHaveClass(/text-xl/)
  await expect(page.getByTestId('handover-note')).toContainText('까지')
  await expect(page.getByTestId('dialog-error')).toHaveCount(0)
  await page.getByRole('button', { name: '주소·아이디·비밀번호 복사' }).click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toMatch(/^주소: https:\/\/team\.example\.com\n아이디: carol\n임시 비밀번호: maple2026\n.+까지 로그인해서 새 비밀번호로 바꿔 주세요\.$/)
  await page.getByRole('dialog').getByRole('button', { name: '완료' }).click()
  await expect(page.getByTestId('members-table')).toContainText('비밀번호 변경 필요')
  // reset is a labelled button in the row, not an icon only
  await expect(page.getByTestId('reset-password-carol')).toHaveText(/비밀번호 재설정/)

  // invite link with QR
  await page.getByTestId('invite-new').click()
  await page.getByTestId('invite-create').click()
  await page.getByRole('button', { name: 'QR 코드' }).click()
  await expect(page.getByRole('img', { name: 'QR 코드' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '완료' }).click()
  await expect(page.getByTestId('invite-list')).toContainText('팀원')

  // groups
  await page.getByRole('link', { name: '그룹' }).click()
  await page.getByTestId('group-new').click()
  await page.getByTestId('group-name').fill('영업팀')
  await page.getByRole('dialog').getByLabel('Bob').check()
  await page.getByTestId('group-save').click()
  await expect(page.getByTestId('group-list')).toContainText('영업팀')

  // folder rules: preview before saving
  await page.getByRole('link', { name: '폴더 권한' }).click()
  const folderTree = page.getByTestId('folder-tree')
  await expect(folderTree.locator('[data-path="finance"]')).toBeVisible()
  // the new group's own folder is in the tree too (groups/영업팀): choose the finance folder and change its rules
  await expect(folderTree.locator('[data-path="groups/영업팀"]')).toBeVisible()
  await folderTree.locator('[data-path="finance"]').click()
  await page.getByTestId('folder-detail-edit').click()
  // the edit panel: everyone reads; the server works out who gains (Bob is not in 재무팀) before anything is saved
  const panel = page.getByTestId('edit-panel')
  await panel.getByTestId('edit-basic-read').click()
  const result = panel.getByTestId('edit-result')
  await expect(result).toHaveAttribute('data-ready', 'true')
  await expect(result.getByTestId('edit-more')).toContainText('Bob')
  await expect(panel.getByTestId('edit-save')).toContainText('권한 늘어남')
  await panel.getByTestId('edit-save').click()
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId('folder-detail').getByTestId('folder-rules')).toContainText('모두: 읽기')
  await expect(folderTree.locator('[data-path="finance"]').getByTestId('tree-who')).toContainText('모두 · 읽기')

  // engines: what is missing, in plain words
  await page.getByRole('link', { name: 'AI 제공자' }).click()
  await expect(page.getByTestId('engine-card').first()).toContainText('연결됨')
  await expect(page.locator('[data-engine="codex"]').getByTestId('engine-detail')).toContainText('codex login --device-auth')

  await page.getByRole('link', { name: '사용량' }).click()
  await expect(page.getByTestId('usage-table')).toContainText('Olga')
  await page.getByRole('link', { name: '기록' }).click()
  // actions in words; the id stays in the tooltip
  await expect(page.getByTestId('audit-list')).toContainText('초대 링크 만듦')
  await expect(page.getByTestId('audit-list').locator('[title="invite.create"]').first()).toBeVisible()

  // owner only: diagnostics and backups with job progress
  await page.getByRole('link', { name: '시스템' }).click()
  await expect(page.getByTestId('diagnostics')).toContainText('Relay connection')
  await page.getByTestId('backup-now').click()
  await expect(page.getByText('백업을 만들었어요.')).toBeVisible()
  // the refusals asked for above (a common temporary password, a taken username) are the only failed requests
  expect(realErrors(errors).filter((e) => !/status of (400|409)/.test(e))).toEqual([])
  expect(realErrors(errors).filter((e) => /status of (400|409)/.test(e)).length).toBe(2)
})

test('members: a one-time password reset link to copy (no email); the owner has none', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/members')
  await expect(page.getByTestId('members-table')).toContainText('Bob')
  // the owner's own row has no reset buttons (the owner resets only on the server Mac)
  await expect(page.getByTestId('reset-link-olga')).toHaveCount(0)
  // the reset link is in the row's "…" menu
  await page.getByTestId('members-table').getByRole('row').filter({ hasText: 'Bob' }).getByTestId('member-more').click()
  await page.getByTestId('reset-link-bob').click()
  await expect(page.getByRole('dialog')).toContainText('24시간')
  await page.getByTestId('dialog-confirm').click()
  const value = page.getByTestId('secret-value')
  await expect(value).toHaveText(/^http:\/\/127\.0\.0\.1:\d+\/reset-password\/rst[0-9a-f]+$/)
  await expect(page.getByRole('dialog')).toContainText('한 번만')
  await page.getByRole('dialog').getByRole('button', { name: '링크 복사' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await value.textContent())
  await page.getByRole('dialog').getByRole('button', { name: '완료' }).click()
  expect(realErrors(errors)).toEqual([])
})

test('system: the relay connection asks for the team name; the official relay is not offered while it does not run', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/system')
  await page.getByRole('button', { name: '연결 방식 바꾸기' }).click()
  const mode = page.getByTestId('connection-mode')
  await expect(mode.locator('option')).toHaveText(['직접 운영하는 중계 서버', '사무실 안 직접 연결만'])
  await expect(mode.locator('option', { hasText: PRODUCT.displayName })).toHaveCount(0)
  const name = page.getByTestId('relay-team-name')
  await expect(name).toHaveValue('acme')
  await page.getByRole('dialog').getByRole('textbox', { name: '중계 서버 주소' }).fill('wss://relay.example.org/connect')
  await name.fill('Bad_Name')
  await expect(page.getByRole('dialog').getByRole('button', { name: '계속' })).toBeDisabled()
  await name.fill('acme-sales')
  await page.getByRole('dialog').getByRole('button', { name: '계속' }).click()
  await page.getByRole('dialog').getByLabel('비밀번호 다시 입력').fill('correct horse battery')
  await page.getByRole('dialog').getByRole('button', { name: '저장' }).click()
  await expect(page.getByText('저장했어요.')).toBeVisible()
  await expect(page.getByText('acme-sales')).toBeVisible()
  // office network only needs no team name
  await page.getByRole('button', { name: '연결 방식 바꾸기' }).click()
  await mode.selectOption('direct-only')
  await expect(page.getByTestId('relay-team-name')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('system: without the relay the Connection card names the public address the server has, not "office network only"', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  expect((await page.request.post('/__test/connection', { data: { mode: 'direct-only', address: null, state: 'disabled', detail: null, teamName: null, publicAddress: null } })).ok()).toBeTruthy()
  await page.goto('/admin/system')
  const line = page.getByTestId('connection-mode-name').locator('..')
  await expect(page.getByTestId('connection-mode-name')).toHaveText('사무실 안 직접 연결만')
  await expect(line).toContainText('꺼짐')
  // a public address set up (tunnel.host / --public-host, or the server's own domain): the team connects from outside
  expect((await page.request.post('/__test/connection', { data: { publicAddress: 'team.example.com' } })).ok()).toBeTruthy()
  await page.reload()
  await expect(page.getByTestId('connection-mode-name')).toHaveText('공개 주소로 직접 연결')
  await expect(page.getByText('https://team.example.com')).toBeVisible()
  await expect(line).not.toContainText('꺼짐')
  await page.getByRole('button', { name: '연결 방식 바꾸기' }).click()
  await expect(page.getByTestId('connection-mode').locator('option')).toHaveText(['직접 운영하는 중계 서버', '공개 주소로 직접 연결'])
  expect(realErrors(errors)).toEqual([])
})

test('members cannot open admin screens', async ({ page }) => {
  await reset(page)
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await expect(page.getByRole('link', { name: '관리자' })).toHaveCount(0)
  await page.goto('/admin/members')
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/)
  // and the API itself refuses (the hidden screens are only a convenience)
  expect((await page.request.get('/api/admin/users')).status()).toBe(403)
})

test('system: storage use with what uses it; Team AX Cloud shows the plan and leaves out what TreeSoop manages', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/system')
  const storage = page.getByTestId('storage')
  await expect(storage).toContainText('82%')
  await expect(storage).toContainText('80% 넘음')
  await expect(page.getByTestId('storage-bar')).toHaveAttribute('style', /width: 82%/)
  await expect(page.getByTestId('storage-breakdown')).toContainText('휴지통')
  await expect(storage).toContainText('휴지통 비우기')
  await expect(page.getByTestId('plan-card')).toHaveCount(0)
  await expect(page.getByTestId('managed-notices')).toHaveCount(0)
  // a self-hosted server: connection change and connected folders are there
  await expect(page.getByRole('button', { name: '연결 방식 바꾸기' })).toBeVisible()

  expect((await page.request.post('/__test/cloud', { data: { on: true } })).ok()).toBeTruthy()
  await page.reload()
  const plan = page.getByTestId('plan-card')
  await expect(plan).toContainText('팀')
  await expect(plan).toContainText('12명 중')
  await expect(plan).toContainText('동시 답변 최대 3')
  await expect(plan.getByRole('link', { name: '요금제 관리' })).toHaveAttribute('href', 'https://app.teamax.example/billing')
  await expect(plan.getByRole('link', { name: '지원' })).toHaveAttribute('href', 'mailto:support@teamax.example')
  // the operator's notices: the owner's critical one cannot be closed, the info one can (and stays closed)
  const notices = page.getByTestId('managed-notices')
  await expect(notices.locator('[data-notice="grant-1"]')).toBeVisible()
  await expect(notices.locator('[data-notice="grant-1"]').getByRole('button')).toHaveCount(0)
  await notices.locator('[data-notice="maint-1"]').getByRole('button', { name: '닫기' }).click()
  await expect(notices.locator('[data-notice="maint-1"]')).toHaveCount(0)
  await page.reload()
  await expect(notices.locator('[data-notice="grant-1"]')).toBeVisible()
  await expect(notices.locator('[data-notice="maint-1"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '연결 방식 바꾸기' })).toHaveCount(0)
  await expect(page.getByTestId('update-managed')).toBeVisible()
  await expect(page.getByTestId('connected-list')).toHaveCount(0)
  // the plan's maximum for answers at the same time (AI engines > Team provider settings)
  await page.goto('/admin/providers?tab=team')
  await expect(page.getByTestId('engines-concurrency')).toHaveAttribute('max', '3')
  expect(realErrors(errors)).toEqual([])
})

test('settings: the team time zone', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings')
  const tz = page.getByTestId('team-time-zone')
  await expect(tz).toHaveValue('Asia/Seoul')
  await tz.selectOption('Asia/Jakarta')
  await page.getByRole('button', { name: '저장', exact: true }).click()
  await expect(page.getByText('저장했어요.')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('team-time-zone')).toHaveValue('Asia/Jakarta')
})

// "Send images, PDF pages and video frames to the AI" (server/src/files/vision.ts): on by default; the admin's switch saves only it
// an office Mac: the mock server is not one, so what makes it one is answered here
const officeStatus = (o: Record<string, unknown> = {}) => ({
  current: '0.2.20', channel: 'stable', paused: false, time: '22:30', window: '22:30-00:30', windowSource: 'legacy', timeZone: 'Asia/Jakarta', nextWindowAt: '2026-11-02T15:30:00.000Z',
  lastCheckAt: '2026-11-02T09:00:00.000Z', last: null, available: null, lastUpdate: null, running: null, requested: false, agentInstalled: true, desktop: null, ...o,
})
async function onOfficeMac(page: Page, status: () => object) {
  await page.route('**/api/me', async (route) => {
    const res = await route.fetch()
    const me = await res.json()
    await route.fulfill({ response: res, json: { ...me, server: { ...me.server, features: { ...me.server.features, officeUpdate: true } } } })
  })
  await page.route('**/api/admin/office-update', (route) => route.fulfill({ json: status() }))
}
const legacyHint = (page: Page) => page.getByText(translate('ko', 'teamSettings.updateWindowLegacy', { window: '22:30-00:30', zone: 'Asia/Jakarta' }), { exact: true })
const plainHint = (page: Page) => page.getByText(DICTS.ko['teamSettings.row.updateWindowDesc'], { exact: true })

test('settings: an office Mac says which update window runs while the field is empty, and never writes it in', async ({ page }) => {
  await reset(page)
  await signIn(page)
  let status = officeStatus()
  await onOfficeMac(page, () => status)
  await page.goto('/admin/settings')
  const t = DICTS.ko
  const field = page.getByLabel(t['teamSettings.updateWindow'], { exact: true })
  const patches: unknown[] = []
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/admin/settings') patches.push(r.postDataJSON())
  })
  const save = async () => {
    const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/admin/settings')
    await page.getByRole('button', { name: t['common.save'], exact: true }).click()
    expect((await saved).ok()).toBe(true)
  }
  await expect(legacyHint(page)).toBeVisible()
  await expect(field).toHaveAttribute('placeholder', '22:30-00:30')
  await expect(field).toHaveValue('')
  await expect(plainHint(page)).toHaveCount(0)
  // typed, not saved yet: that time still runs
  await field.fill('02:00-05:00')
  await expect(legacyHint(page)).toBeVisible()
  // saved: the team's own window, and nothing left to tell
  status = officeStatus({ window: '02:00-05:00', time: '02:00', windowSource: 'team' })
  await save()
  await expect(plainHint(page)).toBeVisible()
  await expect(legacyHint(page)).toHaveCount(0)
  await expect(field).toHaveAttribute('placeholder', '02:00-05:00')
  await expect(field).toHaveValue('02:00-05:00')
  // the page opened on a saved window, emptied: the old time counts again, which only the server can say
  await page.reload()
  await expect(plainHint(page)).toBeVisible()
  status = officeStatus()
  await field.fill('')
  await save()
  await expect(legacyHint(page)).toBeVisible()
  await expect(field).toHaveAttribute('placeholder', '22:30-00:30')
  await expect(field).toHaveValue('')
  // only what was typed was ever saved
  expect(patches).toEqual([{ updateWindow: '02:00-05:00' }, { updateWindow: null }])
  // the team moves to another zone: the hint names the new one
  status = officeStatus({ timeZone: 'Asia/Tokyo' })
  await page.getByTestId('team-time-zone').selectOption('Asia/Tokyo')
  await save()
  await expect(page.getByText(translate('ko', 'teamSettings.updateWindowLegacy', { window: '22:30-00:30', zone: 'Asia/Tokyo' }), { exact: true })).toBeVisible()
})

test('settings: any other server keeps the update window field as it was', async ({ page }) => {
  await reset(page)
  await signIn(page)
  // not an office Mac: this status, were it read, would change the field
  await page.route('**/api/admin/office-update', (route) => route.fulfill({ json: officeStatus() }))
  await page.goto('/admin/settings')
  await expect(plainHint(page)).toBeVisible()
  await expect(legacyHint(page)).toHaveCount(0)
  await expect(page.getByLabel(DICTS.ko['teamSettings.updateWindow'], { exact: true })).toHaveAttribute('placeholder', '02:00-05:00')
})

test('system: a time zone this browser does not know leaves the update card standing', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await onOfficeMac(page, () => officeStatus({ timeZone: 'Mars/Base', window: '03:00-05:00', windowSource: 'team', lastUpdate: { from: '0.2.19', to: '0.2.20', at: '2026-11-02T09:00:00.000Z', result: 'updated', error: null } }))
  await page.goto('/admin/system')
  const card = page.getByTestId('office-update')
  await expect(card).toContainText('03:00-05:00(Mars/Base)')
  await expect(card).toContainText(/마지막 확인 .+\(.+\/.+\)|마지막 확인 .+\(UTC\)/)
  await expect(card).toContainText(/0\.2\.19 → 0\.2\.20 · .+\(/)
  expect(errors.join('\n')).not.toContain('RangeError')
})

test('settings: the team turns sending images and PDF pages to the AI off', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/settings')
  const sw = page.getByTestId('team-ai-vision')
  await expect(sw).toHaveAttribute('data-on', 'true')
  await expect(sw).toContainText('이미지·PDF 페이지·영상 장면을 AI에게 보내기')
  const saved = page.waitForRequest((r) => r.url().endsWith('/api/admin/settings') && r.method() === 'PATCH')
  await sw.getByRole('checkbox').uncheck({ force: true })
  await page.getByRole('button', { name: '저장', exact: true }).click()
  expect((await saved).postDataJSON()).toEqual({ aiVision: false })
  await expect(page.getByText('저장했어요.')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('team-ai-vision')).toHaveAttribute('data-on', 'false')
  expect(realErrors(errors)).toEqual([])
})

// "Turn video sound into text" (TeamSettings.aiMediaTranscripts, docs/DECISIONS.md "AI reads video and audio"): in the
// voice input section; its default follows the speech provider (on for this server unless it is small, off for
// OpenRouter), a provider picked in the form starts from its own default and the saved one gets the saved choice back
test('settings: "Turn video sound into text" follows the speech provider until the admin chooses', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/settings')
  const sw = page.getByTestId('team-media-transcripts')
  // the mock team transcribes on this server: on by default, and the sound stays here
  await expect(sw).toHaveAttribute('data-on', 'true')
  await expect(sw).toContainText('영상 소리를 글로 바꾸기')
  await expect(sw).toContainText('서버 밖으로 나가지 않아요')
  const saved = page.waitForRequest((r) => r.url().endsWith('/api/admin/settings') && r.method() === 'PATCH')
  await sw.getByText('영상 소리를 글로 바꾸기').click()
  await expect(sw).toHaveAttribute('data-on', 'false')
  await page.getByRole('button', { name: '저장', exact: true }).click()
  expect((await saved).postDataJSON()).toEqual({ aiMediaTranscripts: false })
  await expect(page.getByText('저장했어요.')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('team-media-transcripts')).toHaveAttribute('data-on', 'false')
  // OpenRouter: back to its own default (off), with the warning that the sound leaves the server
  await page.getByTestId('team-speech-provider').selectOption('openrouter')
  await expect(sw).toHaveAttribute('data-on', 'false')
  await expect(sw).toContainText('OpenRouter와 그 제공사로')
  // back to this server before saving: the admin's saved "off" stays off (QA L4: it went back to the default, on)
  await page.getByTestId('team-speech-provider').selectOption('local')
  await expect(sw).toHaveAttribute('data-on', 'false')
  await expect(sw).toContainText('30초씩 나눠 바꾸는데')
  await expect(sw).not.toContainText('2분씩')
  // voice input off: no switch
  await page.getByTestId('team-speech-provider').selectOption('off')
  await expect(sw).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

// a server with 2 cores or fewer transcribes slowly (QA 2026-11-01): the switch starts off there and says why
test('settings: on a small server "Turn video sound into text" starts off, with why and the measured speed', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  expect((await page.request.post('/__test/speech-host', { data: { cpuCores: 2, localSecPerSec: 1.2 } })).ok()).toBeTruthy()
  await signIn(page)
  await page.goto('/admin/settings')
  const sw = page.getByTestId('team-media-transcripts')
  await expect(sw).toHaveAttribute('data-on', 'false')
  await expect(page.getByTestId('team-media-transcripts-small')).toContainText('이 서버에서는 소리를 글로 바꾸는 데 오래 걸려서 꺼 두었어요(CPU 코어 2개)')
  await expect(page.getByTestId('team-media-transcripts-speed')).toContainText('소리 1분을 바꾸는 데 약 72초 걸려요')
  // the admin turns it on: saved as their choice, and the note about the default goes
  const saved = page.waitForRequest((r) => r.url().endsWith('/api/admin/settings') && r.method() === 'PATCH')
  await sw.getByText('영상 소리를 글로 바꾸기').click()
  await expect(sw).toHaveAttribute('data-on', 'true')
  await expect(page.getByTestId('team-media-transcripts-small')).toHaveCount(0)
  await page.getByRole('button', { name: '저장', exact: true }).click()
  expect((await saved).postDataJSON()).toEqual({ aiMediaTranscripts: true })
  expect(realErrors(errors)).toEqual([])
})

// QA R2-PERM-10: the owner gives the role to another person in Team settings, with the password again; the old owner
// is an admin at once, so the transfer card and the team name input go away
test('settings: the owner transfers ownership with the password again and becomes an admin', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/settings')
  await expect(page.getByRole('heading', { name: '팀장 넘김' })).toBeVisible()
  const start = page.getByTestId('transfer-start')
  await expect(start).toBeDisabled()
  await page.getByTestId('transfer-target').selectOption('bob')
  await start.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Bob님을 팀장으로 정할까요?')
  await dialog.getByLabel(translate('ko', 'system.passwordAgain')).fill('wrong password')
  await dialog.getByRole('button', { name: '넘기기', exact: true }).click()
  await expect(page.getByText('비밀번호가 맞지 않아요. 다시 입력해 주세요.')).toBeVisible()
  await expect(dialog).toBeVisible()
  await dialog.getByLabel(translate('ko', 'system.passwordAgain')).fill(OWNER.password)
  await dialog.getByRole('button', { name: '넘기기', exact: true }).click()
  await expect(page.getByText('이제 Bob님이 팀장이에요.')).toBeVisible()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: '팀장 넘김' })).toBeHidden()
  await expect(page.getByLabel('팀 이름')).toBeDisabled()
  expect(realErrors(errors).filter((e) => !/status of 403/.test(e))).toEqual([])
})

for (const locale of ['ko', 'en', 'id'] as const) {
  for (const role of ['owner', 'admin'] as const) {
    for (const rejectFirst of [false, true]) {
      test(`invites: ${role} revocation ${rejectFirst ? 'retains a rejected row then retries' : 'refreshes after 204'} (${locale})`, async ({ page, browser }) => {
        await reset(page, { teamLocale: locale, usersFollowTeam: true })
        await signIn(page)
        if (role === 'admin') {
          // Promote the seeded member in this isolated mock fixture, then use their own session.
          const promoted = await page.request.patch('/api/admin/users/bob', {
            headers: { [CSRF_HEADER]: '1' }, data: { role: 'admin' },
          })
          expect(promoted.ok()).toBe(true)
          await page.context().clearCookies()
          await signIn(page, { username: 'bob', password: 'bob password 1' })
        }
        await page.goto('/admin/members')
        const t = DICTS[locale]
        await page.getByTestId('invite-new').click()
        const roleSelect = page.getByRole('dialog').getByRole('combobox').first()
        if (role === 'owner') await roleSelect.selectOption('admin')
        else await expect(roleSelect).toBeDisabled()
        const created = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/admin/invites')
        await page.getByTestId('invite-create').click()
        const { invite } = await (await created).json()
        const link = await page.getByTestId('secret-value').innerText()
        await page.getByRole('dialog').getByRole('button', { name: t['common.done'], exact: true }).click()
        const row = page.getByTestId('invite-list').getByRole('listitem')
        await expect(row).toHaveCount(1)
        await expect(row).toContainText(t[role === 'owner' ? 'role.admin' : 'role.member'])
        const revoke = row.getByRole('button', { name: t['members.revoke'], exact: true })
        const path = `/api/admin/invites/${invite.id}`
        let deletes = 0, listReads = 0, documents = 0
        page.on('request', request => {
          const pathname = new URL(request.url()).pathname
          if (request.method() === 'DELETE' && pathname === path) deletes++
          if (request.method() === 'GET' && pathname === '/api/admin/invites') listReads++
          if (request.resourceType() === 'document') documents++
        })
        if (rejectFirst) {
          await page.route(`**${path}`, route => route.fulfill({ status: 403,
            json: { error: { code: 'forbidden', message: ERROR_MESSAGES.forbidden.en } } }))
          await revoke.click()
          await expect(page.getByRole('alert').filter({ hasText: ERROR_MESSAGES.forbidden[locale] })).toBeVisible()
          await expect(row).toBeVisible()
          await expect(revoke).toBeEnabled()
          expect(deletes).toBe(1)
          expect(listReads).toBe(0)
          await page.unroute(`**${path}`)
        }
        const deleted = page.waitForResponse(r => r.request().method() === 'DELETE' && new URL(r.url()).pathname === path)
        await revoke.click()
        expect((await deleted).status()).toBe(204)
        await expect(row).toHaveCount(0)
        await expect(page.getByText(t['members.noInvites'], { exact: true })).toBeVisible()
        // No stale cancel button remains to send another DELETE; the document was never reloaded.
        await expect(revoke).toHaveCount(0)
        expect(deletes).toBe(rejectFirst ? 2 : 1)
        expect(listReads).toBe(1)
        expect(documents).toBe(0)

        const anonymous = await browser.newContext()
        try {
          const visitor = await anonymous.newPage()
          await visitor.goto(link)
          await expect(visitor.getByText(t['invite.invalid'], { exact: true })).toBeVisible()
          await expect(visitor.getByTestId('invite-submit')).toHaveCount(0)
        } finally {
          await anonymous.close()
        }
      })
    }
  }

  test(`members: deletion explains private archive transfer, including after cancel (${locale})`, async ({ page }) => {
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    // the chat retention the dialog names is the saved team setting, not a fixed 7 days
    const saved = await page.request.patch('/api/admin/settings', { headers: { [CSRF_HEADER]: '1' }, data: { chatTrashRetentionDays: 3 } })
    expect(saved.ok()).toBeTruthy()
    await page.goto('/admin/members')
    const t = DICTS[locale]
    const member = page.getByTestId('members-table').getByRole('row').filter({ hasText: 'Bob' })
    await member.getByTestId('member-more').click()
    await page.getByTestId('disable-member-bob').click()
    await page.getByTestId('dialog-confirm').click()
    await expect(member).toContainText(t['members.disabled'])
    for (const cancel of [true, false]) {
      await member.getByTestId('member-more').click()
      await page.getByTestId('delete-member-bob').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toContainText(translate(locale, 'members.removeBody', { days: 3 }))
      await expect(dialog).not.toContainText('{days')
      await expect(dialog).not.toContainText('users/')
      await expect(dialog).not.toContainText('{id}')
      if (cancel) {
        await dialog.getByRole('button', { name: t['common.cancel'], exact: true }).click()
        await expect(member).toBeVisible()
      } else {
        const deleted = page.waitForResponse((r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname === '/api/admin/users/bob')
        await dialog.getByTestId('dialog-confirm').click()
        const response = await deleted
        expect(response.status()).toBe(204)
        // The UI still uses the default transfer contract, without selecting destructive folder deletion.
        expect(new URL(response.url()).searchParams.get('personalFolder')).toBeNull()
        // A successful no-content response refreshes the list without a document reload.
        await expect(member).toHaveCount(0)
      }
    }
  })

  test(`chat trash names the saved chat retention, not a fixed 7 days (${locale})`, async ({ page }) => {
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    const saved = await page.request.patch('/api/admin/settings', { headers: { [CSRF_HEADER]: '1' }, data: { chatTrashRetentionDays: 14 } })
    expect(saved.ok()).toBeTruthy()
    await page.goto('/trash')
    await expect(page.getByText(translate(locale, 'trash.desc', { days: 14 }))).toBeVisible()
    await expect(page.getByText(translate(locale, 'trash.desc', { days: 7 }))).toHaveCount(0)
  })

  test(`chat retention saved in Team settings shows at once in the member and chat delete dialogs (${locale})`, async ({ page }) => {
    const t = DICTS[locale]
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    const created = await page.request.post('/api/chats', { headers: { [CSRF_HEADER]: '1' }, data: { title: 'Retention chat' } })
    expect(created.ok()).toBeTruthy()
    await page.goto('/admin/settings')
    await page.getByLabel(t['teamSettings.row.chatTrash'], { exact: true }).fill('5')
    await page.getByRole('button', { name: t['common.save'], exact: true }).click()
    await expect(page.getByText(t['common.saved'], { exact: true })).toBeVisible()
    // no page.goto from here: the dialogs must use the new value without a reload
    let loads = 0
    page.on('load', () => loads++)
    await page.getByRole('link', { name: t['admin.members'], exact: true }).click()
    const member = page.getByTestId('members-table').getByRole('row').filter({ hasText: 'Bob' })
    await member.getByTestId('member-more').click()
    await page.getByTestId('disable-member-bob').click()
    await page.getByTestId('dialog-confirm').click()
    await expect(member).toContainText(t['members.disabled'])
    await member.getByTestId('member-more').click()
    await page.getByTestId('delete-member-bob').click()
    await expect(page.getByRole('dialog')).toContainText(translate(locale, 'members.removeBody', { days: 5 }))
    await page.getByRole('dialog').getByRole('button', { name: t['common.cancel'], exact: true }).click()
    const item = page.getByRole('listitem').filter({ hasText: 'Retention chat' })
    await item.hover()
    await item.getByRole('button', { name: t['chat.menu'], exact: true }).click()
    await item.getByRole('menuitem', { name: t['common.delete'] }).click()
    await expect(page.getByRole('dialog')).toContainText(translate(locale, 'chat.deleteBody', { days: 5 }))
    await expect(page.getByRole('dialog')).not.toContainText(translate(locale, 'chat.deleteBody', { days: 7 }))
    await page.getByRole('dialog').getByRole('button', { name: t['common.cancel'], exact: true }).click()
    expect(loads).toBe(0)
  })

  test(`settings: update window validates while typing and after blur, then recovers (${locale})`, async ({ page }) => {
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    await page.goto('/admin/settings')
    const t = DICTS[locale]
    const window = page.getByLabel(t['teamSettings.updateWindow'], { exact: true })
    const save = page.getByRole('button', { name: t['common.save'], exact: true })
    const error = page.getByRole('alert').filter({ hasText: t['teamSettings.updateWindowBad'] })
    const patches: unknown[] = []
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/admin/settings') patches.push(r.postDataJSON())
    })
    await expect(window).toHaveValue('')
    await expect(page.getByText(t['teamSettings.row.updateWindowDesc'], { exact: true })).toBeVisible()
    for (const invalid of ['25:00-26:00', '25:00-01:00', '00:00-25:00', '23:60-01:00', '00:00-23:60']) {
      await window.fill(invalid)
      await expect(error).toBeVisible()
      await expect(window).toHaveAttribute('aria-invalid', 'true')
      await expect(save).toBeDisabled()
      await window.press('Enter')
      await window.blur()
      await expect(error).toBeVisible()
      await expect(save).toBeDisabled()
    }
    expect(patches).toEqual([])
    for (const valid of ['00:00-23:59', '23:59-00:00', '23:00-01:00', '00:00-00:00', '']) {
      await window.fill(valid)
      await expect(error).toHaveCount(0)
      await expect(window).not.toHaveAttribute('aria-invalid', 'true')
      await expect(save).toBeEnabled()
      const response = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/admin/settings')
      await save.click()
      expect((await response).ok()).toBe(true)
      expect(patches.at(-1)).toEqual({ updateWindow: valid || null })
      await page.reload()
      await expect(window).toHaveValue(valid)
    }
  })
}


test('members: cancelled and rejected deletions retain the row; a successful retry refreshes it', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/members')
  const member = page.getByTestId('members-table').getByRole('row').filter({ hasText: 'Bob' })
  await member.getByTestId('member-more').click()
  await page.getByTestId('disable-member-bob').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(member).toContainText(DICTS.en['members.disabled'])
  let deletes = 0, listReads = 0
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'DELETE' && path === '/api/admin/users/bob') deletes++
    if (request.method() === 'GET' && path === '/api/admin/users') listReads++
  })
  await member.getByTestId('member-more').click()
  await page.getByTestId('delete-member-bob').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(member).toBeVisible()
  expect(deletes).toBe(0)
  expect(listReads).toBe(0)

  await page.route('**/api/admin/users/bob', route => route.fulfill({ status: 403,
    json: { error: { code: 'forbidden', message: 'Deletion refused' } } }))
  await member.getByTestId('member-more').click()
  await page.getByTestId('delete-member-bob').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByRole('alert').filter({ hasText: 'Deletion refused' })).toBeVisible()
  await expect(member).toBeVisible()
  expect(deletes).toBe(1)
  expect(listReads).toBe(0)

  await page.unroute('**/api/admin/users/bob')
  await member.getByTestId('member-more').click()
  await page.getByTestId('delete-member-bob').click()
  const deleted = page.waitForResponse(r => r.request().method() === 'DELETE' && new URL(r.url()).pathname === '/api/admin/users/bob')
  await page.getByTestId('dialog-confirm').click()
  expect((await deleted).status()).toBe(204)
  await expect(member).toHaveCount(0)
  expect(deletes).toBe(2)
  expect(listReads).toBe(1)
})

// "Let the AI split work into sub-tasks" (server/src/chat/subagents.ts): on by default; the switch saves only it
test('settings: the team turns sub-agents off', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/settings')
  const sw = page.getByTestId('team-ai-subagents')
  await expect(sw).toHaveAttribute('data-on', 'true')
  await expect(sw).toContainText('AI가 일을 나눠 맡기기')
  const saved = page.waitForRequest((r) => r.url().endsWith('/api/admin/settings') && r.method() === 'PATCH')
  await sw.getByText('AI가 일을 나눠 맡기기').click()
  await expect(sw).toHaveAttribute('data-on', 'false')
  await page.getByRole('button', { name: '저장', exact: true }).click()
  expect((await saved).postDataJSON()).toEqual({ aiSubagents: false })
  await expect(page.getByText('저장했어요.')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('team-ai-subagents')).toHaveAttribute('data-on', 'false')
  expect(realErrors(errors)).toEqual([])
})

// "한 답변의 도구 사용 한도" (Claude Code --max-turns, docs/DECISIONS.md "Tool rounds per answer"): 150 by default;
// typed freely, kept within 10-500 when the field is left; only the changed field is saved
test('settings: tool rounds per answer', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/settings')
  const field = page.getByTestId('team-answer-step-limit')
  const input = field.getByRole('spinbutton')
  await expect(input).toHaveValue('150')
  await expect(field).toContainText('한 답변의 도구 사용 한도')
  await expect(field).toContainText('10~500, 기본 150')
  // typing digit by digit is not clamped on the way ("2" then "20" then "200")
  await input.fill('')
  await input.pressSequentially('200')
  await expect(input).toHaveValue('200')
  // out of range: back into range when the field is left
  await input.fill('5000')
  await input.blur()
  await expect(input).toHaveValue('500')
  await input.fill('3')
  await input.blur()
  await expect(input).toHaveValue('10')
  await input.fill('120')
  const saved = page.waitForRequest((r) => r.url().endsWith('/api/admin/settings') && r.method() === 'PATCH')
  await page.getByRole('button', { name: '저장', exact: true }).click()
  expect((await saved).postDataJSON()).toEqual({ answerStepLimit: 120 })
  await expect(page.getByText('저장했어요.')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('team-answer-step-limit').getByRole('spinbutton')).toHaveValue('120')
  expect(realErrors(errors)).toEqual([])
})

// these menus scroll sideways on a phone, so their container clips anything drawn outside a link: the ring stays inside
test('the focus ring of the admin and settings menus is not cut off by the scrolling menu', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const inside = async (name: string) => {
    const link = page.getByRole('link', { name, exact: true })
    await link.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(link).toBeFocused()
    await expect(link).toHaveCSS('outline-style', 'solid')
    await expect(link).toHaveCSS('outline-offset', '-2px')
  }
  for (const size of [{ width: 1360, height: 860 }, { width: 390, height: 780 }]) {
    await page.setViewportSize(size)
    await page.goto('/admin/folders')
    await inside('폴더 권한')
    await page.screenshot({ path: process.env.RING_SHOTS ? `${process.env.RING_SHOTS}/admin-${size.width}.png` : undefined })
    // Settings is a dialog: its list is beside the section on a wide screen, on its own on a phone (/settings)
    await page.goto(size.width < 768 ? '/settings' : '/settings/profile')
    await inside('프로필')
  }
})
