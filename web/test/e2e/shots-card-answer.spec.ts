// Screenshots of a card's answer in a chat (components/chat/Messages.tsx CardAnswerLine): two website cards answered
// "열기" read as one quiet line under the answer that asked, not as the person's bubble. Korean, 1440 and 390, light and
// dark, the mock team only. Only when CARD_ANSWER_SHOTS names a folder to write them to.
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'

const dir = process.env.CARD_ANSWER_SHOTS
test.skip(!dir, 'CARD_ANSWER_SHOTS is not set')
test.use({ serviceWorkers: 'block' })

const ids = { answer: '019a5f00-0000-7000-8000-0000000005a1', next: '019a5f00-0000-7000-8000-0000000005a2' }

for (const width of [1440, 390] as const) {
  test(`card answer · ko · ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await reset(page, { teamLocale: 'ko', usersFollowTeam: true })
    await signIn(page)
    await page.getByTestId('composer-input').fill('HN에서 Bright Data 이야기 찾아 줘')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
    await page.route('**/api/chats/*/messages*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      const [q, a] = body.items
      const at = (s: number) => new Date(Date.parse(a.createdAt) + s * 1000).toISOString()
      const asking = { ...a, content: '두 주소를 열어 볼게요.', steps: [] }
      const answer = { ...q, id: ids.answer, parentId: a.id, content: '이 대화에 없던 주소를 열려고 해요\n열기\n\n이 대화에 없던 주소를 열려고 해요\n열기', attachments: [], createdAt: at(5), cardAnswer: { choices: ['열기', '열기'] }, branch: { index: 0, count: 1, siblingIds: [ids.answer] } }
      const step = (n: number, url: string) => ({ id: `s${n}`, kind: 'tool', tool: 'web_fetch', label: `웹 페이지 가져오기 · ${url}`, status: 'ok', startedAt: at(6), endedAt: at(7) })
      const next = { ...a, id: ids.next, parentId: ids.answer, createdAt: at(8), content: 'HN에서 Bright Data를 다룬 글을 두 개 찾았어요. 하나는 스크래핑 비용 비교, 하나는 프록시 품질 후기예요.',
        steps: [step(1, 'https://hn.algolia.com/api/v1/search?query=bright+data'), step(2, 'https://news.ycombinator.com/item?id=4100000')], branch: { index: 0, count: 1, siblingIds: [ids.next] } }
      await route.fulfill({ response, json: { ...body, items: [q, asking, answer, next] } })
    })
    await page.reload()
    await expect(page.getByTestId('card-answer')).toHaveText('2개 모두 열기 선택함')
    await expect(page.getByTestId('user-message')).toHaveCount(1)
    await page.mouse.move(2, 2)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/ko-${width}-${scheme}-card-answer.png` })
    }
  })
}
