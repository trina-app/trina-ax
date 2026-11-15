// A guest's Team AI limit in tokens (docs/DECISIONS.md "Guest Team AI: a token limit"; components/GuestInvite.tsx
// TokenLimit): the invite and Admin › Change AI offer a few presets and Other, with "about N answers" from the team's
// own tokens per answer (or the default, said as an estimate); Admin's row says the limit and what is left, or that it
// is used up; a guest given Team AI before tokens keeps "up to $20 a month" until an admin picks tokens; the guest at
// the limit reads the amount and the reset date. SHOTS=<dir> also saves each screen at 1440 and 390, light and dark,
// in ko and en.
import { expect, test, type Page } from '@playwright/test'
import { uuidv7, type GuestAiChoice } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

test.use({ timezoneId: 'Asia/Seoul', viewport: { width: 1440, height: 900 } })

const ROOM = uuidv7()
const base = { canRename: true, managerId: 'olga', unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const at = new Date(Date.now() - 3600_000).toISOString()
const ROOMS = [{ ...base, id: ROOM, kind: 'group', name: 'Quote prep', groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: at, activityAt: at }]
const SHOTS = process.env.SHOTS

async function shoot(page: Page, name: string, open: () => Promise<void>) {
  if (!SHOTS) return
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: w, height: h })
      await page.emulateMedia({ colorScheme: scheme })
      await open()
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${SHOTS}/${name}-${w}-${scheme}.png` })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await open()
}

async function start(page: Page, locale: 'ko' | 'en') {
  await reset(page, { teamLocale: locale, usersFollowTeam: true })
  expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
  const cred = await page.request.post('/__test/team-credential', { data: { label: 'Team Claude' } })
  return ((await cred.json()) as { id: string }).id
}
const guest = (page: Page, data: Record<string, unknown>) => page.request.post('/__test/guest', { data: { place: { kind: 'room', id: ROOM }, ...data } }).then((r) => expect(r.ok()).toBeTruthy())
async function signInGuest(page: Page, id: string) {
  await page.goto('/login')
  await page.getByTestId('login-username').fill(id)
  await page.getByTestId('login-password').fill(`${id} password 1`)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-submit')).toHaveCount(0)
}
const menu = (page: Page, username: string) => page.getByTestId(`guest-row-${username}`).getByTestId('member-more')

const W = {
  ko: {
    est5m: '500만 토큰 · 약 62번 답변', est1mTeam: '100만 토큰 · 약 20번 답변', est25: '250만 토큰 · 약 50번 답변',
    hintDefault: '보통 답변으로 어림한 수예요. 이 팀은 아직 답변이 적어요. 토큰은 AI가 읽고 쓰는 양이에요. 매달 1일에 다시 채워져요.',
    hintTeam: '이 팀의 최근 답변으로 어림한 수예요.',
    rowUsd: '한 달 최대 US$20.00', nowUsd: '지금은 한 달 US$20.00까지예요. 바꾸려면 토큰 양을 골라 주세요.',
    rowTokens: '한 달 최대 100만 토큰 · 70만 남음', rowUsedUp: 'AI 한도를 다 썼어요 · 팀 AI · 한 달 최대 500만 토큰',
    limit: '이번 달 AI 한도(500만 토큰)를 다 썼어요. 12월 1일에 다시 채워져요. 더 필요하면 초대한 분께 물어봐 주세요.',
  },
  en: {
    est5m: '5M tokens · about 62 answers', est1mTeam: '1M tokens · about 20 answers', est25: '2.5M tokens · about 50 answers',
    hintDefault: 'An estimate from a typical answer. This team has few answers so far. Tokens are how much the AI reads and writes. Starts over on the 1st of every month.',
    hintTeam: "An estimate from this team's recent answers.",
    rowUsd: 'up to $20.00 a month', nowUsd: 'Now up to $20.00 a month. Pick an amount in tokens to change it.',
    rowTokens: 'up to 1M tokens a month · 700K left', rowUsedUp: 'AI limit used up · Team AI · up to 5M tokens a month',
    limit: "You've used this month's AI limit (5M tokens). It resets on Dec 1. Ask the person who invited you if you need more.",
  },
}

for (const locale of ['ko', 'en'] as const) {
  const w = W[locale]
  test.describe(locale, () => {
    test('invite: presets, about N answers from the default and then from the team, Other, and the link sends tokens', async ({ page }) => {
      const credentialId = await start(page, locale)
      await signIn(page)
      const open = async () => {
        await page.goto(`/rooms/${ROOM}`)
        await page.getByTestId('room-members-button').click()
        await page.getByTestId('room-invite').click()
        await page.getByTestId('invite-guest-row').click()
        await page.getByTestId('guest-ai-team').check()
        await expect(page.getByTestId('guest-ai-estimate')).toBeVisible()
      }
      await open()
      // Team AI starts at 5M tokens; no answers yet, so the default per answer, said as an estimate
      await expect(page.getByTestId('guest-ai-limit')).toHaveValue('5000000')
      await expect(page.getByTestId('guest-ai-estimate')).toHaveText(w.est5m)
      await expect(page.getByTestId('guest-ai-limit-hint')).toHaveText(w.hintDefault)
      await shoot(page, `guest-ai-tokens/invite-${locale}`, open)
      // the team's own answers: 50,000 tokens each
      expect((await page.request.post('/__test/answer-tokens', { data: { tokens: 50_000, from: 'team' } })).ok()).toBeTruthy()
      await open()
      await page.getByTestId('guest-ai-limit').selectOption('1000000')
      await expect(page.getByTestId('guest-ai-estimate')).toHaveText(w.est1mTeam)
      await expect(page.getByTestId('guest-ai-limit-hint')).toContainText(w.hintTeam)
      // Other: a number of tokens, with the same words next to it
      await page.getByTestId('guest-ai-limit').selectOption('other')
      await expect(page.getByTestId('guest-ai-limit-other')).toHaveValue('1000000')
      await page.getByTestId('guest-ai-limit-other').fill('')
      await expect(page.getByTestId('guest-ai-estimate')).toHaveCount(0)
      await expect(page.getByTestId('guest-invite-create')).toBeDisabled()
      await page.getByTestId('guest-ai-limit-other').fill('2500000')
      await expect(page.getByTestId('guest-ai-estimate')).toHaveText(w.est25)
      await shoot(page, `guest-ai-tokens/invite-other-${locale}`, async () => {
        await open()
        await page.getByTestId('guest-ai-limit').selectOption('other')
        await page.getByTestId('guest-ai-limit-other').fill('2500000')
      })
      const created = page.waitForRequest((r) => r.url().endsWith('/api/guest-invites') && r.method() === 'POST')
      await page.getByTestId('guest-invite-create').click()
      expect((await created).postDataJSON()).toMatchObject({ ai: { mode: 'team', credentialId, limitTokens: 2_500_000 } })
    })

    test("Admin: a token limit with what is left, used up, and an older guest's dollar limit until Change AI picks tokens", async ({ page }) => {
      const credentialId = await start(page, locale)
      const tokens = (n: number): GuestAiChoice => ({ mode: 'team', credentialId, limitTokens: n })
      await guest(page, { id: 'tia', name: 'Tia', ai: tokens(1_000_000), usedTokens: 300_000 })
      await guest(page, { id: 'uma', name: 'Uma', ai: tokens(5_000_000), usedTokens: 5_000_000, aiUsedUp: true })
      await guest(page, { id: 'olda', name: 'Olda', ai: { mode: 'team', credentialId, limitUsd: 20 } })
      await signIn(page)
      const open = async () => { await page.goto('/admin/members'); await page.getByTestId('guests-section').scrollIntoViewIfNeeded() }
      await open()
      await expect(page.getByTestId('guest-row-tia')).toContainText(w.rowTokens)
      await expect(page.getByTestId('guest-row-uma')).toContainText(w.rowUsedUp)
      await expect(page.getByTestId('guest-row-olda')).toContainText(w.rowUsd)
      await shoot(page, `guest-ai-tokens/admin-guests-${locale}`, open)
      // Change AI on the older guest: the dollar limit is said, nothing is picked, and Save waits for a token amount
      const dialog = async () => {
        await open()
        await menu(page, 'olda').click()
        await page.getByTestId('guest-ai-olda').click()
        await expect(page.getByTestId('guest-ai-dialog')).toBeVisible()
      }
      await dialog()
      await expect(page.getByTestId('guest-ai-limit-usd')).toHaveText(w.nowUsd)
      await expect(page.getByTestId('guest-ai-limit')).toHaveValue('')
      await expect(page.getByTestId('guest-ai-save')).toBeDisabled()
      await shoot(page, `guest-ai-tokens/change-ai-usd-${locale}`, dialog)
      await page.getByTestId('guest-ai-limit').selectOption('1000000')
      await expect(page.getByTestId('guest-ai-limit-usd')).toHaveCount(0)
      const sent = page.waitForRequest((r) => r.url().includes('/guest-ai') && r.method() === 'PATCH')
      await page.getByTestId('guest-ai-save').click()
      expect((await sent).postDataJSON()).toEqual({ mode: 'team', credentialId, limitTokens: 1_000_000 })
      await expect(page.getByTestId('guest-row-olda')).toContainText(locale === 'ko' ? '한 달 최대 100만 토큰' : 'up to 1M tokens a month')
    })

    test('the guest at the limit reads the amount and the reset date', async ({ page }) => {
      const credentialId = await start(page, locale)
      await guest(page, { id: 'tina', name: 'Tina', ai: { mode: 'team', credentialId, limitTokens: 5_000_000 } })
      await signInGuest(page, 'tina')
      await page.goto('/')
      await page.getByTestId('composer-input').fill('error:budget\nhello')
      await page.getByTestId('composer-input').press('Enter')
      const line = page.getByText(w.limit)
      await expect(line).toBeVisible()
      const url = page.url()
      await shoot(page, `guest-ai-tokens/guest-limit-${locale}`, async () => { await page.goto(url); await expect(line).toBeVisible() })
    })
  })
}

test("a guest given Team AI in dollars still reads the limit's words without an amount", async ({ page }) => {
  await start(page, 'en')
  await guest(page, { id: 'tina', name: 'Tina', ai: { mode: 'team', credentialId: 'c1', limitUsd: 20 } })
  await signInGuest(page, 'tina')
  await page.goto('/')
  await page.getByTestId('composer-input').fill('error:budget\nhello')
  await page.getByTestId('composer-input').press('Enter')
  await expect(page.getByText("You've used this month's AI limit. It resets on Dec 1. Ask the person who invited you if you need more.")).toBeVisible()
})
