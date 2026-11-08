// Online status in the browser (docs/DECISIONS.md "접속 상태"; components/Presence.tsx): a second member's dot turns
// online, then away, then offline in the sidebar and the DM header as the server's `presence` frames say (the mock's
// POST /__test/presence stands for the server, whose rules tests/unit/b-presence.test.ts checks); the member list; the
// phone's 대화 list and DM header (a dot before the name); the page says it is in use after its hello; "자리 비움으로
// 표시" in the account menu. With SHOTS_DIR set, the last tests save the screens for review (1440 and 390, light and
// dark) and the measured sizes (presence-sizes.json).
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { routeRooms, type MockRoomSpec } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const rid = (n: number) => `019a5f00-0000-7000-8000-0000000d${String(n).padStart(4, '0')}`
const BOB = { id: 'bob', name: 'Bob' }
const SORA = { id: 'sora', name: '김소라' }
const MINSU = { id: 'minsu', name: '이민수' }
const DM = rid(1), SORA_DM = rid(2), MINSU_DM = rid(3), GROUP = rid(4), TEAM = rid(5)
const ROOMS: MockRoomSpec[] = [
  { id: DM, kind: 'dm', name: null, peers: [BOB], unread: 1, ago: 2, last: '내일 회의 10시 맞죠?' },
  { id: SORA_DM, kind: 'dm', name: null, peers: [SORA], ago: 5, last: '자료 보냈어요' },
  { id: MINSU_DM, kind: 'dm', name: null, peers: [MINSU], ago: 9, last: '확인했습니다' },
  { id: GROUP, kind: 'group', name: '디자인 리뷰', peers: [SORA, MINSU], ago: 20, last: '시안 2차 올렸어요' },
  { id: TEAM, kind: 'team', name: '개발팀', peers: [MINSU, BOB], ago: 40, last: '배포 끝났어요' },
]

type State = 'online' | 'away' | 'offline'
async function tell(page: Page, people: { id: string; state: State }[]) {
  const r = await page.request.post('/__test/presence', { data: { people } })
  expect(r.ok()).toBeTruthy()
}
async function start(page: Page) {
  await reset(page)
  await routeRooms(page, ROOMS)
  await signIn(page)
}
const sidebarRow = (page: Page, name: string) => page.getByTestId('sidebar-room-row').filter({ hasText: name })
const faceIn = (l: Locator) => l.getByTestId('presence-face')

test('a second member\'s dot: online, away, offline in the sidebar and the DM header; group rows have none', async ({ page }) => {
  await start(page)
  const row = sidebarRow(page, 'Bob')
  await expect(faceIn(row)).toHaveAttribute('data-presence', 'offline')
  await expect(row.getByTestId('presence-dot')).toHaveCount(0)

  await tell(page, [{ id: 'bob', state: 'online' }])
  await expect(faceIn(row)).toHaveAttribute('data-presence', 'online')
  await expect(row.getByTestId('presence-dot')).toHaveAttribute('data-presence-dot', 'online')
  // the row reads "Bob, 접속 중"
  await expect(row.getByTestId('sidebar-room')).toHaveAccessibleName(/Bob ?, 접속 중/)
  // a group chat and a team room show no dot, even with Bob online
  for (const name of ['디자인 리뷰', '개발팀']) await expect(sidebarRow(page, name).getByTestId('presence-dot')).toHaveCount(0)

  // the DM's header: the dot on the picture, the words after the name
  await row.getByTestId('sidebar-room').click()
  await expect(page.getByTestId('room-message')).toHaveCount(1)
  const header = page.getByTestId('room-members-button')
  const headerFace = faceIn(page.getByTestId('room'))
  await expect(headerFace).toHaveAttribute('data-presence', 'online')
  await expect(header).toHaveAccessibleName(/Bob ?, 접속 중/)
  // on a computer the phone's dot before the name is not shown
  await expect(header.getByTestId('presence-dot')).toBeHidden()

  await tell(page, [{ id: 'bob', state: 'away' }])
  await expect(faceIn(row)).toHaveAttribute('data-presence', 'away')
  await expect(headerFace).toHaveAttribute('data-presence', 'away')
  await expect(headerFace.getByTestId('presence-dot')).toHaveAttribute('data-presence-dot', 'away')
  await expect(header).toHaveAccessibleName(/Bob ?, 자리 비움/)
  // hollow: the background inside a ring
  const away = await headerFace.getByTestId('presence-dot').evaluate((e) => getComputedStyle(e).boxShadow)
  expect(away).toContain('inset')

  // a mouse on the picture: the state as the shared tooltip
  await headerFace.hover()
  await expect(page.getByRole('tooltip')).toHaveText('자리 비움')
  await page.mouse.move(700, 500)

  await tell(page, [{ id: 'bob', state: 'offline' }])
  await expect(faceIn(row)).toHaveAttribute('data-presence', 'offline')
  await expect(headerFace).toHaveAttribute('data-presence', 'offline')
  await expect(page.getByTestId('room').getByTestId('presence-dot')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-rooms-list').getByTestId('presence-dot')).toHaveCount(0)
  // the header still says it, for a screen reader
  await expect(header).toHaveAccessibleName(/Bob ?, 오프라인/)
})

test('a reload brings the list back with the new connection (it is a state, sent after each hello)', async ({ page }) => {
  await start(page)
  await tell(page, [{ id: 'bob', state: 'online' }, { id: 'sora', state: 'away' }])
  await expect(faceIn(sidebarRow(page, 'Bob'))).toHaveAttribute('data-presence', 'online')
  await page.reload()
  await expect(faceIn(sidebarRow(page, 'Bob'))).toHaveAttribute('data-presence', 'online')
  await expect(faceIn(sidebarRow(page, '김소라'))).toHaveAttribute('data-presence', 'away')
  await expect(faceIn(sidebarRow(page, '이민수'))).toHaveAttribute('data-presence', 'offline')
  // the page said it is in use, right after each hello (its own window's state)
  const sent = (await (await page.request.get('/__test/presence')).json()).sent as { user: string; state: string }[]
  const mine = sent.filter((s) => s.user === 'olga').map((s) => s.state)
  expect(mine.length).toBeGreaterThanOrEqual(2)
  expect(new Set(mine)).toEqual(new Set(['active']))
})

test('the member list: each person\'s dot, mine too; no serious accessibility problem', async ({ page }) => {
  await start(page)
  await tell(page, [{ id: 'olga', state: 'online' }, { id: 'sora', state: 'away' }])
  await page.goto(`/rooms/${GROUP}`)
  await expect(page.getByTestId('room-message')).toHaveCount(1)
  await page.getByTestId('room-members-button').click()
  const members = page.getByTestId('room-member')
  await expect(members).toHaveCount(3)
  const of = (name: string) => members.filter({ hasText: name })
  await expect(faceIn(of('Olga'))).toHaveAttribute('data-presence', 'online')
  await expect(faceIn(of('김소라'))).toHaveAttribute('data-presence', 'away')
  await expect(faceIn(of('이민수'))).toHaveAttribute('data-presence', 'offline')
  await expect(of('이민수').getByTestId('presence-text')).toHaveText(', 오프라인')
  // 10 px on the 32 px pictures, its ring in the dialog's colour
  const dot = of('Olga').getByTestId('presence-dot')
  expect(await dot.evaluate((e) => [e.getBoundingClientRect().width, e.getBoundingClientRect().height])).toEqual([10, 10])
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
})

test('자리 비움으로 표시: one item in the account menu, kept in my account, and back', async ({ page }) => {
  await start(page)
  await page.getByTestId('account-menu').click()
  const item = page.getByTestId('account-away')
  await expect(item).toHaveText('자리 비움으로 표시')
  const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/api/me/away'))
  await item.click()
  expect((await put).postDataJSON()).toEqual({ away: true })
  // the menu closed, the keyboard back on its button
  await expect(page.getByTestId('account-dropdown')).toHaveCount(0)
  await expect(page.getByTestId('account-menu')).toBeFocused()
  expect((await (await page.request.get('/api/me')).json()).user.prefs.away).toBe(true)
  await page.reload()
  await page.getByTestId('account-menu').click()
  await expect(page.getByTestId('account-away')).toHaveText('접속 중으로 표시')
  await page.getByTestId('account-away').click()
  await expect.poll(async () => (await (await page.request.get('/api/me')).json()).user.prefs.away).toBeUndefined()
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the 대화 list and the DM header: the dot on the picture, and before the name in the header', async ({ page }) => {
    await start(page)
    await page.goto('/rooms')
    await tell(page, [{ id: 'bob', state: 'online' }])
    const row = page.getByTestId('rooms-row').filter({ hasText: 'Bob' })
    await expect(faceIn(row)).toHaveAttribute('data-presence', 'online')
    await row.click()
    await expect(page.getByTestId('room-message')).toHaveCount(1)
    const header = page.getByTestId('room-members-button')
    await expect(header.getByTestId('presence-dot')).toBeVisible()
    await expect(header.getByTestId('presence-dot')).toHaveAttribute('data-presence-dot', 'online')
    await tell(page, [{ id: 'bob', state: 'away' }])
    await expect(header.getByTestId('presence-dot')).toHaveAttribute('data-presence-dot', 'away')
    await tell(page, [{ id: 'bob', state: 'offline' }])
    await expect(header.getByTestId('presence-dot')).toHaveCount(0)
    await expect(header).toHaveAccessibleName(/Bob ?, 오프라인/)
  })
})

// ---------------- screenshots and sizes for review (SHOTS_DIR) ----------------
const shots = (page: Page) => {
  const dir = process.env.SHOTS_DIR!
  fs.mkdirSync(dir, { recursive: true })
  return (name: string) => page.screenshot({ path: path.join(dir, `${name}.png`) })
}
const THREE: { id: string; state: State }[] = [{ id: 'olga', state: 'online' }, { id: 'bob', state: 'online' }, { id: 'sora', state: 'away' }]

/** sizes of a dot and the text beside it, for the review */
async function measure(row: Locator, text: Locator) {
  const dot = await row.getByTestId('presence-dot').first().evaluate((e) => {
    const r = e.getBoundingClientRect()
    const s = getComputedStyle(e)
    return { w: r.width, h: r.height, ring: s.boxShadow, bg: s.backgroundColor }
  })
  const font = await text.evaluate((e) => getComputedStyle(e).fontSize)
  // the phone's DM header has the dot before the name and no picture
  const faces = row.getByTestId('presence-face')
  const face = (await faces.count()) ? await faces.first().evaluate((e) => e.getBoundingClientRect().width) : null
  return { dot, face, font }
}

test('screenshots at 1440: the sidebar with all three states, the DM header, the member list (light and dark)', async ({ page }) => {
  test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
  test.setTimeout(180_000)
  const shot = shots(page)
  const sizes: Record<string, unknown> = {}
  await page.setViewportSize({ width: 1440, height: 900 })
  await start(page)
  await tell(page, THREE)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.goto('/')
    await expect(faceIn(sidebarRow(page, 'Bob'))).toHaveAttribute('data-presence', 'online')
    await expect(faceIn(sidebarRow(page, '김소라'))).toHaveAttribute('data-presence', 'away')
    await shot(`after-sidebar-1440-${scheme}`)
    await sidebarRow(page, '김소라').hover()
    await shot(`after-sidebar-hover-1440-${scheme}`)
    if (scheme === 'light') {
      sizes['sidebar-online'] = await measure(sidebarRow(page, 'Bob'), sidebarRow(page, 'Bob').getByTestId('sidebar-room'))
      sizes['sidebar-away'] = await measure(sidebarRow(page, '김소라'), sidebarRow(page, '김소라').getByTestId('sidebar-room'))
      sizes['account-row'] = await measure(page.getByTestId('account-menu'), page.getByTestId('account-menu').locator('span.truncate'))
    }
    await page.getByTestId('account-menu').click()
    await shot(`after-account-menu-1440-${scheme}`)
    await page.keyboard.press('Escape')
    await page.goto(`/rooms/${DM}`)
    await expect(page.getByTestId('room-message')).toHaveCount(1)
    await shot(`after-dm-header-1440-${scheme}`)
    if (scheme === 'light') sizes['dm-header'] = await measure(page.getByTestId('room'), page.getByTestId('room-title'))
    await page.goto(`/rooms/${GROUP}`)
    await expect(page.getByTestId('room-message')).toHaveCount(1)
    await page.getByTestId('room-members-button').click()
    await expect(page.getByTestId('room-member')).toHaveCount(3)
    await shot(`after-members-1440-${scheme}`)
    if (scheme === 'light') sizes['members'] = await measure(page.getByTestId('room-members'), page.getByTestId('room-member').first().locator('span.font-medium').first())
    await page.keyboard.press('Escape')
  }
  fs.writeFileSync(path.join(process.env.SHOTS_DIR!, 'presence-sizes-1440.json'), JSON.stringify(sizes, null, 2))
})

test.describe('phone screenshots', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('screenshots at 390: the 대화 list with all three states, the DM header, the member list (light and dark)', async ({ page }) => {
    test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
    test.setTimeout(180_000)
    const shot = shots(page)
    const sizes: Record<string, unknown> = {}
    await start(page)
    await tell(page, THREE)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await page.goto('/rooms')
      const bob = page.getByTestId('rooms-row').filter({ hasText: 'Bob' })
      await expect(faceIn(bob)).toHaveAttribute('data-presence', 'online')
      await shot(`after-rooms-list-390-${scheme}`)
      if (scheme === 'light') sizes['rooms-list'] = await measure(bob, bob.locator('span.text-base').first())
      await page.goto(`/rooms/${DM}`)
      await expect(page.getByTestId('room-message')).toHaveCount(1)
      await shot(`after-dm-header-390-${scheme}`)
      if (scheme === 'light') sizes['dm-header'] = await measure(page.getByTestId('room-members-button'), page.getByTestId('room-title'))
      await page.goto(`/rooms/${GROUP}`)
      await expect(page.getByTestId('room-message')).toHaveCount(1)
      await page.getByTestId('room-members-button').click()
      await expect(page.getByTestId('room-member')).toHaveCount(3)
      await page.waitForTimeout(400)
      await shot(`after-members-390-${scheme}`)
      if (scheme === 'light') sizes['members'] = await measure(page.getByTestId('room-members'), page.getByTestId('room-member').first().locator('span.font-medium').first())
      await page.keyboard.press('Escape')
    }
    fs.writeFileSync(path.join(process.env.SHOTS_DIR!, 'presence-sizes-390.json'), JSON.stringify(sizes, null, 2))
  })
})
