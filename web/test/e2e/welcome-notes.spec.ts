// 회사 소개 and the intro deck in a real browser against the mock (docs/DECISIONS.md "D2 — The first result is the
// company's intro deck", "W2 — AI connection first", "W5 — Onboarding v5"): the website reading with a one-line intro is
// saved without the review and 회사 소개 shows "이렇게 이해했어요: … · 고치기" (고치기: the review in a dialog), one quiet
// "소개 자료가 있으면 같이 넣기" and one primary "저장하고 계속" with the line under it (the deck starts now, about how
// long, where it will be). 저장하고 계속 starts the deck once per team: the file goes into the team's brand folder, the
// server makes the deck's chat ("우리 회사 소개서", an ordinary chat in the sidebar) and "/intro-deck …" runs there,
// while the steps go on at once with nothing about the deck on them. The owner can open the deck's chat mid-setup and
// come back through the setup row; ← 이전 to 회사 소개 and saving again starts no second deck. The invite names 할 일
// 정리 (never the deck), the deck's chat has no invite bar, the end screen says where the deck is; a member who joins
// lands on 할 일 정리's form.
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'
import { translate } from '../../src/i18n'
import { historyName } from '../../src/lib/welcome'

/** the sidebar's name for the AI's history ("트리나 기록"), as the steps say it */
const history = historyName((k, p) => translate('ko', k, p))
const doc = (name: string, text: string) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })

/** the website reading on 회사 소개 (the mock's draft: "Acme는 조용한 책상 선풍기를 만들어요") */
async function readSite(page: Page) {
  await page.getByLabel('홈페이지 주소').fill('acme.example')
  await page.getByRole('button', { name: '읽어 오기' }).click()
  await expect(page.getByTestId('profile-step-reading')).toContainText('보통 1분 안에 끝나요.')
  await expect(page.getByTestId('profile-step-reading')).not.toContainText('채팅 목록')
  await expect(page.getByTestId('welcome-profile-line')).toHaveText('이렇게 이해했어요: Acme는 조용한 책상 선풍기를 만들어요 · 고치기', { timeout: 15_000 })
}

test('회사 소개 starts the deck once; the steps go on; the deck chat mid-setup and the setup row back; the invite names 할 일 정리; a member lands on its form', async ({ page, browser }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await expect(page.getByTestId('welcome-pack-line')).toHaveCount(0)
  await readSite(page)
  // saved as read (no review form); still on 회사 소개: one primary, the files link, the line under the button
  await expect(page.getByTestId('profile-step-review')).toHaveCount(0)
  await expect(page.locator('[data-step="profile"]')).toBeVisible()
  const saved = await (await page.request.get('/api/onboarding/profile')).json()
  expect(saved.profile).toMatchObject({ website: 'https://acme.example/', oneLine: 'Acme는 조용한 책상 선풍기를 만들어요', colors: ['#1b6e3a'] })
  await expect(page.getByTestId('welcome-profile-continue')).toHaveText('저장하고 계속')
  await expect(page.getByTestId('welcome-files-pick')).toHaveText('소개 자료가 있으면 같이 넣기')
  await expect(page.getByTestId('welcome-deck-line')).toHaveText(`저장하면 회사 소개서를 만들기 시작해요 · 5분쯤 · ${history}의 '우리 회사 소개서'`)
  // 고치기: the full review in a dialog; saving there changes the line
  await page.getByTestId('welcome-profile-fix').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('profile-step-review')).toBeVisible()
  await dialog.getByRole('textbox', { name: '한 줄 소개' }).fill('Acme는 작은 사무실용 선풍기를 만들어요')
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('welcome-profile-line')).toHaveText('이렇게 이해했어요: Acme는 작은 사무실용 선풍기를 만들어요 · 고치기')
  // a company intro with it, then 저장하고 계속
  await page.getByTestId('welcome-files-input').setInputFiles([doc('회사 소개서.md', '# Acme\n- 조용한 책상 선풍기를 만들어요\n')])
  await expect(page.getByTestId('welcome-file')).toHaveAttribute('data-status', 'done')
  await page.getByTestId('welcome-profile-continue').click()
  // the steps go on at once: 2/4 내 스킬, nothing about the deck on it; its chat is a row in the sidebar
  await expect(page.locator('[data-step="skills"]')).toBeVisible()
  await expect(page.getByTestId('welcome-progress')).toContainText('2/4 내 스킬')
  await expect(page.getByTestId('welcome-deck-status')).toHaveCount(0)
  await expect(page.locator('[data-step="skills"]')).not.toContainText('회사 소개서')
  const deckRow = page.getByRole('navigation').getByRole('link', { name: /우리 회사 소개서/ })
  await expect(deckRow).toBeVisible()
  const listed = await page.request.get(`/api/files/tree?path=${encodeURIComponent('groups/Acme/브랜드')}`)
  expect((await listed.json()).entries.filter((e: { type: string }) => e.type === 'file').map((e: { name: string }) => e.name)).toEqual(['회사 소개서.md'])
  const progress = (await (await page.request.get('/api/onboarding/welcome')).json()).progress
  expect(progress.resultChatId).toBeTruthy()
  expect(progress.steps.profile).toBe('done')

  // the deck's chat mid-setup: an ordinary page; its question is the skill and the file; no invite bar under it
  await deckRow.click()
  await expect(page).toHaveURL(new RegExp(`/c/${progress.resultChatId}$`))
  const question = page.getByTestId('user-message').first()
  await expect(question.getByTestId('skill-chip')).toHaveText('회사 소개서')
  await expect(question).toContainText('우리 회사 소개서 만들어 줘')
  await expect(question).not.toContainText('/intro-deck')
  await expect(question).toContainText('회사 소개서.md')
  await expect(page.getByTestId('artifact-card')).toContainText('Acme 회사 소개서', { timeout: 20_000 })
  await expect(page.getByTestId('welcome-invite-bar')).toHaveCount(0)
  await expect(page.getByTestId('welcome-invite-open')).toHaveCount(0)
  // the way back: the setup row, at 1/4, to 내 스킬
  await expect(page.getByTestId('setup-row-count')).toHaveText('· 1/4')
  await page.getByTestId('setup-row-link').click()
  await expect(page).toHaveURL(/\/welcome$/)
  await expect(page.locator('[data-step="skills"]')).toBeVisible()
  // ← 이전 to 회사 소개: the deck line and the files link are gone; saving again starts no second deck
  await page.getByTestId('welcome-back').click()
  await expect(page.getByTestId('welcome-profile-continue')).toBeVisible()
  await expect(page.getByTestId('welcome-deck-line')).toHaveCount(0)
  await expect(page.getByTestId('welcome-files-pick')).toHaveCount(0)
  await page.getByTestId('welcome-profile-continue').click()
  await expect(page.locator('[data-step="skills"]')).toBeVisible()
  const chats = (await (await page.request.get('/api/chats')).json()).items as { title: string }[]
  expect(chats.filter((c) => c.title === '우리 회사 소개서')).toHaveLength(1)

  // 내 스킬 and 팀 파일 put off; the invite names 할 일 정리, never the deck
  await page.getByTestId('skills-later').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  await expect(page.getByTestId('team-link-message')).toContainText("'할 일 정리' 스킬을 같이 써 보자고 해요")
  await expect(page.getByTestId('team-link-message')).not.toContainText('회사 소개서')
  await expect(page.getByTestId('team-link-copy-message')).toHaveText('메시지 복사')
  await expect(page.getByTestId('team-link-create')).toHaveCount(0)
  const url = (await page.getByTestId('team-link-message').innerText()).trim().split(' ').at(-1)!
  expect(url).toMatch(/\/join#t=tl[0-9a-f]+$/)
  const link = (await (await page.request.get('/api/admin/team-link')).json()).link
  expect(link.skill.path).toBe('skills/general/meeting-tasks/SKILL.md')
  await page.getByTestId('invite-step-done').click()
  // 준비 끝났어요: where the deck is (no button), the owner's own run first
  await expect(page.getByTestId('welcome-done')).toContainText('준비 끝났어요')
  await expect(page.getByTestId('welcome-done')).toContainText(`회사 소개서는 ${history}의 '우리 회사 소개서'에 있어요`)
  await expect(page.getByTestId('welcome-done-try')).toHaveText("'할 일 정리' 먼저 써 보기")
  await expect(page.getByTestId('setup-row')).toHaveCount(0)

  // a member joins with the link and lands on 할 일 정리's form
  const other = await browser.newContext({ locale: 'ko-KR' })
  const p2 = await other.newPage()
  const errors2 = watchConsole(p2)
  await p2.goto(url)
  await p2.getByTestId('invite-name').fill('민지')
  await p2.getByTestId('invite-username').fill('minji')
  await p2.getByTestId('invite-password').fill('another password 1')
  await p2.getByTestId('invite-submit').click()
  await expect(p2).toHaveURL(/\/skills\?run=skills%2Fgeneral%2Fmeeting-tasks%2FSKILL\.md$/)
  await expect(p2.getByTestId('skill-form')).toBeVisible()
  await p2.getByTestId('skill-form-run').click()
  await expect(p2).toHaveURL(/\/c\/[0-9a-f-]+$/)
  await expect(p2.getByTestId('user-message').first().getByTestId('skill-chip')).toHaveText('할 일 정리')
  expect(realErrors(errors2)).toEqual([])
  await other.close()
  // saving 회사 소개 again asks the server, which answers 409 deck_started (the one deck stands): the browser logs that
  expect(realErrors(errors).filter((e) => !/status of 409/.test(e))).toEqual([])
  expect(realErrors(errors).filter((e) => /status of 409/.test(e))).toHaveLength(1)
})

test('a phone: the deck line names the ☰ menu; 내 스킬 waits for a computer; the end screen once; the deck\'s chat opens as a sheet', async ({ page }) => {
  const errors = watchConsole(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await readSite(page)
  await expect(page.getByTestId('welcome-deck-line')).toHaveText(`저장하면 회사 소개서를 만들기 시작해요 · 5분쯤 · ☰ 메뉴의 ${history} › '우리 회사 소개서'`)
  await page.getByTestId('welcome-profile-continue').click()
  // without files: the server's 회사 소개.md
  await expect(page.getByTestId('skills-phone-next')).toBeVisible()
  await page.getByTestId('skills-phone-next').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  await page.getByTestId('invite-step-done').click()
  await expect(page.getByTestId('welcome-done')).toContainText(`회사 소개서는 ☰ 메뉴의 ${history} › '우리 회사 소개서'에 있어요`)
  const listed = await page.request.get(`/api/files/tree?path=${encodeURIComponent('groups/Acme/브랜드')}`)
  expect((await listed.json()).entries.filter((e: { type: string }) => e.type === 'file').map((e: { name: string }) => e.name)).toEqual(['회사 소개.md'])
  const progress = (await (await page.request.get('/api/onboarding/welcome')).json()).progress
  // 내 스킬 waits for a computer: not finished, the end screen was shown once
  expect(progress.finishedAt).toBeNull()
  expect(progress.doneShownAt).toBeTruthy()
  // Home on a phone: 팀 파일 was put off, so its quiet row leads back to it ("later is now", W4); 내 스킬 itself is for a
  // computer, so the phone's line about it waits until nothing else is left (this assertion failed on e0c3cdf6 too:
  // it expected no row)
  await page.getByTestId('welcome-done-home').click()
  await expect(page.getByTestId('welcome-resume')).toBeVisible()
  await expect(page.getByTestId('welcome-skills-computer')).toHaveCount(0)
  // the deck's chat: the full-screen sheet over the chat once opened, its ✕ in reach
  await page.goto(`/c/${progress.resultChatId}`)
  const card = page.getByTestId('artifact-card')
  await expect(card).toContainText('Acme 회사 소개서', { timeout: 20_000 })
  const panel = page.getByTestId('artifact-panel')
  // the deck opens beside its chat by itself (its artifact key): only a panel that did not open is opened by hand
  await panel.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => card.click())
  await expect(panel.getByRole('heading', { name: 'Acme 회사 소개서' })).toBeVisible()
  expect(await panel.evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.right), Math.round(r.top), Math.round(r.height)] })).toEqual([390, 0, 844])
  await expect(panel.getByRole('button', { name: '닫기' })).toBeInViewport()
  await panel.getByRole('button', { name: '닫기' }).click()
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId('welcome-invite-bar')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})
