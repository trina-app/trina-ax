// 회사 소개 in a real browser against the mock (docs/DECISIONS.md "W6 — Onboarding v6", "W2 — AI connection first"): the
// website reading with a one-line intro is saved without the review and 회사 소개 shows "이렇게 이해했어요: … · 고치기"
// (고치기: the review in a dialog), one quiet "소개 자료가 있으면 같이 넣기" and one primary "저장하고 계속" with the line
// under it that says what the press writes ("저장하면 웹사이트 사진과 회사 소개 파일을 팀 브랜드 폴더에 넣어요").
// 저장하고 계속 saves the profile only: the brand materials go into the team's brand folder (the owner's file, or 회사
// 소개.md written from the profile), and nothing starts: no deck, no chat, no skill. The steps go on (n/5): 내 스킬, 팀
// 파일, 도구 연결 (put off here), 팀원 초대. With nothing shared the invite names no skill (docs/DECISIONS.md "DS3"), the
// end screen offers 홈으로 only (no kept skill in the team); a member who joins lands on Home.
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const doc = (name: string, text: string) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })

/** the website reading on 회사 소개 (the mock's draft: "Acme는 조용한 책상 선풍기를 만들어요") */
async function readSite(page: Page) {
  await page.getByLabel('홈페이지 주소').fill('acme.example')
  await page.getByRole('button', { name: '읽어 오기' }).click()
  await expect(page.getByTestId('profile-step-reading')).toContainText('보통 1분 안에 끝나요.')
  await expect(page.getByTestId('profile-step-reading')).not.toContainText('채팅 목록')
  await expect(page.getByTestId('welcome-profile-line')).toHaveText('이렇게 이해했어요: Acme는 조용한 책상 선풍기를 만들어요 · 고치기', { timeout: 15_000 })
}
const brandFiles = async (page: Page) => {
  const listed = await page.request.get(`/api/files/tree?path=${encodeURIComponent('groups/Acme/브랜드')}`)
  return (await listed.json()).entries.filter((e: { type: string }) => e.type === 'file').map((e: { name: string }) => e.name)
}

test('회사 소개 saves the profile and puts the brand materials in, starting nothing; the steps go on to 도구 연결 and the invite; the invite names no skill; a member lands on Home', async ({ page, browser }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await expect(page.getByTestId('welcome-progress')).toContainText('1/5 회사 소개')
  await readSite(page)
  // saved as read (no review form); still on 회사 소개: one primary, the files link, the line under the button
  await expect(page.getByTestId('profile-step-review')).toHaveCount(0)
  await expect(page.locator('[data-step="profile"]')).toBeVisible()
  const saved = await (await page.request.get('/api/onboarding/profile')).json()
  expect(saved.profile).toMatchObject({ website: 'https://acme.example/', oneLine: 'Acme는 조용한 책상 선풍기를 만들어요', colors: ['#1b6e3a'] })
  await expect(page.getByTestId('welcome-profile-continue')).toHaveText('저장하고 계속')
  await expect(page.getByTestId('welcome-files-pick')).toHaveText('소개 자료가 있으면 같이 넣기')
  await expect(page.getByTestId('welcome-brand-line')).toHaveText('저장하면 웹사이트 사진과 회사 소개 파일을 팀 브랜드 폴더에 넣어요')
  await expect(page.locator('[data-step="profile"]')).not.toContainText('회사 소개서')
  // 고치기: the full review in a dialog; saving there changes the line
  await page.getByTestId('welcome-profile-fix').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('profile-step-review')).toBeVisible()
  await dialog.getByRole('textbox', { name: '한 줄 소개' }).fill('Acme는 작은 사무실용 선풍기를 만들어요')
  await dialog.getByRole('button', { name: '저장', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('welcome-profile-line')).toHaveText('이렇게 이해했어요: Acme는 작은 사무실용 선풍기를 만들어요 · 고치기')
  // a company intro with it, then 저장하고 계속: the owner's file is the intro (the 고치기 save above wrote 회사 소개.md,
  // which stays as it is)
  await page.getByTestId('welcome-files-input').setInputFiles([doc('회사 소개서.md', '# Acme\n- 조용한 책상 선풍기를 만들어요\n')])
  await expect(page.getByTestId('welcome-file')).toHaveAttribute('data-status', 'done')
  const chatsBefore = ((await (await page.request.get('/api/chats')).json()).items as unknown[]).length
  await page.getByTestId('welcome-profile-continue').click()
  // the steps go on at once: 2/5 내 스킬; no deck chat, no skill went in
  await expect(page.locator('[data-step="skills"]')).toBeVisible()
  await expect(page.getByTestId('welcome-progress')).toContainText('2/5 내 스킬')
  await expect(page.getByTestId('welcome-brand-failed')).toHaveCount(0)
  expect(((await (await page.request.get('/api/chats')).json()).items as unknown[]).length).toBe(chatsBefore)
  await expect(page.getByRole('navigation').getByRole('link', { name: /우리 회사 소개서/ })).toHaveCount(0)
  expect((await brandFiles(page)).sort()).toEqual(['회사 소개.md', '회사 소개서.md'])
  const progress = (await (await page.request.get('/api/onboarding/welcome')).json()).progress
  expect(progress.resultChatId).toBeNull()
  expect(progress.steps.profile).toBe('done')
  // the way back: the setup row, at 1/5, to 내 스킬
  await page.goto('/')
  await expect(page.getByTestId('setup-row-count')).toHaveText('· 1/5')
  await page.getByTestId('setup-row-link').click()
  await expect(page).toHaveURL(/\/welcome$/)
  await expect(page.locator('[data-step="skills"]')).toBeVisible()
  // ← 이전 to 회사 소개: the same line; saving again only fills in what is missing
  await page.getByTestId('welcome-back').click()
  await expect(page.getByTestId('welcome-profile-continue')).toBeVisible()
  await expect(page.getByTestId('welcome-brand-line')).toBeVisible()
  await page.getByTestId('welcome-profile-continue').click()
  await expect(page.locator('[data-step="skills"]')).toBeVisible()
  expect((await brandFiles(page)).sort()).toEqual(['회사 소개.md', '회사 소개서.md'])

  // 내 스킬 and 팀 파일 put off; 도구 연결 (4/5) put off too; nothing shared, so the invite names no skill
  await page.getByTestId('skills-later').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
  await expect(page.getByTestId('welcome-progress')).toContainText('4/5 도구 연결')
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  await expect(page.getByTestId('welcome-progress')).toContainText('5/5 팀원 초대')
  await expect(page.getByTestId('team-link-message')).toContainText('Acme에 함께하자고 초대했어요')
  await expect(page.getByTestId('team-link-message')).not.toContainText('스킬을 같이 써 보자고')
  await expect(page.getByTestId('team-link-message')).not.toContainText('회사 소개서')
  await expect(page.getByTestId('team-link-copy-message')).toHaveText('메시지 복사')
  await expect(page.getByTestId('team-link-create')).toHaveCount(0)
  const url = (await page.getByTestId('team-link-message').innerText()).trim().split(' ').at(-1)!
  expect(url).toMatch(/\/join#t=tl[0-9a-f]+$/)
  const link = (await (await page.request.get('/api/admin/team-link')).json()).link
  expect(link.skill).toBeNull()
  await page.getByTestId('invite-step-done').click()
  // 준비 끝났어요: no deck line, no kept skill in the team: 홈으로 the one button
  await expect(page.getByTestId('welcome-done')).toContainText('준비 끝났어요')
  await expect(page.getByTestId('welcome-done')).not.toContainText('회사 소개서')
  await expect(page.getByTestId('welcome-done-try')).toHaveCount(0)
  await expect(page.getByTestId('welcome-done-make')).toHaveCount(0)
  await expect(page.getByTestId('welcome-done-home')).toHaveText('홈으로')
  await expect(page.getByTestId('setup-row')).toHaveCount(0)

  // a member joins with the link and lands on Home (the link names no skill)
  const other = await browser.newContext({ locale: 'ko-KR' })
  const p2 = await other.newPage()
  const errors2 = watchConsole(p2)
  // the 404s Home gets for a new member, and no other: GET /api/demo (Home asks whether this is a demo server; every
  // other server answers 404, which helpers' realErrors ignores too, but this listener sees every response) and the
  // first-time card's listing of a folder the member cannot open, walked into to find folders below it
  // (lib/visibleFolders.ts; the mock answers it with 404, the app takes that in its stride)
  const missing: string[] = []
  p2.on('response', (r) => { if (r.status() === 404) { const u = new URL(r.url()); missing.push(`${u.pathname}${u.search}`) } })
  await p2.goto(url)
  await p2.getByTestId('invite-name').fill('민지')
  await p2.getByTestId('invite-username').fill('minji')
  await p2.getByTestId('invite-password').fill('another password 1')
  await p2.getByTestId('invite-submit').click()
  await expect(p2.getByTestId('composer-input')).toBeVisible()
  await expect(p2).toHaveURL(/\/$/)
  await expect(p2.getByTestId('skill-form')).toHaveCount(0)
  expect(missing.filter((u) => u !== '/api/demo' && !/^\/api\/files\/tree\?path=finance(&|$)/.test(u))).toEqual([])
  expect(realErrors(errors2).filter((e) => !(/status of 404/.test(e) && missing.length))).toEqual([])
  await other.close()
  expect(realErrors(errors)).toEqual([])
})

test('a phone: 회사 소개 saves; 내 스킬 waits for a computer; 도구 연결 is walked past and put off; the end screen once; Home leads back', async ({ page }) => {
  const errors = watchConsole(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await readSite(page)
  await expect(page.getByTestId('welcome-brand-line')).toBeVisible()
  await page.getByTestId('welcome-profile-continue').click()
  // without files: the server's 회사 소개.md
  await expect(page.getByTestId('skills-phone-next')).toBeVisible()
  await page.getByTestId('skills-phone-next').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  // straight to the invite: 도구 연결 is for a computer, recorded as put off; ← 이전 goes to 팀 파일
  await expect(page.getByTestId('invite-step')).toBeVisible()
  await expect(page.getByTestId('welcome-progress-phone')).toHaveText('5/5 팀원 초대')
  await page.getByTestId('welcome-back').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  await page.getByTestId('invite-step-done').click()
  await expect(page.getByTestId('welcome-done')).toContainText('준비 끝났어요')
  expect(await brandFiles(page)).toEqual(['회사 소개.md'])
  const progress = (await (await page.request.get('/api/onboarding/welcome')).json()).progress
  expect(progress.steps.tools).toBe('skipped')
  expect(progress.resultChatId).toBeNull()
  // 내 스킬 waits for a computer: not finished, the end screen was shown once
  expect(progress.finishedAt).toBeNull()
  expect(progress.doneShownAt).toBeTruthy()
  // Home on a phone: 팀 파일 was put off, so its quiet row leads back to it ("later is now", W4); 내 스킬 itself is for a
  // computer, so the phone's line about it waits until nothing else is left
  await page.getByTestId('welcome-done-home').click()
  await expect(page.getByTestId('welcome-resume')).toBeVisible()
  await expect(page.getByTestId('welcome-resume-text')).not.toContainText('도구 연결')
  await expect(page.getByTestId('welcome-skills-computer')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})
