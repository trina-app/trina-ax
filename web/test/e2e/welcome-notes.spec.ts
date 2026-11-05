// The welcome steps' first result in a real browser against the mock (docs/DECISIONS.md "N — The first result is the
// company's card news", "W2 — AI connection first"): the owner drops a company intro on the first result; it goes into
// the team's brand folder, the server starts the result and "/card-news …" runs on it in that chat; under the answer one
// bar asks "마음에 드시나요? 팀원도 같은 방식으로 바로 만들 수 있어요" [팀에 공유], which opens the invite with that same
// skill (no draft, no copy: the goal counts one path) and the message ready to copy at once (the link made in advance);
// someone joins with the link, lands on the card news form, runs it and gets their own chat. Without files, the
// server's 회사 소개.md is attached instead.
import { expect, test } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const doc = (name: string, text: string) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })

test('a company intro in, the card news out; [팀에 공유] invites with that skill, the message at once; a member lands on its form', async ({ page, browser }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await expect(page.getByTestId('welcome-pack-line')).toHaveText('팀 스킬을 넣어 둘게요 · 마케팅팀이에요')
  // the profile put off: the team's start goes in, then the first result asks for a company or team intro
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await expect(page.getByRole('heading', { name: '회사 소개서나 팀 소개 자료가 있으면 놓아 주세요' })).toBeVisible()
  await expect(page.getByText('없으면 홈페이지에서 찾은 내용으로 만들게요')).toBeVisible()
  await expect(page.getByTestId('welcome-files-none')).toHaveText('자료 없이 만들게요')
  // who sees it, with the real number (the group's members and the owners and admins)
  await expect(page.getByTestId('welcome-files-who')).toHaveText(/^여기 올린 파일은 Acme \d+명만 봐요 · 채팅은 각자만 봐요$/)
  await page.getByTestId('welcome-files-input').setInputFiles([doc('회사 소개서.md', '# Acme\n- 조용한 책상 선풍기를 만들어요\n')])
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
  const question = page.getByTestId('user-message').first()
  // the skill by its title, then the question (the command runs underneath)
  await expect(question.getByTestId('skill-chip')).toHaveText('카드뉴스')
  await expect(question).toContainText('우리 회사 홍보 카드뉴스 5장 만들어 줘')
  await expect(question).not.toContainText('/card-news')
  await expect(question).toContainText('회사 소개서.md')
  // the file is in the team's brand folder
  const listed = await page.request.get(`/api/files/tree?path=${encodeURIComponent('groups/Acme/브랜드')}`)
  expect((await listed.json()).entries.filter((e: { type: string }) => e.type === 'file').map((e: { name: string }) => e.name)).toEqual(['회사 소개서.md'])

  // the cards open by themselves beside the chat (the team server sends them saved, no "writing" first); ✕ closes them
  const panel = page.getByTestId('artifact-panel')
  await expect(panel.getByRole('heading', { name: 'Acme 카드뉴스' })).toBeVisible()
  await panel.getByRole('button', { name: '닫기' }).click()
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId('artifact-card')).toContainText('Acme 카드뉴스')
  // under the answer: one bar, one button: share the skill that made it, as it is
  const drafts: string[] = []
  page.on('request', (r) => { if (r.url().includes('/api/onboarding/skill-draft')) drafts.push(r.url()) })
  await expect(page.getByTestId('welcome-invite-text')).toHaveText('마음에 드시나요? 팀원도 같은 방식으로 바로 만들 수 있어요')
  await expect(page.getByTestId('welcome-invite-open')).toHaveText('팀에 공유')
  await page.getByTestId('welcome-invite-open').click()
  // the message and its one copy button at once (no "초대 링크 만들기" to press); the link's details folded
  await expect(page.getByTestId('team-link-message')).toContainText("'카드뉴스' 스킬을 같이 써 보자고 해요")
  await expect(page.getByTestId('team-link-copy-message')).toHaveText('메시지 복사')
  await expect(page.getByTestId('team-link-create')).toHaveCount(0)
  await expect(page.getByTestId('team-link-manage')).toHaveAttribute('aria-expanded', 'false')
  const url = (await page.getByTestId('team-link-message').innerText()).trim().split(' ').at(-1)!
  expect(url).toMatch(/\/join#t=tl[0-9a-f]+$/)
  // the link names the pack's card news itself, and the team's group
  const link = (await (await page.request.get('/api/admin/team-link')).json()).link
  expect(link.skill.path).toBe('skills/general/card-news/SKILL.md')
  expect(link.groupIds).toHaveLength(1)
  expect(drafts).toEqual([])

  const other = await browser.newContext({ locale: 'ko-KR' })
  const p2 = await other.newPage()
  const errors2 = watchConsole(p2)
  await p2.goto(url)
  await p2.getByTestId('invite-name').fill('민지')
  await p2.getByTestId('invite-username').fill('minji')
  await p2.getByTestId('invite-password').fill('another password 1')
  await p2.getByTestId('invite-submit').click()
  // the card news form itself (a pack's skill names no maker); its one choice starts on 인스타그램
  await expect(p2).toHaveURL(/\/skills\?run=skills%2Fgeneral%2Fcard-news%2FSKILL\.md$/)
  await expect(p2.getByTestId('skill-form-by')).toHaveCount(0)
  await expect(p2.getByTestId('skill-choice-channel-instagram')).toHaveAttribute('data-on', 'true')
  await p2.getByTestId('skill-form-run').click()
  await expect(p2).toHaveURL(/\/c\/[0-9a-f-]+$/)
  await expect(p2.getByTestId('user-message').first().getByTestId('skill-chip')).toHaveText('카드뉴스')
  await expect(p2.getByTestId('user-message').first()).toContainText('어디에 올릴까요: 인스타그램')
  expect(realErrors(errors2)).toEqual([])
  await other.close()
  expect(realErrors(errors)).toEqual([])
})

test('"자료 없이 만들게요" on a phone: the card news from the server\'s 회사 소개.md, nothing uploaded; the cards open as a sheet that closes', async ({ page }) => {
  const errors = watchConsole(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await page.getByTestId('welcome-files-none').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
  const question = page.getByTestId('user-message').first()
  await expect(question.getByTestId('skill-chip')).toHaveText('카드뉴스')
  await expect(question).toContainText('우리 회사 홍보 카드뉴스 5장 만들어 줘')
  await expect(question).toContainText('회사 소개.md')
  const listed = await page.request.get(`/api/files/tree?path=${encodeURIComponent('groups/Acme/브랜드')}`)
  expect((await listed.json()).entries.filter((e: { type: string }) => e.type === 'file').map((e: { name: string }) => e.name)).toEqual(['회사 소개.md'])
  // the full-screen sheet over the chat, its ✕ in reach; closed, the chat and the bar under the answer are back
  const panel = page.getByTestId('artifact-panel')
  await expect(panel.getByRole('heading', { name: 'Acme 카드뉴스' })).toBeVisible()
  // the whole screen, but for the sheet's 1 px left border
  expect(await panel.evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.right), Math.round(r.top), Math.round(r.height)] })).toEqual([390, 0, 844])
  await expect(panel.getByRole('button', { name: '닫기' })).toBeInViewport()
  await panel.getByRole('button', { name: '닫기' }).click()
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId('welcome-invite-text')).toHaveText('마음에 드시나요? 팀원도 같은 방식으로 바로 만들 수 있어요')
  expect(realErrors(errors)).toEqual([])
})
