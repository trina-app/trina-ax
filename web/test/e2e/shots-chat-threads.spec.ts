// Screenshots of threads on AI answers in shared chats (docs/decisions/20261116-chat-answer-threads.md), for review by
// eye: the thread open (beside the chat at 1440, the whole screen at 390) for the owner, an admin, a member and a guest,
// in English and Korean, light and dark; and, for the owner, the answer's row with "Reply in thread" and the thread
// line, an empty thread, the chat's box after "Send to Trina", and the read-only line while safe operations are on.
// The owner made the chat, so only they see Delete on Bob's replies (the others' views get the server's canDelete false
// for replies that are not theirs). Only when CHAT_THREADS_SHOTS names a folder.
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const dir = process.env.CHAT_THREADS_SHOTS
test.skip(!dir, 'CHAT_THREADS_SHOTS is not set')
test.use({ serviceWorkers: 'block' })

const H = { [CSRF_HEADER]: '1' }
type Role = 'owner' | 'admin' | 'member' | 'guest'
type Loc = 'en' | 'ko'
const WORDS: Record<Loc, { question: string; title: string; replies: [string, string, string]; mine: string }> = {
  en: { question: 'Draft the quote for Hanbit Design. Which seal goes on it?', title: 'Quote for Hanbit Design',
    replies: ['Corporate seal, or the CEO line with his own seal?', 'Corporate seal. Legal said so last time.', "OK, I'll add the seal and send it today."], mine: 'Please check the total too.' },
  ko: { question: '한빛디자인 견적서 초안 써 줘. 도장은 뭘로 찍어야 해?', title: '한빛디자인 견적서',
    replies: ['법인 인감으로 할까요, 대표 직인으로 할까요?', '법인 인감이요. 지난번에 법무팀이 그렇게 하라고 했어요.', '네, 인감 넣어서 오늘 보낼게요.'], mine: '합계 금액도 확인해 주세요.' },
}

async function bobApi(page: Page): Promise<APIRequestContext> {
  const base = new URL(page.url()).origin
  const bob = await request.newContext({ baseURL: base })
  expect((await bob.post('/api/auth/login', { headers: H, data: { username: 'bob', password: 'bob password 1' } })).ok()).toBeTruthy()
  return bob
}

/** a shared chat of the owner's with one answer and the three replies (Bob, the owner, Bob) */
async function world(page: Page, loc: Loc, replies = true) {
  const w = WORDS[loc]
  const chat = (await (await page.request.post('/api/chats', { headers: H, data: {} })).json()) as { id: string }
  expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: w.question, clientMessageId: uuidv7() } })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  expect((await page.request.patch(`/api/chats/${chat.id}`, { headers: H, data: { title: w.title } })).ok()).toBeTruthy()
  expect((await page.request.post('/__test/people-chat', { data: { chatId: chat.id, by: 'olga', audience: 4 } })).ok()).toBeTruthy()
  const msgs = (await (await page.request.get(`/api/chats/${chat.id}/messages`)).json()) as { items: { id: string; role: string }[] }
  const answerId = msgs.items.find((m) => m.role === 'assistant')!.id
  if (replies) {
    const bob = await bobApi(page)
    const post = (api: APIRequestContext, text: string) => api.post(`/api/chats/${chat.id}/messages/${answerId}/thread`, { headers: H, data: { text, clientId: `cid-${uuidv7()}` } })
    expect((await post(bob, w.replies[0])).status()).toBe(201)
    expect((await post(page.request, w.replies[1])).status()).toBe(201)
    expect((await post(bob, w.replies[2])).status()).toBe(201)
    await bob.dispose()
  }
  return { chatId: chat.id, answerId }
}

/** the role this window plays: its /api/me says so; a guest is in the project with the team's AI. Replies that are not
 * the owner's own are not theirs to delete (the creator moderates) */
async function asRole(page: Page, role: Role) {
  if (role === 'owner') return
  await page.route(/\/api\/me$/, async (route) => {
    const r = await route.fetch()
    const me = (await r.json()) as { user?: { role: string }; guest?: unknown }
    if (me?.user) me.user.role = role
    if (role === 'guest') me.guest = { places: [{ kind: 'project', id: '019a5f00-0000-7000-8000-00000000d001', name: 'Hanbit' }], ai: { mode: 'team', credentialId: 'cred-team' } }
    await route.fulfill({ response: r, json: me })
  })
  await page.route(/\/api\/chats\/[^/]+\/messages\/[^/]+\/thread$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const r = await route.fetch()
    const page_ = (await r.json()) as { replies: { author: { id: string } | null; canDelete: boolean }[] }
    for (const x of page_.replies) x.canDelete = false
    await route.fulfill({ response: r, json: page_ })
  })
}

for (const loc of ['en', 'ko'] as const) {
  for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
    for (const role of ['owner', 'admin', 'member', 'guest'] as const) {
      test(`chat thread: ${role}, ${vp.name}, ${loc}`, async ({ page }) => {
        test.setTimeout(180_000)
        await page.setViewportSize(vp.size)
        await reset(page, { teamLocale: loc, usersFollowTeam: true })
        await asRole(page, role)
        await signIn(page)
        const { chatId, answerId } = await world(page, loc)
        await page.goto(`/c/${chatId}/t/${answerId}`)
        const panel = page.getByTestId('chat-thread')
        await expect(panel.getByTestId('chat-thread-reply')).toHaveCount(3)
        const shot = async (name: string) => {
          for (const scheme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
            await page.waitForTimeout(250)
            await page.screenshot({ path: `${dir}/${name}-${role}-${vp.name}-${loc}-${scheme}.png` })
          }
          await page.emulateMedia({ colorScheme: 'light' })
        }
        await shot('01-thread')
        if (role !== 'owner') return
        // the owner's extras: the reply's menu with Delete, the chat's box after Send to Trina, the answer's row, an
        // empty thread, and the read-only line under safe operations
        await panel.getByTestId('chat-thread-reply').first().hover()
        await panel.getByTestId('chat-thread-reply-menu').first().click()
        await expect(page.getByTestId('chat-thread-delete')).toBeVisible()
        await shot('02-reply-menu')
        await page.keyboard.press('Escape')
        await panel.getByTestId('chat-thread-send-to-ai').click()
        if (vp.name === '390') await expect(page).toHaveURL(new RegExp(`/c/${chatId}$`))
        await expect(page.getByTestId('composer-input')).toHaveValue(/^> /)
        await shot('03-sent-to-box')
        await page.goto(`/c/${chatId}`)
        const answer = page.locator(`[data-message-id="${answerId}"]`)
        await answer.hover()
        await expect(answer.getByTestId('chat-thread-line')).toBeVisible()
        await shot('04-answer-row')
        const empty = await world(page, loc, false)
        await page.goto(`/c/${empty.chatId}/t/${empty.answerId}`)
        await expect(page.getByTestId('chat-thread-count')).toBeVisible()
        await shot('05-empty')
        expect((await page.request.post('/__test/confidential', { data: { all: true } })).ok()).toBeTruthy()
        await page.goto(`/c/${chatId}/t/${answerId}`)
        await expect(page.getByTestId('chat-thread').getByTestId('shared-safe-ops')).toBeVisible()
        await shot('06-safe-ops')
        expect((await page.request.post('/__test/confidential', { data: { all: false } })).ok()).toBeTruthy()
      })
    }
  }
}
