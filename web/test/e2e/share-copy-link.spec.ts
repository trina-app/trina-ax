// Copy link in the Share dialogs (docs/decisions/20261116-chat-share-copy-link.md, QA TC-3933): bottom left of a chat's
// Share dialog and a project's Share / Members dialog, as in the file's. It copies the chat's /c/<id> (the project's
// /projects/<id>) with the toast that says who opens it; with people picked and not saved, a project's dialog says in one
// line that they open it after the save (a chat's dialog keeps to its one short note: docs/AGENTS/plan/
// 20261122-0300-share-dialog-lean.md); after the save the toast offers Copy link again. Someone who can't see it gets Ask for access
// (docs/decisions/20261116-chat-project-ask-access.md), with no title and no name. At 1440 and 390, light and dark, as
// owner, member and guest; SHOT_DIR keeps screenshots.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const SORA = { username: 'sora', password: 'sora-Password-1' }
const SHOTS = process.env.SHOT_DIR
const TITLE = 'Q3 budget questions'

async function as(browser: Browser, who: { username: string; password: string }, width: number) {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'en-US', viewport: { width, height: width < 768 ? 844 : 900 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] })
  const p = await ctx.newPage()
  await signIn(p, who)
  return p
}
/** Sora, a member made by the admin: signs in with her temporary password and sets her own first */
async function soraIn(browser: Browser, width: number) {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'en-US', viewport: { width, height: width < 768 ? 844 : 900 }, serviceWorkers: 'block' })
  const p = await ctx.newPage()
  await p.goto('/login')
  await p.getByTestId('login-username').fill(SORA.username)
  await p.getByTestId('login-password').fill(SORA.password)
  await p.getByTestId('login-submit').click()
  await expect(p).toHaveURL(/\/password/)
  await p.getByTestId('password-new').fill('a brand new password 2')
  await p.getByTestId('password-new2').fill('a brand new password 2')
  await p.getByTestId('password-submit').click()
  await expect(p).not.toHaveURL(/\/password/)
  return p
}
async function shots(page: Page, name: string) {
  if (!SHOTS) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    // (the buttons' colour transition ends first)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
async function chatOf(page: Page, title: string) {
  const chat = (await (await page.request.post('/api/chats', { headers: H, data: {} })).json()) as { id: string }
  expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: 'Summarise the budget', clientMessageId: uuidv7() } })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  expect((await page.request.patch(`/api/chats/${chat.id}`, { headers: H, data: { title } })).ok()).toBeTruthy()
  return chat.id
}
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())
const noSideScroll = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

for (const width of [1440, 390]) {
  test.describe(`at ${width}`, () => {
    test('chat: Copy link while private, the unsaved line, Save then Copy link from the toast; outsiders get Ask for access with nothing of the chat', async ({ page, browser }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      expect((await page.request.post('/api/admin/users', { headers: H, data: { id: 'sora', username: 'sora', name: 'Sora Kim', role: 'member', groupIds: [], temporaryPassword: SORA.password } })).ok()).toBeTruthy()
      const chatId = await chatOf(page, TITLE)
      await page.close()
      const olga = await as(browser, { username: 'olga', password: 'correct horse battery' }, width)
      const origin = new URL(olga.url()).origin
      await olga.goto(`/c/${chatId}`)
      await expect(olga.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
      await olga.getByTestId('chat-share').click()
      const dialog = olga.getByRole('dialog')
      await expect(dialog.getByTestId('chat-share-picker')).toBeVisible()

      // private ("Only me"): Copy link is there, the toast says only I open it
      const copy = dialog.getByTestId('chat-share-copy-link')
      await expect(copy).toHaveText('Copy link')
      await expect(dialog.getByTestId('chat-share-copy-link-unsaved')).toHaveCount(0)
      await shots(olga, `chat-share-private-${width}`)
      await copy.click()
      expect(await clipboard(olga)).toBe(`${origin}/c/${chatId}`)
      await expect(olga.getByTestId('toast').filter({ hasText: 'Link copied · only you can open it' })).toBeVisible()

      // Bob picked, not saved: Copy link stays, no extra line by the buttons (the lean chat dialog)
      await olga.getByTestId('chat-share-picker-search').fill('Bob')
      await olga.getByTestId('participant-add-user-bob').click()
      await expect(dialog.getByTestId('participant-user-bob')).toHaveAttribute('data-state', 'new')
      await expect(dialog.getByTestId('chat-share-copy-link')).toBeVisible()
      await expect(dialog.getByTestId('chat-share-copy-link-unsaved')).toHaveCount(0)
      await expect(dialog.getByTestId('chat-share-save')).toBeEnabled()
      expect(await noSideScroll(olga)).toBe(true)
      await shots(olga, `chat-share-unsaved-${width}`)

      // Share: the toast offers Copy link, which copies the same address and says who opens it now
      await dialog.getByTestId('chat-share-save').click()
      await expect(olga.getByRole('dialog')).toHaveCount(0)
      const done = olga.getByTestId('toast').filter({ hasText: 'Shared with 1 person' })
      await expect(done).toBeVisible()
      await expect(done.getByRole('button', { name: 'Copy link' })).toBeVisible()
      await shots(olga, `chat-share-saved-toast-${width}`)
      await olga.evaluate(() => navigator.clipboard.writeText(''))
      await done.getByRole('button', { name: 'Copy link' }).click()
      expect(await clipboard(olga)).toBe(`${origin}/c/${chatId}`)
      await expect(olga.getByTestId('toast').filter({ hasText: 'Link copied · 2 people can open it' })).toBeVisible()

      // shared now: the dialog again has Copy link and no unsaved line
      await olga.getByTestId('chat-share').click()
      await expect(olga.getByRole('dialog').getByTestId('chat-share-copy-link')).toBeVisible()
      await expect(olga.getByRole('dialog').getByTestId('chat-share-copy-link-unsaved')).toHaveCount(0)
      await shots(olga, `chat-share-shared-${width}`)
      await olga.keyboard.press('Escape')

      // Bob (in it) opens the link; his read-only dialog copies too
      const bob = await as(browser, BOB, width)
      await bob.goto(`/c/${chatId}`)
      await expect(bob.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')

      // Sora (a member not in it): Ask for access, nothing of the chat on it (docs/decisions/
      // 20261116-chat-project-ask-access.md); an address that was never a chat keeps the plain not-found page
      const sora = await soraIn(browser, width)
      await sora.goto(`/c/${chatId}`)
      await expect(sora.getByTestId('link-access-ask')).toBeVisible()
      const text = `${await sora.title()} ${await sora.getByTestId('link-access-ask').innerText()}`
      for (const leak of [TITLE, 'Olga', 'Bob', 'Summarise']) expect(text).not.toContain(leak)
      await sora.goto(`/c/${uuidv7()}`)
      await expect(sora.getByTestId('chat-not-found')).toBeVisible()
      for (const leak of [TITLE, 'Olga', 'Bob', 'Summarise']) expect(await sora.getByTestId('chat-not-found').innerText()).not.toContain(leak)
      await shots(sora, `chat-not-found-member-${width}`)
      for (const p of [olga, bob, sora]) await p.context().close()
    })

    test('project: Copy link in the members dialog (owner, member read only; a guest has none); an outsider gets Ask for access with nothing of the project', async ({ page, browser }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      expect((await page.request.post('/api/admin/users', { headers: H, data: { id: 'sora', username: 'sora', name: 'Sora Kim', role: 'member', groupIds: [], temporaryPassword: SORA.password } })).ok()).toBeTruthy()
      const r = await page.request.post('/__test/project', { data: { name: 'Launch plan', by: 'olga', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
      expect(r.ok()).toBeTruthy()
      const { id } = (await r.json()) as { id: string }
      await page.close()

      const olga = await as(browser, { username: 'olga', password: 'correct horse battery' }, width)
      const origin = new URL(olga.url()).origin
      await olga.goto(`/projects/${id}`)
      await olga.getByTestId('project-share').click()
      const dialog = olga.getByRole('dialog')
      const copy = dialog.getByTestId('project-members-copy-link')
      await expect(copy).toHaveText('Copy link')
      await shots(olga, `project-members-owner-${width}`)
      await copy.click()
      expect(await clipboard(olga)).toBe(`${origin}/projects/${id}`)
      await expect(olga.getByTestId('toast').filter({ hasText: 'Link copied. People with access can open it.' })).toBeVisible()
      await olga.keyboard.press('Escape')
      await olga.context().close()

      // Bob, a member who can't change the members: read only, Copy link still there
      const bob = await as(browser, BOB, width)
      await bob.goto(`/projects/${id}`)
      const faces = bob.getByTestId('project-people-header').or(bob.getByTestId('project-who-sees'))
      await faces.first().click()
      const bobDialog = bob.getByRole('dialog')
      await expect(bobDialog.getByTestId('project-members-copy-link')).toBeVisible()
      await expect(bobDialog.getByTestId('project-members-save')).toHaveCount(0)
      await shots(bob, `project-members-member-${width}`)
      await bob.context().close()

      // a guest of the project (Gina)
      expect((await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).request.post('/__test/guest', { data: { id: 'gina', name: 'Gina Park', place: { kind: 'project', id }, ai: { mode: 'none' } } })).ok()).toBeTruthy()
      // (a guest without AI lands on no chat box: signed in by hand)
      const gina = await (await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'en-US', viewport: { width, height: width < 768 ? 844 : 900 }, serviceWorkers: 'block' })).newPage()
      await gina.goto('/login')
      await gina.getByTestId('login-username').fill('gina')
      await gina.getByTestId('login-password').fill('gina password 1')
      await gina.getByTestId('login-submit').click()
      await expect(gina.getByTestId('login-submit')).toHaveCount(0)
      await gina.goto(`/projects/${id}`)
      // a guest has no Share and no members dialog (the guest UX): the page itself is their link, nothing new to copy
      await expect(gina.getByTestId('project-people-header')).toBeVisible()
      await expect(gina.getByTestId('project-share')).toHaveCount(0)
      await shots(gina, `project-guest-${width}`)
      await gina.context().close()

      // Sora (not in it): nothing of its name or people
      const sora = await soraIn(browser, width)
      await sora.goto(`/projects/${id}`)
      // (Ask for access since docs/decisions/20261116-chat-project-ask-access.md)
      await expect(sora.getByTestId('link-access-ask')).toBeVisible()
      const text = `${await sora.title()} ${await sora.getByTestId('link-access-ask').innerText()}`
      for (const leak of ['Launch plan', 'Olga', 'Bob']) expect(text).not.toContain(leak)
      await shots(sora, `project-not-found-member-${width}`)
      await sora.context().close()
    })
  })
}

test('the team address is not the page\'s: Copy link copies the chat on the team address (the desktop app on the office network)', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  expect((await page.request.post('/__test/team-address', { data: { address: 'https://acme.example.com' } })).ok()).toBeTruthy()
  await signIn(page)
  const chatId = await chatOf(page, TITLE)
  await page.goto(`/c/${chatId}`)
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
  await page.getByTestId('chat-share').click()
  await page.getByRole('dialog').getByTestId('chat-share-copy-link').click()
  await expect(page.getByTestId('toast').filter({ hasText: 'Link copied' })).toBeVisible()
  expect(await clipboard(page)).toBe(`https://acme.example.com/c/${chatId}`)
  await expect(page.getByTestId('local-link-note')).toHaveCount(0)
})
