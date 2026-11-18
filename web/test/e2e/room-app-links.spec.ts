// Named app links in the browser (docs/decisions/20261118-named-app-links.md): a pasted address of a chat, a project, a
// file link, a folder or a file shows as a chip with the name the server gave this viewer (POST /api/link-names, one
// request for the screen's links), the generic words where the server gave none (no access or not there, said alike),
// a Markdown link keeps its words, an address in code stays code, and a click opens the thing in the app. The room is
// answered through page.route (rooms-mock.ts), the names as the server would decide them for this viewer.
// SHOTS_DIR=<folder>: the room, 1440 and 390, light and dark.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: '소라님' }
const TEAM = 'https://acme.example'
const CHAT = '019a5f00-0000-7000-8000-00000000c001'
const SECRET_CHAT = '019a5f00-0000-7000-8000-00000000c002'
const PROJECT = '019a5f00-0000-7000-8000-00000000c003'
const TOKEN = 'pHIHdVetZ6O1FMvE77jjVg'
const GONE = 'zzzzzzzzzzzzzzzzzzzzzz'
const id = (n: number) => `019a5f00-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`
const shots = process.env.SHOTS_DIR

/** what the server names for this viewer: the rest is null (no access or not there) */
const NAMES: Record<string, string> = {
  [`chat:${CHAT}`]: '3분기 예산 정리',
  [`project:${PROJECT}`]: '신제품 출시',
  [`share:${TOKEN}`]: '견적서_v2.pdf',
  'folder:shared/reports': 'reports',
  'file:shared/reports/week 1.md': 'week 1.md',
}

async function openRoom(page: Page) {
  await reset(page)
  await page.request.post('/__test/team-address', { headers: { [CSRF_HEADER]: '1' }, data: { address: TEAM } })
  const asked: { kind: string; id: string }[][] = []
  await page.route('**/api/link-names', async (route) => {
    const links = (route.request().postDataJSON() as { links: { kind: string; id: string }[] }).links
    asked.push(links)
    await route.fulfill({ json: { items: links.map((l) => ({ ...l, name: NAMES[`${l.kind}:${l.id}`] ?? null })) } })
  })
  await routeRoom(page, {
    members: [SORA],
    messages: [
      { id: id(1), author: SORA, body: `예산은 여기 ${TEAM}/c/${CHAT} 에 정리했어요. 프로젝트: ${TEAM}/projects/${PROJECT}` },
      { id: id(2), author: SORA, body: `파일 ${TEAM}/f/${TOKEN} · 폴더 ${TEAM}/files?path=shared%2Freports · 문서 ${TEAM}/files/view?path=shared%2Freports%2Fweek%201.md` },
      { id: id(3), author: SORA, body: `못 여는 것: ${TEAM}/c/${SECRET_CHAT} 그리고 ${TEAM}/f/${GONE}` },
      { id: id(4), author: SORA, body: `[예산 대화](${TEAM}/c/${CHAT}) 그리고 \`${TEAM}/c/${CHAT}\`` },
    ],
  })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(4)
  return { asked }
}

async function shoot(page: Page, name: string) {
  if (!shots) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('named chips for what I can open, the generic words for the rest, labels and code kept; a click opens it in the app', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { asked } = await openRoom(page)
  const msgs = page.getByTestId('room-message')
  await expect(msgs.nth(0).getByTestId('app-link-chip').first()).toHaveText('3분기 예산 정리')
  await expect(msgs.nth(0).getByTestId('app-link-chip').nth(1)).toHaveText('신제품 출시')
  await expect(msgs.nth(1).getByTestId('app-link-chip')).toHaveText(['견적서_v2.pdf', 'reports', 'week 1.md'])
  // no name from the server: the kind of thing only, quieter, with the reason on hover
  const none = msgs.nth(2).getByTestId('app-link-chip')
  await expect(none).toHaveText(['트리나 채팅', '트리나 파일'])
  for (const i of [0, 1]) await expect(none.nth(i)).not.toHaveAttribute('data-named', '')
  await expect(none.first()).toHaveAttribute('title', '열 수 있는 사람에게만 이름이 보여요.')
  // the author's words stay; an address in code stays code
  await expect(msgs.nth(3).getByTestId('app-link-chip')).toHaveCount(0)
  await expect(msgs.nth(3).getByTestId('room-link')).toHaveText('예산 대화')
  await expect(msgs.nth(3).locator('code')).toHaveText(`${TEAM}/c/${CHAT}`)
  // every link of the screen asked once (deduplicated), in one request
  const all = asked.flat()
  expect(new Set(all.map((l) => `${l.kind}:${l.id}`)).size).toBe(all.length)
  expect(all.length).toBe(7)
  await shoot(page, 'app-links-1440')
  // a click opens it inside the app (the team address's link, this page's path)
  await expect(msgs.nth(0).getByTestId('app-link-chip').first()).toHaveAttribute('href', `/c/${CHAT}`)
  await msgs.nth(0).getByTestId('app-link-chip').nth(1).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}$`))
})

test('390: the chips wrap with the words, no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openRoom(page)
  await expect(page.getByTestId('room-message').nth(1).getByTestId('app-link-chip')).toHaveCount(3)
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(wide).toBe(false)
  await shoot(page, 'app-links-390')
})
