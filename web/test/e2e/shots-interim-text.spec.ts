// Screenshots of text the AI wrote between its tool calls, at its place among the steps (lib/answerFlow.ts,
// docs/decisions/20261125-interim-text-inline.md): an English answer (the text in the answer, cut by Step.textAt) and a
// Korean one (Step.interim). 1440 and 390, light and dark, the mock team only. Only when INTERIM_SHOTS names a folder.
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'

const dir = process.env.INTERIM_SHOTS
test.skip(!dir, 'INTERIM_SHOTS is not set')
test.use({ serviceWorkers: 'block' })

const EN_A = 'Nothing relevant in the sales folder yet. Let me widen the search to the whole team drive.'
const EN_B = 'Found two price lists. The newer one is from October, so I will read that one.'
const EN = `${EN_A}\n\n${EN_B}\n\nThe October price list has **3 plans**:\n\n- Basic: ₩9,900 a month\n- Team: ₩29,000 a month\n- Business: ₩59,000 a month`
const KO_A = '영업 폴더에는 아직 관련 파일이 없어요. 팀 드라이브 전체로 넓혀서 찾아볼게요.'
const KO_B = '가격표가 두 개 있어요. 10월 것이 최신이라 그걸 읽어 볼게요.'
const KO = '10월 가격표에는 **요금제가 3개** 있어요.\n\n- 베이직: 월 9,900원\n- 팀: 월 29,000원\n- 비즈니스: 월 59,000원'

for (const lang of ['en', 'ko'] as const) for (const width of [1440, 390] as const) {
  test(`interim text · ${lang} · ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await reset(page, { teamLocale: lang, usersFollowTeam: true })
    await signIn(page)
    await page.getByTestId('composer-input').fill(lang === 'en' ? 'What does our newest price list say?' : '최신 가격표 내용 알려줘')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
    await page.route('**/api/chats/*/messages*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      const [q, a] = body.items
      const at = (s: number) => new Date(Date.parse(a.createdAt) + s * 1000).toISOString()
      const tool = (n: number, label: string, textAt: number) => ({ id: `s${n}`, kind: 'tool', tool: 'grep', label, status: 'ok', startedAt: at(n), endedAt: at(n + 1), textAt })
      const note = (n: number, text: string) => ({ id: `n${n}`, kind: 'thinking', label: lang === 'ko' ? '생각 중' : 'Thinking', status: 'ok', startedAt: at(n), endedAt: at(n), detail: text, interim: true, textAt: 0 })
      const steps = lang === 'en'
        ? [tool(1, 'Search files · "price list" in Sales', 0), tool(2, 'Search files · "가격표" in Sales', 0), tool(3, 'Search files · "price list" in Team drive', EN_A.length), tool(4, 'Read file · Price list 2026-10.xlsx', EN_A.length + 2 + EN_B.length), tool(5, 'Read file · Price list 2026-10.xlsx (sheet 2)', EN_A.length + 2 + EN_B.length)]
        : [tool(1, '파일 검색 · 영업 폴더 "가격표"', 0), tool(2, '파일 검색 · 영업 폴더 "price"', 0), note(3, KO_A), tool(4, '파일 검색 · 팀 드라이브 "가격표"', 0), note(5, KO_B), tool(6, '파일 읽기 · 가격표-2026-10.xlsx', 0), tool(7, '파일 읽기 · 가격표-2026-10.xlsx (시트 2)', 0)]
      await route.fulfill({ response, json: { ...body, items: [q, { ...a, content: lang === 'en' ? EN : KO, steps }] } })
    })
    await page.reload()
    await expect(page.getByTestId('steps')).toHaveCount(3)
    await page.mouse.move(2, 2)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/${lang}-${width}-${scheme}-interim.png` })
    }
  })
}

// the live state (the last group open, the earlier ones folded) and a failed search the AI got past in the next group
// (no red mark): English, 1440 and 390, light and dark
for (const kind of ['live', 'retried'] as const) for (const width of [1440, 390] as const) {
  test(`interim text · ${kind} · ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await page.getByTestId('composer-input').fill('What does our newest price list say?')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
    await page.route('**/api/chats/*/messages*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      const [q, a] = body.items
      const at = (s: number) => new Date(Date.parse(a.createdAt) + s * 1000).toISOString()
      const tool = (n: number, label: string, textAt: number, status = 'ok', t = 'grep') => ({ id: `s${n}`, kind: 'tool', tool: t, label, status, startedAt: at(n), endedAt: status === 'running' ? null : at(n + 1), textAt })
      const live = kind === 'live'
      const content = live ? `${EN_A}\n\n${EN_B}` : `${EN_A}\n\nThe October price list has **3 plans**: Basic, Team and Business.`
      const steps = live
        ? [tool(1, 'Search files · "price list" in Sales', 0), tool(2, 'Search files · "가격표" in Sales', 0), tool(3, 'Search files · "price list" in Team drive', EN_A.length), tool(4, 'Read file · Price list 2026-10.xlsx', EN_A.length + 2 + EN_B.length, 'running', 'read')]
        : [tool(1, 'Read file · Sales/price-list.xlsx', 0, 'error', 'read'), tool(2, 'Search files · "price list" in Team drive', EN_A.length), tool(3, 'Read file · Price list 2026-10.xlsx', EN_A.length, 'ok', 'read')]
      await route.fulfill({ response, json: { ...body, items: [q, { ...a, content, steps, status: live ? 'streaming' : 'done' }] } })
    })
    await page.reload()
    await expect(page.getByTestId('steps')).toHaveCount(kind === 'live' ? 3 : 2)
    if (kind === 'retried') await expect(page.getByTestId('steps-failed')).toHaveCount(0)
    await page.mouse.move(2, 2)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/en-${width}-${scheme}-${kind}.png` })
    }
  })
}
