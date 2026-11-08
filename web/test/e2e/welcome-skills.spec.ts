// 내 스킬 가져오기 in a real browser against the mock (docs/DECISIONS.md "SK", "W5", "W6"): 회사 소개 put off (no deck, no
// profile: no kept skill comes checked), then [내 스킬 찾기] opens the folder window (Chrome's showDirectoryPicker, stubbed
// here with an in-memory .claude folder that logs every name opened: Playwright cannot drive the OS folder window), the
// list comes back checked and judged; 팀 스킬 and back through the setup row finds the same list (nothing picked again);
// the step's one primary [팀에 넣기 · N개] puts the ticked ones in (the server marks 내 스킬 done; a merge waits for the end
// of the setup) and goes on to 팀 파일 with a toast; 이전 from 팀 파일 shows what went in, 다른 폴더도 가져오기 and 다음; 팀 파일
// is put off; the invite names ONE skill, the first shared, and its link opens it; then 준비 끝났어요 with the owner's own
// run of that skill. The kept skills' rows and the example viewer: onb6-skills.spec.ts.
import { expect, test } from '@playwright/test'
import { PRODUCT } from '@mycel/shared'
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

test('[내 스킬 찾기] → the list (kept across a trip away) → [팀에 넣기 · N개] → 팀 파일; 이전 shows what went in; 팀 파일 put off; the invite names one shared skill and opens it; 준비 끝났어요 → its form', async ({ page }) => {
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
  await expect(page.getByRole('heading', { name: '팀이 쓸 스킬을 골라 주세요' })).toBeVisible()
  // no company profile: no kept skill comes checked, so there is no primary yet (나중에 하기 stands in)
  await expect(page.getByTestId('skill-packs').getByRole('checkbox', { checked: true })).toHaveCount(0)
  const primary = page.getByTestId('skills-primary')
  await expect(primary).toHaveCount(0)
  await expect(page.getByTestId('skills-promise')).toBeVisible()
  // the Claude Code / Codex line sits behind one disclosure
  await expect(page.getByTestId('skills-cc-prompt')).toHaveCount(0)
  await page.getByTestId('skills-cc-toggle').click()
  await expect(page.getByTestId('skills-cc-prompt')).toContainText(`내 스킬 중 팀에 공유할 만한 걸 ${PRODUCT.displayName}에 올려 줘`)
  await expect(page.getByTestId('setup-row')).toHaveCount(0)
  await page.getByTestId('skills-find').click()
  // the list: recommended ones ticked with a reason each, the folded rows, CLAUDE.md as a rule; the step's one primary
  // counts what is ticked (the list has no button of its own here)
  await expect(page.getByTestId('skills-recommended')).toBeVisible()
  await expect(primary).toHaveAttribute('data-state', 'put')
  await expect(primary).toHaveText(/^팀에 넣기 · \d+개$/)
  await expect(primary).toBeEnabled()
  await expect(page.getByTestId('skills-share')).toHaveCount(0)
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)
  // only known places: never transcripts, history or the sign-in file
  expect(opened.filter((x) => /credentials|history|projects/.test(x))).toEqual([])
  // leaving the step (팀 스킬) and coming back through the setup row finds the same list: nothing picked or read again
  await page.getByTestId('nav-skills').click()
  await expect(page).toHaveURL(/\/skills$/)
  await page.getByTestId('setup-row-link').click()
  await expect(primary).toHaveAttribute('data-state', 'put')
  await expect(primary).toBeEnabled()
  await expect(page.getByTestId('skills-find')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.length)).toBe(opened.length)
  const n = Number(/(\d+)개/.exec(await primary.innerText())![1])
  await primary.click()
  // all in: a toast with the count and on to 3/4 팀 파일; the server recorded 내 스킬 done itself
  await expect(page.getByTestId('toast').filter({ hasText: `스킬 ${n}개를 팀에 넣었어요` })).toBeVisible()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  expect((await (await page.request.get('/api/onboarding/welcome')).json()).progress.steps.skills).toBe('done')
  // 이전 shows what went in (not the empty picker), one quiet way to a second folder, and 다음 goes on again
  await page.getByTestId('welcome-back').click()
  await expect(page.getByTestId('skills-done')).toBeVisible()
  await expect(page.getByTestId('skills-find')).toHaveCount(0)
  await expect(page.getByTestId('skills-more')).toHaveText('다른 폴더도 가져오기')
  await expect(primary).toHaveAttribute('data-state', 'next')
  await expect(primary).toHaveText('다음: 팀 파일 가져오기')
  await primary.click()
  // 팀 파일, put off; then the invite (no deck chat opens by itself)
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
