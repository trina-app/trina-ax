// A chat's rename and its move to a project show at once (lib/optimistic.ts; docs/DECISIONS.md "Optimistic changes:
// the screen first, the server after"): the 트리나 list's row has the new name, or its project, while the server has
// not answered yet (the test holds the request), and a refusal puts it back with one toast. A computer and a phone.
import { expect, test, type Page, type Route } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { chatList, isPhone } from './nav'
import { DICTS, translate } from '../../src/i18n'

const t = DICTS.ko
const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })

async function chat(page: Page, title: string): Promise<string> {
  const r = await post(page, '/api/chats', { title })
  expect(r.ok()).toBeTruthy()
  return ((await r.json()) as { id: string }).id
}

/** Hold the chat's PATCH until `release` (or answer it with a refusal): the screen is checked before the server answers. */
async function holdPatch(page: Page, id: string, o: { refuse?: boolean } = {}) {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  let seen = false
  await page.route(`**/api/chats/${id}`, async (route: Route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    seen = true
    await gate
    if (o.refuse) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'Acme server hiccup.' } }) })
    else await route.continue()
  })
  return { release, seen: () => seen }
}

/** The chat's project as the 트리나 list shows it: 최근 기록's tag on a computer; on a phone the history drawer has no
 * tag, so the row's menu, whose item says "프로젝트 바꾸기…" once the chat is in one (and "프로젝트로 옮기기…" when not). */
async function expectInProject(page: Page, id: string, title: string, inIt: boolean) {
  if (!isPhone(page)) {
    const tag = (await chatList(page)).locator('li', { has: page.locator(`a[href="/c/${id}"]`) }).getByTestId('chat-row-project')
    if (inIt) await expect(tag).toHaveText('Launch')
    else await expect(tag).toHaveCount(0)
    return
  }
  await openRowMenu(page, title)
  await expect(page.getByTestId('chat-row-move')).toHaveText(t[inIt ? 'chat.project.change' : 'chat.project.add'])
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('chat-row-move')).toHaveCount(0)
}

async function openRowMenu(page: Page, title: string) {
  const list = await chatList(page)
  const row = list.getByRole('listitem').filter({ hasText: title }).first()
  await row.hover()
  await row.getByRole('button', { name: t['chat.menu'], exact: true }).click()
  return row
}

for (const vp of [{ name: '1440', use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  test.describe(`optimistic chat changes at ${vp.name}`, () => {
    test.use(vp.use)

    test('rename: the row has the new name before the server answers, and keeps it after a reload', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const id = await chat(page, 'Acme notes')
      await page.goto('/')
      const held = await holdPatch(page, id)
      await openRowMenu(page, 'Acme notes')
      await page.getByTestId('chat-row-rename').click()
      const field = page.getByTestId('dialog-input')
      await field.fill('Acme Q4 plan')
      await page.getByTestId('dialog-confirm').click()
      const list = await chatList(page)
      // the request is on its way and held: the row already says the new name
      await expect.poll(held.seen).toBe(true)
      await expect(list.locator(`a[href="/c/${id}"]`)).toContainText('Acme Q4 plan')
      held.release()
      await expect.poll(async () => ((await (await page.request.get(`/api/chats/${id}`)).json()) as { title: string }).title).toBe('Acme Q4 plan')
      await page.reload()
      await expect((await chatList(page)).locator(`a[href="/c/${id}"]`)).toContainText('Acme Q4 plan')
    })

    test('rename refused: the old name comes back with one error toast', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const id = await chat(page, 'Acme notes')
      await page.goto('/')
      const held = await holdPatch(page, id, { refuse: true })
      await openRowMenu(page, 'Acme notes')
      await page.getByTestId('chat-row-rename').click()
      await page.getByTestId('dialog-input').fill('Acme Q4 plan')
      await page.getByTestId('dialog-confirm').click()
      const row = (await chatList(page)).locator(`a[href="/c/${id}"]`)
      await expect.poll(held.seen).toBe(true)
      await expect(row).toContainText('Acme Q4 plan')
      held.release()
      await expect(row).toContainText('Acme notes')
      await expect(page.getByText('Acme server hiccup.')).toHaveCount(1)
    })

    test('move to a project: the dialog closes and the row is in the project before the server answers', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const r = await post(page, '/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing' })
      expect(r.ok()).toBeTruthy()
      const projectId = ((await r.json()) as { id: string }).id
      const id = await chat(page, 'Competitor notes')
      await page.goto('/')
      const held = await holdPatch(page, id)
      await openRowMenu(page, 'Competitor notes')
      await page.getByTestId('chat-row-move').click()
      const dialog = page.getByRole('dialog', { name: t['chat.project.title'] })
      await dialog.getByRole('radio', { name: /Launch/ }).check()
      await dialog.getByTestId('chat-project-save').click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(held.seen).toBe(true)
      // held: the row already shows its project (최근 기록's tag; a phone: its menu offers "프로젝트 바꾸기…")
      await expectInProject(page, id, 'Competitor notes', true)
      // the "moved" toast once the server has it
      await expect(page.getByText(translate('ko', 'chat.project.moved', { name: 'Launch' }))).toHaveCount(0)
      held.release()
      await expect(page.getByText(translate('ko', 'chat.project.moved', { name: 'Launch' }))).toBeVisible()
      await expect.poll(async () => ((await (await page.request.get(`/api/chats/${id}`)).json()) as { projectId: string | null }).projectId).toBe(projectId)
    })

    test('move refused: the row is out of the project again, with one error toast', async ({ page }) => {
      await reset(page)
      await signIn(page)
      expect((await post(page, '/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing' })).ok()).toBeTruthy()
      const id = await chat(page, 'Competitor notes')
      await page.goto('/')
      const held = await holdPatch(page, id, { refuse: true })
      await openRowMenu(page, 'Competitor notes')
      await page.getByTestId('chat-row-move').click()
      const dialog = page.getByRole('dialog', { name: t['chat.project.title'] })
      await dialog.getByRole('radio', { name: /Launch/ }).check()
      await dialog.getByTestId('chat-project-save').click()
      await expect.poll(held.seen).toBe(true)
      await expectInProject(page, id, 'Competitor notes', true)
      held.release()
      await expect(page.getByText('Acme server hiccup.')).toHaveCount(1)
      await expectInProject(page, id, 'Competitor notes', false)
      await expect(page.getByText('Acme server hiccup.')).toHaveCount(1)
    })
  })
}
