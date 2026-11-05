// The welcome steps' first result in a real browser against the mock (docs/DECISIONS.md "N — The first result is the
// company's card news", "S — The lead's way becomes a team skill"): the owner drops a company intro on the first result;
// it goes into the team's brand folder, the server starts the result and "/card-news …" runs on it in that chat; under
// the answer one bar asks "마음에 드시나요? 팀 스킬로 저장하면 …", the card shows the team skill made from it (title, the
// choice, the file), sharing it leads to the invite with that skill; someone joins with the link and lands on its form
// with who made it, runs it, and gets their own chat. Without files, the server's 회사 소개.md is attached instead.
import { expect, test } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const doc = (name: string, text: string) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })

test('a company intro in, the card news out; the lead\'s way becomes a team skill; a member lands on its form', async ({ page, browser }) => {
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

  // under the answer: one bar, one button: the lead's way becomes a team skill
  await expect(page.getByTestId('welcome-invite-text')).toHaveText('마음에 드시나요? 팀 스킬로 저장하면 다른 분들도 같은 방식으로 만들 수 있어요')
  await expect(page.getByTestId('skill-share-open')).toHaveText('팀 스킬로 저장')
  await page.getByTestId('skill-share-open').click()
  await expect(page.getByTestId('skill-share')).toHaveAttribute('data-state', 'ready')
  await expect(page.getByTestId('skill-share-title')).toHaveText('홍보 카드뉴스')
  await expect(page.getByTestId('skill-share-choice')).toContainText('인스타그램')
  await expect(page.getByTestId('skill-share-files')).toHaveText('쓰는 자료:회사 소개서.md')
  await expect(page.getByTestId('skill-share-note')).toHaveText('팀 전체 AI가 이 방식을 따라요 · 팀 스킬에서 언제든 고칠 수 있어요')
  await expect(page.getByTestId('skill-share')).not.toContainText('juganhoeui')
  await page.getByTestId('skill-share-share').click()
  await page.getByTestId('team-link-create').click()
  await expect(page.getByTestId('team-link-message')).toContainText("우리 팀 '홍보 카드뉴스' 스킬을 만들어 뒀어요. 링크 열면 같은 방식으로 바로 써요.")
  const url = (await page.getByTestId('team-link-message').innerText()).trim().split('\n').at(-1)!
  expect(url).toMatch(/\/join#t=tl[0-9a-f]+$/)

  const other = await browser.newContext({ locale: 'ko-KR' })
  const p2 = await other.newPage()
  const errors2 = watchConsole(p2)
  await p2.goto(url)
  await p2.getByTestId('invite-name').fill('민지')
  await p2.getByTestId('invite-username').fill('minji')
  await p2.getByTestId('invite-password').fill('another password 1')
  await p2.getByTestId('invite-submit').click()
  // the skill's form, with who made it and who sees the chat; its one choice starts on 인스타그램
  await expect(p2).toHaveURL(/\/skills\?run=/)
  await expect(p2.getByTestId('skill-form-by')).toHaveText('Olga님이 만든 팀 스킬이에요 · 이 채팅은 민지님만 봐요')
  await expect(p2.getByTestId('skill-choice-channel-instagram')).toHaveAttribute('data-on', 'true')
  await p2.getByTestId('skill-form-run').click()
  await expect(p2).toHaveURL(/\/c\/[0-9a-f-]+$/)
  await expect(p2.getByTestId('user-message').first().getByTestId('skill-chip')).toHaveText('홍보 카드뉴스')
  await expect(p2.getByTestId('user-message').first()).toContainText('어디에 올릴까요: 인스타그램')
  expect(realErrors(errors2)).toEqual([])
  await other.close()
  expect(realErrors(errors)).toEqual([])
})

test('"자료 없이 만들게요": the card news from the server\'s 회사 소개.md, nothing uploaded', async ({ page }) => {
  const errors = watchConsole(page)
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
  await expect(page.getByTestId('welcome-invite-text')).toHaveText('마음에 드시나요? 팀 스킬로 저장하면 다른 분들도 같은 방식으로 만들 수 있어요')
  expect(realErrors(errors)).toEqual([])
})
