// The skills step and own skills in a real browser against the mock (docs/DECISIONS.md "SK", "W5", "W6", "W7"):
// - the setup walk: 회사 소개 put off (no profile: no kept skill comes checked), the skills step shows only the skills
//   Trina prepared (no folder button, no hidden-folder hint, no Claude Code or Codex line); one checked → the primary
//   names it → a toast and 팀 파일; 이전 shows 다음; 팀 파일 and 도구 연결 put off; the invite; 준비 끝났어요 → a skill's form;
// - Team skills › 내 스킬 가져오기, the one way in for own skills: [내 스킬 찾기] opens the folder window (Chrome's
//   showDirectoryPicker, stubbed here with an in-memory .claude folder that logs every name opened: Playwright cannot
//   drive the OS folder window); only known places are read; the list comes back checked and judged; [팀에 넣기 · N개]
//   puts the ticked ones in. The kept skills' rows and the example viewer: onb6-skills.spec.ts.
import { expect, test } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole, noSlack } from './helpers'

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

test('the setup walk: the skills step offers only the skills Trina prepared; one goes in → 팀 파일; 이전 shows 다음; the invite; 준비 끝났어요 → its form', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await noSlack(page)
  await signIn(page)
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  // 2/5 스킬
  const step = page.getByTestId('skills-step')
  await expect(step).toBeVisible()
  await expect(page.getByTestId('welcome-progress')).toContainText('2/5 스킬')
  await expect(page.getByRole('heading', { name: '팀이 쓸 스킬을 골라 주세요' })).toBeVisible()
  // nothing about own skills: no folder to pick, no hidden-folder hint, no Claude Code or Codex line
  for (const id of ['skills-own', 'skills-find', 'skills-hint', 'skills-promise', 'skills-cc', 'skills-cc-toggle']) await expect(page.getByTestId(id)).toHaveCount(0)
  await expect(step).not.toContainText('.claude')
  await expect(step).not.toContainText('내 스킬 가져오기')
  // no company profile: the everyday four still come checked (docs/decisions/20261122-onboarding-everyday-skills.md);
  // the primary counts them, 나중에 하기 beside it
  const packs = page.getByTestId('skill-packs')
  await expect(packs.getByRole('checkbox', { checked: true })).toHaveCount(4)
  const primary = page.getByTestId('skills-primary')
  await expect(primary).toHaveText('스킬 4개 넣기')
  await expect(page.getByTestId('skills-later')).toBeVisible()
  // three unchecked: the one left is named
  for (const n of ['meeting-notes', 'team-report', 'customer-reply']) await packs.locator(`[data-testid="skill-pack-row"][data-name="${n}"]`).getByTestId('skill-pack-check').uncheck()
  await expect(primary).toHaveText('자연스러운 글 넣기')
  await primary.click()
  // all in: a toast and on to 3/5 팀 파일; the server recorded the step done
  await expect(page.getByTestId('toast').filter({ hasText: '스킬 1개를 팀에 넣었어요' })).toBeVisible()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  expect((await (await page.request.get('/api/onboarding/welcome')).json()).progress.steps.skills).toBe('done')
  // 이전: a revisit checks nothing; 다음 goes on again
  await page.getByTestId('welcome-back').click()
  await expect(step).toBeVisible()
  await expect(primary).toHaveAttribute('data-state', 'next')
  await expect(primary).toHaveText('다음: 팀 파일 가져오기')
  await expect(page.getByTestId('skills-later')).toHaveCount(0)
  await primary.click()
  // 팀 파일, put off; 도구 연결 put off; then the invite
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('welcome-tools')).toBeVisible()
  await page.getByTestId('welcome-later').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  await expect(page.getByTestId('welcome-progress')).toContainText('5/5 팀원 초대')
  await page.getByTestId('invite-step-done').click()
  // 준비 끝났어요, once: the steps summed up (내 스킬 done with the skill that went in), no first result; 내 설정 시작 → Home
  await expect(page.getByTestId('welcome-done')).toContainText('준비 끝났어요')
  await expect(page.getByTestId('welcome-done-make')).toHaveCount(0)
  await expect(page.locator('[data-testid="welcome-done-row"][data-step="skills"]')).toHaveAttribute('data-state', 'done')
  await page.getByTestId('welcome-done-home').click()
  await expect(page).toHaveURL(/\/$/)
  // finished with 회사 소개, 팀 파일 and 도구 연결 put off: the setup row stays for them (fix/onboarding-after-setup) and
  // opens the first
  const left = page.getByTestId('setup-row')
  await expect(left).toHaveAttribute('data-state', 'left')
  await expect(left.getByTestId('setup-row-link')).toHaveText('남은 일 3개')
  await left.getByTestId('setup-row-link').click()
  await expect(page.getByTestId('welcome-profile')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('Team skills › 내 스킬 가져오기: [내 스킬 찾기] reads only known places; the list comes back judged; [팀에 넣기 · N개] puts the ticked ones in', async ({ page }) => {
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
  await page.goto('/skills')
  await page.getByTestId('skill-bring').click()
  await expect(page.getByTestId('bring-sheet')).toBeVisible()
  await expect(page.getByTestId('bring-hint')).toContainText('.claude')
  await page.getByTestId('bring-find').click()
  // the list: recommended ones ticked with a reason each, CLAUDE.md as a rule; its own primary counts them
  await expect(page.getByTestId('skills-recommended')).toBeVisible()
  const share = page.getByTestId('skills-share')
  await expect(share).toBeEnabled()
  await expect(share).toHaveText(/팀에 넣기 · \d+개/)
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)
  // only known places: never transcripts, history or the sign-in file
  expect(opened.length).toBeGreaterThan(0)
  expect(opened.filter((x) => /credentials|history|projects/.test(x))).toEqual([])
  await share.click()
  await expect(page.getByTestId('skills-done')).toBeVisible()
  const names = ((await (await page.request.get('/api/skills')).json()).items as { name: string }[]).map((x) => x.name)
  expect(names).toContain('weekly-report')
  await page.getByTestId('skills-done-next').click()
  await expect(page.getByTestId('bring-sheet')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})
