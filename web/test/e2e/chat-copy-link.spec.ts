// 링크 복사 on an AI chat (docs/AGENTS/plan: chat-copy-link): in a shared project chat the header's "⋯" copies the chat's
// address (<origin>/c/<id>, nothing else) and the toast says how many project members can open it. Someone who reads the
// project folder opens the link and sees the chat; someone who does not gets the same "not found" page as for an address
// that was never a chat (no word on whether it exists); a signed-out person signs in and lands on the chat.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }
const DANA = { username: 'dana', password: 'dana password 1' }
const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
const patch = (page: Page, path: string, data: object) => page.request.patch(path, { headers: { [CSRF_HEADER]: '1' }, data })
const KO = { shared: /링크를 복사했어요 · 멤버 \d+명이 열 수 있어요/, private: '링크를 복사했어요 · 나만 열 수 있어요', notFound: '이 채팅을 열 수 없어요.', copy: '링크 복사',
  onlyMe: '나만 열 수 있는 채팅이에요. 링크를 받은 사람은 열 수 없어요.',
  why: '만든 사람만 볼 수 있는 채팅이거나, 삭제됐거나, 내가 멤버가 아닌 프로젝트의 채팅일 수 있어요. 링크를 보낸 사람에게 프로젝트 멤버와 공유해 달라고 해 주세요.' }

async function windowOf(browser: Browser, who?: typeof BOB) {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'ko-KR', viewport: { width: 1360, height: 860 } })
  const page = await ctx.newPage()
  if (who) await signIn(page, who)
  return page
}

test('copy a link in a shared project chat: a member opens it, a non-member gets "not found", a signed-out person comes back to it after sign-in', async ({ page, browser }) => {
  await reset(page, { withAdmin: true })
  await signIn(page)
  const p = await post(page, '/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '' })
  expect(p.status()).toBe(201)
  const projectId = ((await p.json()) as { id: string }).id
  expect((await patch(page, `/api/projects/${projectId}`, { shareChats: true })).ok()).toBeTruthy()
  const chat = (await (await post(page, '/api/chats', { projectId })).json()) as { id: string }
  expect((await post(page, `/api/chats/${chat.id}/messages`, { content: 'hello', clientMessageId: uuidv7() })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')

  // copy: the header's menu, the address alone, the toast with who can open it
  await page.goto(`/c/${chat.id}`)
  await page.getByTestId('chat-menu').click()
  await page.getByTestId('chat-copy-link').click()
  await expect(page.getByText(KO.shared)).toBeVisible()
  const link = await page.evaluate(() => navigator.clipboard.readText())
  expect(link).toBe(`${new URL(page.url()).origin}/c/${chat.id}`)

  // a project person (Bob reads marketing/) opens it
  const bob = await windowOf(browser, BOB)
  await bob.goto(link)
  await expect(bob.getByTestId('chat-title')).toBeVisible()
  await expect(bob.getByText(KO.notFound)).toHaveCount(0)
  await bob.context().close()

  // the folder is read by Olga and Bob only: Dana (an admin without access) gets the page every missing chat gets
  expect((await post(page, '/__test/restrict', { path: 'marketing', users: ['olga', 'bob'] })).ok()).toBeTruthy()
  const dana = await windowOf(browser, DANA)
  await dana.goto(link)
  await expect(dana.getByText(KO.notFound)).toBeVisible()
  await dana.goto(`/c/${uuidv7()}`)
  await expect(dana.getByText(KO.notFound)).toBeVisible()
  await dana.context().close()

  // signed out: the sign-in page keeps the path, and the chat opens after it
  const out = await windowOf(browser)
  await out.goto(link)
  await expect(out).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(`/c/${chat.id}`)}$`))
  await out.getByTestId('login-username').fill(BOB.username)
  await out.getByTestId('login-password').fill(BOB.password)
  await out.getByTestId('login-submit').click()
  await expect(out).toHaveURL(new RegExp(`/c/${chat.id}$`))
  await expect(out.getByTestId('chat-title')).toBeVisible()
  await out.context().close()
})

test('a private chat: the toast says only I can open it', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const chat = (await (await post(page, '/api/chats', {})).json()) as { id: string }
  await page.goto(`/c/${chat.id}`)
  await page.getByTestId('chat-menu').click()
  await page.getByRole('menuitem', { name: KO.copy }).click()
  await expect(page.getByText(KO.private)).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(page.url()).origin}/c/${chat.id}`)
})

// QA TC-919, TC-948, TC-949 (owner report 2026-11-13): a private chat in a team project ("Only me", from before, or
// brought in; docs/DECISIONS.md "Team project chats shared by default"). Its copied link says nobody else can open it,
// with "멤버와 공유"; a member who opens it gets the page every chat that cannot be opened gets, which says the likely
// reason and what to ask for, the same for an address that was never a chat; no admin line for a member.
test('a private chat in a team project: the toast says others cannot open it, a member reads why on the not-found page', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const p = await post(page, '/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '' })
  expect(p.status()).toBe(201)
  const projectId = ((await p.json()) as { id: string }).id
  const chat = (await (await post(page, '/api/chats', { projectId, private: true })).json()) as { id: string; shared?: unknown }
  expect(chat.shared).toBeUndefined()
  await page.goto(`/c/${chat.id}`)
  await page.getByTestId('chat-menu').click()
  await page.getByRole('menuitem', { name: KO.copy }).click()
  await expect(page.getByText(KO.onlyMe)).toBeVisible()
  const link = await page.evaluate(() => navigator.clipboard.readText())
  const dir = process.env.SHOT_DIR
  if (dir) await page.screenshot({ path: `${dir}/copy-link-only-me-1440.png` })
  // its action opens the share's confirm (sharing cannot be undone: it asks first)
  await page.getByRole('button', { name: '멤버와 공유' }).click()
  await expect(page.getByTestId('share-chat-cancel')).toBeVisible()
  await page.getByTestId('share-chat-cancel').click()

  // Bob reads marketing/ (a member of Launch) but the chat is not shared: the one page, with the reason; no admin line
  const bob = await windowOf(browser, BOB)
  await bob.goto(link)
  await expect(bob.getByText(KO.notFound)).toBeVisible()
  await expect(bob.getByTestId('chat-not-found-why')).toHaveText(KO.why)
  await expect(bob.getByTestId('chat-not-found-manage')).toHaveCount(0)
  if (dir) await bob.screenshot({ path: `${dir}/not-found-member-1440.png` })
  // the same page for an address that was never a chat (no word on whether it exists)
  await bob.goto(`/c/${uuidv7()}`)
  await expect(bob.getByTestId('chat-not-found-why')).toHaveText(KO.why)
  await bob.context().close()
})
