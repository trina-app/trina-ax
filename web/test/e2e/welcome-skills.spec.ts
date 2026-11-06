// 내 스킬 가져오기 in a real browser against the mock (docs/DECISIONS.md "SK", "W5"): 회사 소개 put off (no deck), then
// [내 스킬 찾기] opens the folder window (Chrome's showDirectoryPicker, stubbed here with an in-memory .claude folder that
// logs every name opened: Playwright cannot drive the OS folder window), the list comes back checked and judged, [팀에
// 공유 · N개] shares the ticked ones (the server marks 내 스킬 done; a merge waits for the end of the setup); 팀 파일 is
// put off; the invite names ONE skill, the first shared, and its link opens it; then 준비 끝났어요 with the owner's own
// run of that skill.
import { expect, test } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

/** A .claude folder: skills, a plugin, a command, CLAUDE.md, and what must never be opened. */
const TREE = {
  'CLAUDE.md': '# 일하는 방식\n- 답은 해요체로 짧게 써요.\n',
  '.credentials.json': '{"never":"read"}',
  'history.jsonl': 'never read',
  projects: { 'x': { 'a.jsonl': 'never read' } },
  skills: {
    'weekly-report': { 'SKILL.md': '---\nname: weekly-report\ndescription: 주간 업무 보고를 써요\n---\n이번 주 한 일을 정리해요.\n' },
    'quote-draft': { 'SKILL.md': '---\nname: quote-draft\ndescription: 견적서 초안\n---\ntemplates/quote.md 양식으로 써요.\n', templates: { 'quote.md': '# 견적서\n' } },
  },
  commands: { 'standup.md': '어제, 오늘, 막힌 일을 한 줄씩.\n' },
}

test('[내 스킬 찾기] → the list → [팀에 공유]; 팀 파일 put off; the invite names one shared skill and opens it; 준비 끝났어요 → its form', async ({ page }) => {
  const errors = watchConsole(page)
  await page.addInitScript((tree) => {
    const opened: string[] = []
    ;(window as unknown as { __opened: string[] }).__opened = opened
    type Node = string | { [name: string]: Node }
    const dir = (name: string, t: { [name: string]: Node }, at: string): unknown => ({
      kind: 'directory', name,
      async getDirectoryHandle(n: string) { const c = t[n]; opened.push(`${at}${n}/`); if (!c || typeof c === 'string') throw new DOMException('NotFound', 'NotFoundError'); return dir(n, c, `${at}${n}/`) },
      async getFileHandle(n: string) { const c = t[n]; opened.push(`${at}${n}`); if (typeof c !== 'string') throw new DOMException('NotFound', 'NotFoundError'); return { kind: 'file', name: n, getFile: async () => new File([c], n, { type: 'text/plain' }) } },
      async *entries() { opened.push(`${at}*`); for (const [n, c] of Object.entries(t)) yield [n, typeof c === 'string' ? { kind: 'file', name: n } : { kind: 'directory', name: n }] },
    })
    ;(window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => dir('.claude', tree as { [name: string]: Node }, '')
  }, TREE)
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  // 2/4 내 스킬; nothing about a deck (회사 소개 was put off)
  await expect(page.getByTestId('skills-step')).toBeVisible()
  await expect(page.getByTestId('welcome-progress')).toContainText('2/4 내 스킬')
  await expect(page.getByRole('heading', { name: 'Claude Code나 Codex에서 쓰던 스킬, 팀도 쓰게 할까요?' })).toBeVisible()
  await expect(page.getByTestId('skills-promise')).toBeVisible()
  await expect(page.getByTestId('skills-cc-prompt')).toContainText('내 스킬 중 팀에 공유할 만한 걸 트리나에 올려 줘')
  await expect(page.getByTestId('setup-row')).toHaveCount(0)
  await page.getByTestId('skills-find').click()
  // the list: recommended ones ticked with a reason each, the folded rows, CLAUDE.md as a rule, one primary
  await expect(page.getByTestId('skills-recommended')).toBeVisible()
  await expect(page.getByTestId('skills-share')).toBeEnabled()
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)
  // only known places: never transcripts, history or the sign-in file
  expect(opened.filter((x) => /credentials|history|projects/.test(x))).toEqual([])
  await page.getByTestId('skills-share').click()
  await expect(page.getByTestId('skills-done')).toBeVisible()
  // the server recorded 내 스킬 done itself
  expect((await (await page.request.get('/api/onboarding/welcome')).json()).progress.steps.skills).toBe('done')
  await page.getByTestId('skills-done-next').click()
  // 3/4 팀 파일, put off; then the invite (no deck chat opens by itself)
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  await expect(page.getByTestId('welcome-progress')).toContainText('4/4 팀원 초대')
  // the message names one skill, the landing one; the link opens it
  await expect(page.getByTestId('team-link-message')).toContainText('같이 써 보자고 해요')
  await expect(page.getByTestId('team-link-landing')).toContainText('부터 열려요')
  const progress = (await (await page.request.get('/api/onboarding/welcome')).json()).progress
  const link = (await (await page.request.get('/api/admin/team-link')).json()).link
  expect(link.skill.path).toBe(progress.shared.landing)
  const others = progress.shared.skills.filter((x: { path: string }) => x.path !== progress.shared.landing).map((x: { title: string }) => x.title)
  for (const title of others) await expect(page.getByTestId('team-link-message')).not.toContainText(`'${title}'`)
  await page.getByTestId('invite-step-done').click()
  // 준비 끝났어요, once: no deck line (no deck), the owner's own run of the landing skill first, 홈으로 quiet
  await expect(page.getByTestId('welcome-done')).toContainText('준비 끝났어요')
  await expect(page.getByTestId('welcome-done')).not.toContainText('회사 소개서')
  await expect(page.getByTestId('welcome-done-try')).toContainText('먼저 써 보기')
  await page.getByTestId('welcome-done-try').click()
  await expect.poll(() => { const u = new URL(page.url()); return `${u.pathname} ${u.searchParams.get('run')}` }).toBe(`/skills ${progress.shared.landing}`)
  await expect(page.getByTestId('skill-form')).toBeVisible()
  // finished: no setup row any more
  await expect(page.getByTestId('setup-row')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})
