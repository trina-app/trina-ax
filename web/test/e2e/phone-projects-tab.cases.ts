// The phone's 프로젝트 tab (QA TC-255, the owner's choice of option D on 2026-11-12: "파일들보다 프로젝트 탭을 볼 일이 더
// 많지 않을까?"), at 390×844 with touch, following the row's steps: count the taps to Projects, a project's chat and a
// file; the tabs are 트리나 · 대화 · 프로젝트 · 나.
// - Projects in 1 tap; a project's chats in 2 (its page lists them; the chat itself is the 3rd); a file through
//   프로젝트 › 팀 폴더 (the fixed last row of the list).
// - A member with no projects sees the tab too: what a project is, 새 프로젝트, and the 팀 폴더 row below.
// - Back (the phone app's nav-v1: the stub below is phone-app-nav.spec.ts's): a folder → the team folder → the tab's root
//   (no swipe there) → Android's Back shows 트리나 → nothing under it.
// - A notification to a file (a /files address: the app loads it) opens it under 프로젝트, with the list under it.
// - A chat opened from a project stays on 프로젝트's stack (Back returns to the project); its ✦ (a new chat) and Delete
//   switch to 트리나 at Home, never Home on top of 프로젝트's stack.
// - 트리나's tab shows Trina's own star, the room header's ✦ (the owner, 2026-11-12: "모바일에서는 트리나 아이콘이 달라서
//   좀 헷갈리는듯"), in the tab bar's colours.
// Each test runs in Chromium (Android's engine: phone-projects-tab.spec.ts) and WebKit (the iPhone app's:
// phone-projects-tab.webkit.spec.ts).
import { expect, test, type Page } from '@playwright/test'
import { PRODUCT } from '@mycel/shared'
import { CSRF_HEADER, PRODUCT_NAMED_AFTER_AI, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { openScript, START_TAB_SCRIPT } from '../../../mobile/src/nav'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const ai = PRODUCT_NAMED_AFTER_AI ? t['rooms.aiName'] : PRODUCT.shortName
const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }

type Nav = { canGoBack: boolean; home?: boolean }
type Win = { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void }; mobileMessages: MobileMessage[]; loads?: number }

/** The app's bridge as the page sees it, with nav-v1 (phone-app-nav.spec.ts). Every load counts itself (`loads`). */
async function app(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Win
    w.mycelMobile = { protocol: 1, appVersion: '1.0.5', platform: 'android', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1', 'nav-v1'] }
    w.mobileMessages = []
    const loads = Number(sessionStorage.getItem('e2e.loads') ?? 0) + 1
    sessionStorage.setItem('e2e.loads', String(loads))
    w.loads = loads
    w.ReactNativeWebView = { postMessage(raw) {
      const m = JSON.parse(raw) as MobileMessage
      w.mobileMessages.push(m)
      const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true }
      if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })))
    } }
  })
}
/** what the app heard last about Back */
const heard = (page: Page) => page.evaluate(() => {
  const navs = (window as unknown as Win).mobileMessages.filter((m) => m.type === 'nav') as unknown as Nav[]
  const last = navs.at(-1)
  return last ? { canGoBack: last.canGoBack, home: last.home } : null
})
const loads = (page: Page) => page.evaluate(() => (window as unknown as Win).loads ?? 0)

/** SHOTS=1: a screenshot of each screen into $SHOTS_DIR (default test-results/phone-projects-tab) */
const shot = (page: Page, name: string) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS_DIR ?? 'test-results/phone-projects-tab'}/${name}.png` }).then(() => {}) : Promise.resolve())

async function call(page: Page, path: string, data: unknown) {
  const r = await page.request.post(path, { headers: H, data })
  expect(r.ok(), `POST ${path}: ${r.status()}`).toBeTruthy()
  return r.json() as Promise<{ id: string }>
}
/** a team project "Launch" on the marketing folder, with one chat in it */
async function launch(page: Page) {
  const project = (await call(page, '/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '' })).id
  const chat = (await call(page, '/api/chats', { projectId: project, title: 'Plan the launch' })).id
  return { project, chat }
}

const tab = (page: Page, id: string) => page.getByTestId(id).last()
const fileRow = (page: Page, name: string) => page.getByTestId('file-row').filter({ hasText: name })

export function projectsTabCases() {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the tabs are 트리나 · 대화 · 프로젝트 · 나; Projects in 1 tap, a project\'s chats in 2, a file by 프로젝트 › 팀 폴더', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const { project, chat } = await launch(page)
    await page.goto('/')
    const tabs = page.getByTestId('bottom-tabs')
    await expect(tabs.getByRole('link')).toHaveText([ai, t['tabs.chats'], t['tabs.projects'], t['tabs.me']])
    await expect(tabs.getByTestId('tab-files')).toHaveCount(0)
    await expect(tab(page, 'tab-ai')).toHaveAttribute('aria-current', 'page')

    // 1 tap: the projects list, the tab's root (its name and +, no ‹); 팀 폴더 its last row
    await tab(page, 'tab-projects').click()
    await expect(page).toHaveURL(/\/projects$/)
    await expect(tab(page, 'tab-projects')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('topbar-title')).toHaveText(t['projects.title'])
    await expect(page.getByTestId('topbar-back')).toHaveCount(0)
    await expect(page.getByTestId('project-new')).toBeVisible()
    const rows = page.getByTestId('project-rows')
    await expect(rows.getByRole('link')).toHaveText([/Launch/, t['files.root']])
    const folderRow = page.getByTestId('projects-team-folder-row')
    expect((await folderRow.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await shot(page, 'projects')

    // 2 taps: the project's page with its chats; the 3rd opens one
    await page.getByTestId('project-row').filter({ hasText: 'Launch' }).getByRole('link').first().click()
    await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))
    const chatRow = page.getByTestId('project-chat').filter({ hasText: 'Plan the launch' })
    await expect(chatRow).toBeVisible()
    await chatRow.click()
    await expect(page).toHaveURL(new RegExp(`/c/${chat}$`))

    // a file: 프로젝트 (the tab on show: back to its list) › 팀 폴더 › marketing › plan.md
    await page.goBack()
    await tab(page, 'tab-projects').click()
    await expect(page).toHaveURL(/\/projects$/)
    await folderRow.click()
    await expect(page).toHaveURL(/\/files$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t['files.root'])
    await expect(page.getByTestId('files-back-label')).toHaveText(t['projects.title'])
    await expect(tab(page, 'tab-projects')).toHaveAttribute('aria-current', 'page')
    await shot(page, 'team-folder')
    await fileRow(page, 'marketing').getByRole('button').first().click()
    await expect(page).toHaveURL(/\/files\?path=marketing$/)
    await fileRow(page, 'plan.md').getByRole('button').first().click()
    await expect(page.getByTestId('file-panel')).toBeVisible()
  })

  test('a member with no projects: the tab says what a project is, offers 새 프로젝트, and the 팀 폴더 row is below', async ({ page }) => {
    await reset(page)
    await signIn(page, BOB)
    await tab(page, 'tab-projects').click()
    await expect(page).toHaveURL(/\/projects$/)
    const empty = page.getByTestId('projects-empty')
    await expect(empty).toBeVisible()
    await expect(empty).toContainText(t['projects.empty'])
    await expect(empty).toContainText(t['projects.desc'])
    const make = empty.getByTestId('projects-empty-new')
    await expect(make).toHaveText(t['projects.new'])
    expect((await make.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    // the team folder below it, still one tap away
    const folderRow = page.getByTestId('projects-team-folder-row')
    await expect(folderRow).toHaveText(t['files.root'])
    expect((await folderRow.boundingBox())!.y).toBeGreaterThan((await make.boundingBox())!.y)
    await shot(page, 'projects-empty')
    // 새 프로젝트 opens the form (a member may make one: a personal project at least)
    await make.click()
    await expect(page.getByRole('dialog').getByTestId('project-name')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await folderRow.click()
    await expect(page).toHaveURL(/\/files$/)
    await expect(page.getByTestId('files-back-label')).toHaveText(t['projects.title'])
  })

  test('Back (nav-v1): a folder → the team folder → 프로젝트\'s root (no swipe) → Android\'s Back shows 트리나 → nothing under it', async ({ page }) => {
    await reset(page)
    await app(page)
    await signIn(page)
    await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: true })
    await tab(page, 'tab-projects').click()
    await expect(page).toHaveURL(/\/projects$/)
    await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: false })
    await page.getByTestId('projects-team-folder-row').click()
    await fileRow(page, 'marketing').getByRole('button').first().click()
    await expect(page).toHaveURL(/\/files\?path=marketing$/)
    await expect.poll(() => heard(page)).toEqual({ canGoBack: true, home: false })
    const before = await loads(page)
    // Back: the team folder, then the projects list, the tab's root: the app's swipe is off there
    await page.goBack()
    await expect(page).toHaveURL(/\/files$/)
    await expect.poll(() => heard(page)).toEqual({ canGoBack: true, home: false })
    await page.goBack()
    await expect(page).toHaveURL(/\/projects$/)
    await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: false })
    // Android's Back at another tab's root: the start tab, 트리나, then out of the app
    await page.evaluate(START_TAB_SCRIPT)
    await expect(page).toHaveURL(/\/$/)
    await expect(tab(page, 'tab-ai')).toHaveAttribute('aria-current', 'page')
    await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: true })
    expect(await loads(page)).toBe(before)
    // 프로젝트 kept its own stack: its list
    await tab(page, 'tab-projects').click()
    await expect(page).toHaveURL(/\/projects$/)
  })

  test('a notification to a file opens it under 프로젝트, the team folder and the list under it', async ({ page }) => {
    await reset(page)
    await app(page)
    await signIn(page)
    const before = await loads(page)
    // a /files address is not an id path: the app's script loads it (a new page), as a notice about a file does
    await page.evaluate(openScript(`/files?path=marketing&select=${encodeURIComponent('marketing/plan.md')}`))
    await page.waitForURL(/\/files\?path=marketing/)
    await expect(fileRow(page, 'plan.md')).toBeVisible()
    expect(await loads(page)).toBe(before + 1)
    await expect(tab(page, 'tab-projects')).toHaveAttribute('aria-current', 'page')
    await expect.poll(() => heard(page)).toEqual({ canGoBack: true, home: false })
    await shot(page, 'notified-file')
    // its parents were put under it: the team folder, then the projects list
    await page.goBack()
    await expect(page).toHaveURL(/\/files$/)
    await page.goBack()
    await expect(page).toHaveURL(/\/projects$/)
    await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: false })
  })

  test('a chat from a project: Back returns to the project; its ✦ (new chat) and Delete switch to 트리나 at Home', async ({ page }) => {
    await reset(page)
    await app(page)
    await signIn(page)
    const { project, chat } = await launch(page)
    await page.goto('/')
    await tab(page, 'tab-projects').click()
    await page.getByTestId('project-row').filter({ hasText: 'Launch' }).getByRole('link').first().click()
    await page.getByTestId('project-chat').first().click()
    await expect(page).toHaveURL(new RegExp(`/c/${chat}$`))
    // Back (and the chat's ‹): the project it was opened from
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))
    await expect(tab(page, 'tab-projects')).toHaveAttribute('aria-current', 'page')
    await page.getByTestId('project-chat').first().click()
    await page.getByTestId('chat-back').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))

    // ✦ in the chat: 트리나 at Home, nothing under it (no Home on top of 프로젝트's stack)
    await page.getByTestId('project-chat').first().click()
    await expect(page).toHaveURL(new RegExp(`/c/${chat}$`))
    const atChat = await page.evaluate(() => history.length)
    await page.getByTestId('chat-new').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await expect(tab(page, 'tab-ai')).toHaveAttribute('aria-current', 'page')
    await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: true })
    expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(atChat)
    // 프로젝트 kept its stack: the chat, then Back to the project
    await tab(page, 'tab-projects').click()
    await expect(page).toHaveURL(new RegExp(`/c/${chat}$`))
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))

    // Delete in the chat: 트리나 at Home, and 프로젝트's stack no longer has the deleted chat
    await page.getByTestId('project-chat').first().click()
    await expect(page).toHaveURL(new RegExp(`/c/${chat}$`))
    await page.getByTestId('chat-menu').click()
    await page.getByTestId('chat-delete').click()
    await page.getByTestId('dialog-confirm').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(tab(page, 'tab-ai')).toHaveAttribute('aria-current', 'page')
    await expect.poll(() => heard(page)).toEqual({ canGoBack: false, home: true })
    await tab(page, 'tab-projects').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))
  })

  test('트리나\'s tab shows Trina\'s own orange star, the same as the room header\'s ✦', async ({ page }) => {
    await reset(page)
    await signIn(page)
    const room = uuidv7()
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
    expect((await page.request.post('/__test/rooms', { data: { rooms: [{
      id: room, kind: 'team', name: '마케팅팀', groupId: uuidv7(), memberCount: 6, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(600), activityAt: ago(5),
      canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false,
    }] } })).ok()).toBeTruthy()
    await tab(page, 'tab-chats').click()
    await expect(page).toHaveURL(/\/rooms$/)
    /** an icon's shape: its viewBox and path (the star) or its lucide class (the sparkle) */
    const shape = (svg: ReturnType<Page['locator']>) => svg.evaluate((el) => ({ viewBox: el.getAttribute('viewBox'), path: el.querySelector('path')?.getAttribute('d') ?? null, star: el.hasAttribute('data-trina-star'), sparkle: el.classList.contains('lucide-sparkles') }))
    const tabIcon = tab(page, 'tab-ai').locator('svg').first()
    const inTab = await shape(tabIcon)
    // the tab's colours: the same as the other tabs' icons, off (faint) here and on (ink) when it is the tab on show
    const colour = (id: string) => tab(page, id).locator('svg').first().evaluate((el) => getComputedStyle(el).color)
    expect(await colour('tab-ai')).toBe(await colour('tab-projects'))
    const off = await colour('tab-ai')
    // the room header's ✦
    await page.getByTestId('rooms-row').filter({ hasText: '마케팅팀' }).click()
    await expect(page).toHaveURL(new RegExp(`/rooms/${room}$`))
    const inRoom = await shape(page.getByTestId('room-side-chat-button').locator('svg').first())
    expect(inTab.star).toBe(PRODUCT_NAMED_AFTER_AI)
    expect(inTab.sparkle).toBe(!PRODUCT_NAMED_AFTER_AI)
    expect(inTab.star).toBe(inRoom.star)
    if (PRODUCT_NAMED_AFTER_AI) {
      expect(inTab.path).toBe(inRoom.path)
      expect(inTab.viewBox).toBe(inRoom.viewBox)
    }
    // drawn as big as the 22 px icons beside it reads (the star is thin: 26 px over a 22 px slot)
    await page.goBack()
    await tab(page, 'tab-ai').click()
    await expect(tab(page, 'tab-ai')).toHaveAttribute('aria-current', 'page')
    expect(await colour('tab-ai')).toBe(await tab(page, 'tab-ai').evaluate((el) => getComputedStyle(el).color))
    expect(await colour('tab-ai')).not.toBe(off)
    const box = (await tabIcon.boundingBox())!
    const other = (await tab(page, 'tab-chats').locator('svg').first().boundingBox())!
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(Math.round(other.height))
    // the bar keeps its height: the icon rows of the four tabs line up
    expect(Math.abs(box.y + box.height / 2 - (other.y + other.height / 2))).toBeLessThanOrEqual(1)
    await shot(page, 'tab-star')
  })
}
