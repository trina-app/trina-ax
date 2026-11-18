// An AI chat's header has no ✦ (docs/decisions/20261118-phone-trina-button-in-ai-chats.md): the chat already is a
// conversation with Trina, and a computer's chat header never had one. ✦ in a header means "ask Trina beside this
// conversation" and stays where people talk: a room and a DM (their side chat). A phone's new chat is the 트리나 tab:
// ‹ from a chat opened by its address lands on its box. Private and team-project (shared) chats at 390 and 1440, with a
// room and a DM beside them. SHOTS=<folder>: screenshots of each header, light and dark.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, PRODUCT_NAMED_AFTER_AI, uuidv7 } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const ai = PRODUCT_NAMED_AFTER_AI ? t['rooms.aiName'] : PRODUCT.shortName
const askAi = t['sidebar.askAi'].replace('{name}', ai)
const sideChat = t['sideChat.open'].replace('{name}', ai)
const H = { [CSRF_HEADER]: '1' }
const SHOTS = process.env.SHOTS ?? ''

const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: H, data })
async function chat(page: Page, data: object): Promise<string> {
  const r = await post(page, '/api/chats', { title: 'Launch notes', ...data })
  expect(r.ok()).toBeTruthy()
  const id = ((await r.json()) as { id: string }).id
  // one question answered: Share shows on a chat with something in it
  expect((await post(page, `/api/chats/${id}/messages`, { content: 'Draft the launch post', clientMessageId: uuidv7() })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${id}`)).json()) as { runState: string }).runState).toBe('idle')
  return id
}
async function sharedProject(page: Page): Promise<string> {
  const r = await post(page, '/api/projects', { name: 'Hacker news launch', scope: 'team', folderPath: 'marketing', instructions: '' })
  expect(r.status()).toBe(201)
  const id = ((await r.json()) as { id: string }).id
  expect((await page.request.patch(`/api/projects/${id}`, { headers: H, data: { shareChats: true } })).ok()).toBeTruthy()
  return id
}
async function shot(page: Page, name: string, width: string) {
  if (!SHOTS) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: `${SHOTS}/${name}-${width}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

for (const vp of [
  { name: '390', phone: true, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  { name: '1440', phone: false, use: { viewport: { width: 1440, height: 900 } } },
]) {
  test.describe(`AI chat header at ${vp.name}`, () => {
    test.use(vp.use)

    test('a private and a shared project chat have no ✦ in the header; ‹ on a phone reaches the new-chat box', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const header = page.getByTestId('chat-bar')
      for (const [name, id] of [['ai-chat-private', await chat(page, {})], ['ai-chat-shared', await chat(page, { projectId: await sharedProject(page) })]] as const) {
        await page.goto(`/c/${id}`)
        await expect(page.getByTestId('chat-title')).toBeVisible()
        if (name === 'ai-chat-shared') await expect(page.getByTestId('chat-shared')).toBeVisible()
        await shot(page, name, vp.name)
        await expect(header.getByTestId('chat-new')).toHaveCount(0)
        await expect(header.getByRole('button', { name: askAi })).toHaveCount(0)
        await expect(header.getByRole('button', { name: sideChat })).toHaveCount(0)
        // the header keeps its other parts: ‹ on a phone, Share on my own chat (a project's shared chat is shared by
        // its project)
        if (name === 'ai-chat-private') await expect(header.getByTestId('chat-share')).toBeVisible()
        if (vp.phone) await expect(header.getByTestId('chat-back')).toBeVisible()
      }
      if (vp.phone) {
        // a new chat on a phone: ‹ from a chat opened by its address is the 트리나 tab's box
        await header.getByTestId('chat-back').click()
        await expect(page).toHaveURL(/\/$/)
        await expect(page.getByTestId('composer-input')).toBeVisible()
      }
    })

    for (const kind of ['group', 'dm'] as const) {
      test(`a ${kind === 'dm' ? 'DM' : 'room'} keeps its ✦ (the side chat)`, async ({ page }) => {
        await reset(page)
        await signIn(page)
        await routeRoom(page, { kind, members: [{ id: 'ben', name: '벤' }], messages: [{ id: '019a5f00-0000-7000-8000-000000000301', author: { id: 'ben', name: '벤' }, body: '내일 리뷰 자료 공유할게요' }] })
        await page.goto(`/rooms/${ROOM_ID}`)
        const button = page.getByTestId('room-side-chat-button')
        await expect(button).toBeVisible()
        await expect(button).toHaveAccessibleName(sideChat)
        await shot(page, kind === 'dm' ? 'dm' : 'room', vp.name)
      })
    }
  })
}
