// The next step under an AI answer (components/chat/StepFix.tsx; docs/decisions/20261116-ai-share-who-can-open.md): one
// line and one button in place of a dead end. The mock scripts the server's offers with "nextstep view | owner | admin
// | project" (test/mock/server.ts): after a post, the people who cannot open the file by name and Let them view; someone
// else's file, counted, Ask <owner>; a team folder, Ask an admin; a private chat in a team project, Share with project
// (the app's own share flow). A press runs once and the line says what happened; a reload keeps it. A chat moved into a
// team project says "Only you can see it" with Share with project in the toast. At 1440 and 390, light and dark;
// SHOTS_DIR keeps screenshots.
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const post = (page: Page, url: string, data: object) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
const patch = (page: Page, url: string, data: object) => page.request.patch(url, { headers: { [CSRF_HEADER]: '1' }, data })
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `step-fix-${name}-${page.viewportSize()!.width}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

for (const width of [1440, 390]) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: width > 400 ? 900 : 844 }, locale: 'en-US', reducedMotion: 'reduce' })

    test('after a post: the people by name, Let them view; one press, then what happened; a reload keeps it', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      const errors = watchConsole(page)
      await signIn(page)
      await ask(page, 'nextstep view')
      const fix = page.getByTestId('step-fix')
      await expect(fix).toHaveAttribute('data-state', 'open')
      await expect(fix.getByTestId('step-fix-text')).toHaveText("Jun Park, Mina Seo, Leo Kim and 1 more in #Sales can't open Quote.pdf yet. Guests can't be given files.")
      const button = fix.getByTestId('step-fix-button')
      await expect(button).toHaveText('Let them view')
      // one row, never wider than the answer; on a phone the button takes its own line
      const box = (await fix.boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      await audit(page, 'let them view')
      await shot(page, 'let-view-open')
      await button.click()
      await expect(fix).toHaveAttribute('data-state', 'done')
      await expect(fix.getByTestId('step-fix-text')).toHaveText("4 people can now view Quote.pdf. 1 more person there still can't open it.")
      await expect(fix.getByTestId('step-fix-button')).toHaveCount(0)
      await shot(page, 'let-view-done')
      await page.reload()
      await expect(page.getByTestId('step-fix')).toHaveAttribute('data-state', 'done')
      expect(realErrors(errors)).toEqual([])
    })

    test('someone else\'s file: counted, not named; Ask <owner>', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await ask(page, 'nextstep owner')
      const fix = page.getByTestId('step-fix')
      await expect(fix.getByTestId('step-fix-text')).toHaveText("3 people in #Sales can't open Quote.pdf yet. It's Mina Seo's file, so only they can share it.")
      await expect(fix.getByTestId('step-fix-button')).toHaveText('Ask Mina Seo')
      await shot(page, 'ask-owner-open')
      await fix.getByTestId('step-fix-button').click()
      await expect(fix.getByTestId('step-fix-text')).toHaveText('Asked Mina Seo to share Quote.pdf.')
      await shot(page, 'ask-owner-done')
    })

    test('a team folder: Ask an admin says who gets the message', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await ask(page, 'nextstep admin')
      const fix = page.getByTestId('step-fix')
      await expect(fix.getByTestId('step-fix-text')).toHaveText('Only admins can share the folder Contracts. This sends Dana Choi a message from you.')
      await expect(fix.getByTestId('step-fix-button')).toHaveText('Ask an admin')
      await shot(page, 'ask-admin-open')
      await fix.getByTestId('step-fix-button').click()
      await expect(fix.getByTestId('step-fix-text')).toHaveText('Asked Dana Choi about the folder Contracts.')
    })

    test('a chat moved into a team project: the toast says only I see it, with Share with project; the AI\'s offer opens the same share flow', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      const r = await post(page, '/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '' })
      expect(r.status()).toBe(201)
      const projectId = ((await r.json()) as { id: string }).id
      expect((await patch(page, `/api/projects/${projectId}`, { shareChats: true })).ok()).toBeTruthy()
      const chat = (await (await post(page, '/api/chats', {})).json()) as { id: string }
      expect((await post(page, `/api/chats/${chat.id}/messages`, { content: 'Plan the launch', clientMessageId: uuidv7() })).status()).toBe(202)
      await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
      await page.goto(`/c/${chat.id}`)
      await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
      await page.getByTestId('chat-menu').click()
      await page.getByTestId('chat-project-move').click()
      const dialog = page.getByRole('dialog')
      await dialog.getByText('Launch', { exact: true }).click()
      await dialog.getByTestId('chat-project-save').click()
      const toast = page.getByTestId('toast').filter({ hasText: 'Only you can see it' })
      await expect(toast).toContainText('Moved to Launch. Only you can see it.')
      await shot(page, 'moved-toast')
      await toast.getByRole('button', { name: 'Share with project' }).click()
      await expect(page.getByTestId('share-chat-ask')).toBeVisible()
      await page.getByTestId('share-chat-cancel').click()
      // "why can't Bob see this chat?": the AI's step offers the same flow, and reads done once the chat is shared
      await ask(page, 'nextstep project')
      const fix = page.getByTestId('step-fix')
      await expect(fix.getByTestId('step-fix-text')).toHaveText('Only you can see this chat.')
      await expect(fix.getByTestId('step-fix-button')).toHaveText('Share with project')
      await shot(page, 'share-project-open')
      // the chat shares only once the answer is done (the server refuses a share while it runs): wait for it, as a person
      // would see the answer finish
      await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
      await fix.getByTestId('step-fix-button').click()
      await expect(page.getByTestId('share-chat-ask')).toBeVisible()
      await page.getByTestId('share-chat-confirm').click()
      await expect(fix).toHaveAttribute('data-state', 'done')
      await expect(fix.getByTestId('step-fix-text')).toHaveText('Shared with the project Launch.')
      await shot(page, 'share-project-done')
    })
  })
}
