// A project page's chat row "···" on a phone (QA TC-248): a bottom sheet across the window (a transform on the button's
// box held it in a 30 px strip) with the sidebar row's items by the same rules (components/chat/chatMenuItems.tsx):
// my own chat pin, 링크 복사, rename, 프로젝트 변경, delete; a shared chat of someone else no rename and no move, delete only
// for a project editor. Rename and delete change the row at once. TC_SHOTS=<folder> keeps screenshots of the sheet.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const }
const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
const shot = async (page: Page, name: string) => {
  if (process.env.TC_SHOTS) await page.screenshot({ path: `${process.env.TC_SHOTS}/tc248-${name}.png` })
}

test.use(PHONE)

/** a team project on marketing/ with its chats shared (Olga, Bob and the admins read marketing/) */
async function project(page: Page) {
  const r = await post(page, '/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '' })
  expect(r.status()).toBe(201)
  const id = ((await r.json()) as { id: string }).id
  expect((await page.request.patch(`/api/projects/${id}`, { headers: { [CSRF_HEADER]: '1' }, data: { shareChats: true } })).ok()).toBeTruthy()
  return id
}
async function bob(browser: Browser) {
  const page = await (await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'ko-KR', ...PHONE })).newPage()
  await signIn(page, BOB)
  return page
}
/** the row's "···" opened: the sheet's box and its items' test ids */
async function openMenu(page: Page, title: string) {
  const row = page.getByTestId('project-chats').getByRole('listitem').filter({ hasText: title })
  await row.getByTestId('project-chat-menu').click()
  const sheet = page.getByRole('menu')
  await expect(sheet).toBeVisible()
  return { sheet, box: (await sheet.boundingBox())!, items: await sheet.getByRole('menuitem').evaluateAll((xs) => xs.map((x) => x.getAttribute('data-testid'))) }
}

test('my own chat: a sheet across the bottom with every item; rename and delete change the row at once', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const id = await project(page)
  expect((await post(page, '/api/chats', { projectId: id, title: 'Weekly numbers' })).ok()).toBeTruthy()
  await page.goto(`/projects/${id}`)
  await expect(page.getByTestId('project-chat')).toHaveCount(1)

  const { sheet, box, items } = await openMenu(page, 'Weekly numbers')
  // the window's width, on its bottom edge (not a strip by the button)
  expect(box.width).toBeGreaterThan(380)
  expect(Math.round(box.x)).toBe(0)
  expect(Math.round(box.y + box.height)).toBe(844)
  await expect(page.getByTestId('menu-sheet-title')).toHaveText('Weekly numbers')
  // a shared chat of mine stays in its project: no move
  expect(items).toEqual(['project-chat-pin', 'project-chat-copy-link', 'project-chat-rename', 'project-chat-delete'])
  await shot(page, 'own-sheet')

  await sheet.getByTestId('project-chat-rename').click()
  await page.getByTestId('dialog-input').fill('Monthly numbers')
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByTestId('project-chat')).toHaveText(/Monthly numbers/)

  await openMenu(page, 'Monthly numbers')
  await page.getByTestId('project-chat-delete').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByTestId('project-chat')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('a chat of my own outside a shared project can move to another project from its row', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const r = await post(page, '/api/projects', { name: 'Solo', scope: 'team', folderPath: 'marketing', instructions: '' })
  const id = ((await r.json()) as { id: string }).id
  expect((await post(page, '/api/chats', { projectId: id, title: 'Draft' })).ok()).toBeTruthy()
  await page.goto(`/projects/${id}`)
  const { items } = await openMenu(page, 'Draft')
  expect(items).toEqual(['project-chat-pin', 'project-chat-copy-link', 'project-chat-rename', 'project-chat-move', 'project-chat-delete'])
  await page.getByTestId('project-chat-move').click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('someone else\'s shared chat: no rename; delete only for a project editor', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const id = await project(page)
  const b = await bob(browser)
  const bobs = (await (await post(b, '/api/chats', { projectId: id, title: 'Bob plan' })).json()) as { id: string; shared?: unknown }
  expect(bobs.shared).toBeTruthy()
  expect((await post(page, '/api/chats', { projectId: id, title: 'Owner plan' })).ok()).toBeTruthy()

  // the owner may edit the project: Bob's chat has delete, not rename
  await page.goto(`/projects/${id}`)
  await expect(page.getByTestId('project-chat')).toHaveCount(2)
  const owner = await openMenu(page, 'Bob plan')
  expect(owner.items).toEqual(['project-chat-pin', 'project-chat-copy-link', 'project-chat-delete'])
  await shot(page, 'editor-on-others-chat')

  // Bob, a member: the owner's chat has neither (as the server says: canDelete false)
  const canDelete = async (title: string) => {
    const list = (await (await b.request.get(`/api/chats?projectId=${id}`)).json()) as { items: { title: string; shared?: { canDelete: boolean } }[] }
    return list.items.find((c) => c.title === title)?.shared?.canDelete
  }
  expect(await canDelete('Owner plan')).toBe(false)
  await b.goto(`/projects/${id}`)
  await expect(b.getByTestId('project-chat')).toHaveCount(2)
  const member = await openMenu(b, 'Owner plan')
  expect(member.items).toEqual(['project-chat-pin', 'project-chat-copy-link'])
  await shot(b, 'member-on-others-chat')
  await b.context().close()
})
