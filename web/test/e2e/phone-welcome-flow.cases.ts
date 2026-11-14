// Getting started on a phone (QA TC-271): a full-screen flow with one Back step per step and a share sheet for the
// invite. The row's steps, each checked as its Expected says:
//   1. walk the steps: full screen (no tab bar), the bar shows the step and 나중에;
//   2. ‹ and the swipe (the history's own Back, what the iPhone app's edge swipe and Android's Back do) go to the step
//      before; from the first step out to Home;
//   3. the invite: the phone's share sheet opens (the app's own with share-text-v1, else navigator.share), copy as the
//      fallback;
//   4. the count covers only the steps a phone shows (no 도구 연결: n/4), and the computer-only parts are hidden.
// Each case runs in Chromium (Android's engine: phone-welcome-flow.spec.ts) and WebKit (the iPhone app's:
// phone-welcome-flow.webkit.spec.ts), at 390×844 with touch, from a new owner right after /setup.
import { expect, test, type Page } from '@playwright/test'
import { reset } from './helpers'
import { tabBar } from './nav'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'

/** Back as the phone does it (the iOS edge swipe, Android's Back): the history's own back */
const back = (page: Page) => page.goBack({ waitUntil: 'commit' })
const title = (page: Page) => page.getByTestId('welcome-bar-title')
const stepIs = (page: Page, step: string) => expect(page).toHaveURL(new RegExp(`/welcome\\?step=${step}$`))

/** A new owner right after /setup, on the first step. */
async function newOwner(page: Page) {
  await reset(page, { setup: true })
  await page.goto('/')
  await page.getByLabel('설정 코드').fill('setup-token-0123456789')
  await page.getByTestId('setup-team').fill('Acme')
  await page.getByTestId('setup-name').fill('Kim Owner')
  await page.getByTestId('setup-username').fill('kim')
  await page.getByTestId('setup-password').fill('a long password 1')
  await page.getByTestId('setup-submit').click()
  await stepIs(page, 'profile')
  await expect(title(page)).toHaveText('1/4 회사 소개')
}

/** 회사 소개, 스킬 and 팀 파일 put off: on to the invite. */
async function toInvite(page: Page) {
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await stepIs(page, 'skills')
  await page.getByTestId('skills-later').click()
  await stepIs(page, 'files')
  await page.getByTestId('welcome-later').click()
  await stepIs(page, 'invite')
  await expect(page.getByTestId('team-link-message')).toHaveValue(/\/join#/)
}

const tall = async (page: Page, testId: string) => expect((await page.getByTestId(testId).first().boundingBox())!.height).toBeGreaterThanOrEqual(44)

/** The cases, for the engine the spec that calls this runs them in. */
export function welcomeFlowCases() {
  test('steps 1, 2, 4: full screen with its own bar (the step, 나중에); Back and ‹ go to the step before, out from the first; the phone\'s four steps, nothing for a computer', async ({ page }) => {
    await newOwner(page)
    // 1. full screen: no tab bar, no tab top bar; the steps' own bar with ‹, the step and 나중에, each 44 px
    await expect(page.getByTestId('welcome')).toBeVisible()
    await expect(tabBar(page)).toHaveCount(0)
    await expect(page.getByTestId('phone-topbar')).toHaveCount(0)
    await expect(page.getByTestId('topbar-back')).toHaveCount(0)
    await expect(page.getByTestId('welcome-bar-later')).toHaveText('나중에')
    await tall(page, 'welcome-bar-back')
    await tall(page, 'welcome-bar-later')
    // no second, small "← 이전": the bar's ‹ is the way back
    await expect(page.getByTestId('welcome-back')).toHaveCount(0)
    // 4. the phone's own four steps (도구 연결 is a computer's)
    await expect(page.getByTestId('welcome-progress').locator('li')).toHaveCount(4)
    expect(await page.getByTestId('welcome-progress').locator('li').evaluateAll((els) => els.map((e) => e.getAttribute('data-progress-step')))).toEqual(['profile', 'skills', 'files', 'invite'])

    // walk: each step its own entry, the bar names it
    await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
    await stepIs(page, 'skills')
    await expect(title(page)).toHaveText('2/4 스킬')
    // nothing for a computer on the skills step: no folder, no Claude Code or Codex line
    const skills = page.getByTestId('skills-step')
    await expect(skills.getByTestId('skill-pack-row').first()).toBeVisible()
    for (const text of ['Codex', 'Claude Code', '.claude']) await expect(skills).not.toContainText(text)
    // a checkbox takes a tap 18 px beside its 18 px box (a 44 px box around it)
    const check = skills.getByTestId('skill-pack-check').first()
    const box = (await skills.getByTestId('skill-pack-check-box').first().boundingBox())!
    const was = await check.isChecked()
    await page.touchscreen.tap(box.x + box.width / 2 - 18, box.y + box.height / 2)
    await expect(check).toBeChecked({ checked: !was })
    await page.touchscreen.tap(box.x + box.width / 2 - 18, box.y + box.height / 2)
    await expect(check).toBeChecked({ checked: was })
    await page.getByTestId('skills-later').click()
    await stepIs(page, 'files')
    await expect(title(page)).toHaveText('3/4 팀 파일')
    // 팀 파일 on a phone: files from the phone, no folder to pick
    await expect(page.getByTestId('welcome-team-files-pick-files')).toBeVisible()
    await expect(page.getByTestId('welcome-team-files-pick')).toHaveCount(0)
    await page.getByTestId('welcome-later').click()
    // past 도구 연결 to the invite: 4/4, never 3/5 → 5/5
    await stepIs(page, 'invite')
    await expect(title(page)).toHaveText('4/4 팀원 초대')
    await expect(page.getByTestId('welcome-tools')).toHaveCount(0)

    // 2. the swipe (Back) and ‹: the step before each time, named on ‹
    await back(page)
    await stepIs(page, 'files')
    await expect(title(page)).toHaveText('3/4 팀 파일')
    await expect(page.getByTestId('welcome-team-files')).toBeVisible()
    await expect(page.getByTestId('welcome-bar-back-label')).toHaveText('스킬')
    await page.getByTestId('welcome-bar-back').click()
    await stepIs(page, 'skills')
    await expect(title(page)).toHaveText('2/4 스킬')
    await expect(page.getByTestId('skills-step')).toBeVisible()
    await back(page)
    await stepIs(page, 'profile')
    await expect(title(page)).toHaveText('1/4 회사 소개')
    await expect(page.getByTestId('welcome-profile')).toBeVisible()
    // from the first step: out to Home, with the tab bar
    await page.getByTestId('welcome-bar-back').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(tabBar(page)).toBeVisible()
    await expect(page.getByTestId('welcome')).toHaveCount(0)
  })

  test('나중에 leaves the steps for Home; Home\'s row resumes with the steps before under the one it opens (n/4 there too)', async ({ page }) => {
    await newOwner(page)
    await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
    await page.getByTestId('skills-later').click()
    await stepIs(page, 'files')
    await page.getByTestId('welcome-bar-later').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(tabBar(page)).toBeVisible()
    // nothing was recorded by 나중에: 팀 파일 is still open, and Home's row counts the phone's four
    const row = page.getByTestId('welcome-resume-link')
    await expect(row).toContainText('/4')
    await row.click()
    await stepIs(page, 'files')
    await expect(title(page)).toHaveText('3/4 팀 파일')
    await expect(page.getByTestId('welcome-bar-back-label')).toHaveText('스킬')
    await back(page)
    await stepIs(page, 'skills')
    await back(page)
    await stepIs(page, 'profile')
    await back(page)
    await expect(page).toHaveURL(/\/$/)
    await expect(tabBar(page)).toBeVisible()
  })

  test('step 3: the invite opens the phone\'s share sheet (navigator.share) with the message; copy stays one press under it', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { shared: unknown[] }
      w.shared = []
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: unknown) => { w.shared.push(d) } })
    })
    await newOwner(page)
    await toInvite(page)
    // one intro for both since the short invite dialog (ebd5788f4); the share or copy button says the rest
    await expect(page.getByTestId('invite-step')).toContainText('초대할 사람에게 이 링크를 보내세요.')
    const share = page.getByTestId('team-link-share')
    await expect(share).toHaveText('메시지 보내기')
    await tall(page, 'team-link-share')
    await share.click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { shared: unknown[] }).shared.length)).toBe(1)
    const sent = await page.evaluate(() => (window as unknown as { shared: { text: string }[] }).shared[0]!)
    expect(sent.text).toBe(await page.getByTestId('team-link-message').inputValue())
    expect(sent.text).toContain('/join#')
    // copying is still there, one quiet press
    await expect(page.getByTestId('team-link-copy-message')).toHaveText('메시지 복사')
    await tall(page, 'team-link-copy-message')
  })

  test('step 3 without a share sheet (a browser without one): copying the message is the one primary', async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }) })
    await newOwner(page)
    await toInvite(page)
    await expect(page.getByTestId('team-link-share')).toHaveCount(0)
    // one intro for both since the short invite dialog (ebd5788f4); the share or copy button says the rest
    await expect(page.getByTestId('invite-step')).toContainText('초대할 사람에게 이 링크를 보내세요.')
    const copy = page.getByTestId('team-link-copy-message')
    await expect(copy).toHaveText('메시지 복사')
    await copy.click()
    await expect(copy).toHaveText('복사됨')
  })

  test('step 3 in the phone app with share-text-v1 (Android: no navigator.share): the app\'s own share sheet through the bridge', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void }; mobileMessages: MobileMessage[] }
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
      w.mycelMobile = { protocol: 1, appVersion: '1.1.0', platform: 'android', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1', 'share-text-v1'] }
      w.mobileMessages = []
      w.ReactNativeWebView = { postMessage(raw) {
        const m = JSON.parse(raw) as MobileMessage
        w.mobileMessages.push(m)
        const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}) }
        if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
        queueMicrotask(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })))
      } }
    })
    await newOwner(page)
    await toInvite(page)
    const share = page.getByTestId('team-link-share')
    await expect(share).toHaveText('메시지 보내기')
    await share.click()
    const sent = () => page.evaluate(() => (window as unknown as { mobileMessages: MobileMessage[] }).mobileMessages.filter((m) => m.type === 'share-text'))
    await expect.poll(async () => (await sent()).length).toBe(1)
    const [m] = (await sent()) as Extract<MobileMessage, { type: 'share-text' }>[]
    expect(m!.text).toBe(await page.getByTestId('team-link-message').inputValue())
    // the app answered: no copy, no note
    await expect(page.getByTestId('toast')).toHaveCount(0)
  })

  test('step 3, a sheet that cannot open: it says so and points at 메시지 복사, which copies (nothing copied by itself)', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }) } })
    })
    await newOwner(page)
    await toInvite(page)
    await page.getByTestId('team-link-share').click()
    await expect(page.getByTestId('team-link-share-failed')).toContainText('메시지 복사를 눌러')
    const copy = page.getByTestId('team-link-copy-message')
    await expect(copy).toHaveText('메시지 복사')
    await copy.click()
    await expect(copy).toHaveText('복사됨')
    await expect(page.getByTestId('team-link-share-failed')).toHaveCount(0)
  })

  test('finished: the end screen\'s address reloaded goes Home (as a computer does), never the end screen again', async ({ page }) => {
    await newOwner(page)
    await toInvite(page)
    await page.getByTestId('invite-step-done').click()
    await stepIs(page, 'done')
    await expect(page.getByTestId('welcome-done')).toContainText('준비 끝났어요')
    expect((await (await page.request.get('/api/onboarding/welcome')).json()).progress.finishedAt).toBeTruthy()
    await page.reload()
    await expect(page).toHaveURL(/\/$/)
    await expect(tabBar(page)).toBeVisible()
    await expect(page.getByTestId('welcome')).toHaveCount(0)
  })

  test('the end screen\'s skill: Back from its form goes to where the steps were opened from (Home), never through the steps', async ({ page }) => {
    await newOwner(page)
    await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
    await stepIs(page, 'skills')
    // one kept skill in, so the end screen offers a first result with it
    await page.getByTestId('skill-packs').locator('[data-testid="skill-pack-row"][data-name="humanizer"]').getByTestId('skill-pack-check').check()
    await page.getByTestId('skills-primary').click()
    await stepIs(page, 'files')
    await page.getByTestId('welcome-later').click()
    await stepIs(page, 'invite')
    await page.getByTestId('invite-step-done').click()
    await stepIs(page, 'done')
    const patches = () => page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/api/onboarding/welcome')).length)
    const make = page.getByTestId('welcome-done-make')
    await expect(make).toHaveAttribute('data-skill', 'skills/work/humanizer/SKILL.md')
    await make.click()
    await expect(page).toHaveURL(/\/skills\?run=/)
    await expect(page.getByTestId('skill-form')).toBeVisible()
    // the steps' entries are gone: Back closes the form (its own layer, TC-245), the next Back is Home; no step showed
    // (or was recorded) on the way
    const before = await patches()
    await back(page)
    await expect(page.getByTestId('skill-form')).toHaveCount(0)
    await expect(page).toHaveURL(/\/skills$/)
    await expect(page.getByTestId('welcome')).toHaveCount(0)
    await back(page)
    await expect(page).toHaveURL(/\/$/)
    await expect(tabBar(page)).toBeVisible()
    await expect(page.getByTestId('welcome')).toHaveCount(0)
    expect(await patches()).toBe(before)
  })

  test('Back while a step is being saved: the step gone back to stays, the next one is not pushed over it', async ({ page }) => {
    await newOwner(page)
    await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
    await page.getByTestId('skills-later').click()
    await stepIs(page, 'files')
    // hold 팀 파일's 나중에 at the server, go back meanwhile, then let it through
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let holding = true
    await page.route('**/api/onboarding/welcome', async (route) => {
      if (holding && route.request().method() === 'PATCH') { holding = false; await held }
      await route.continue()
    })
    await page.getByTestId('welcome-later').click()
    await back(page)
    await stepIs(page, 'skills')
    await expect(title(page)).toHaveText('2/4 스킬')
    const entries = await page.evaluate(() => history.length)
    release()
    await expect.poll(async () => (await (await page.request.get('/api/onboarding/welcome')).json()).progress.steps.files).toBe('skipped')
    await page.waitForTimeout(500)
    await stepIs(page, 'skills')
    await expect(page.getByTestId('skills-step')).toBeVisible()
    expect(await page.evaluate(() => history.length)).toBe(entries)
    await page.unroute('**/api/onboarding/welcome')
  })
}
