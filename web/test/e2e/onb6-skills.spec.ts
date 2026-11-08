// The kept skills in a real browser against the mock (docs/DECISIONS.md "W6 — Onboarding v6: skills catalog and 내 스킬";
// FLOW-v6 §2, §4.2): the owner's 내 스킬 step (components/onboarding/SkillsStep.tsx) lists the kept skills the team does
// not have (회사 소개서, 카드뉴스, 홍보 영상 checked when a company profile is saved, 자연스러운 글 never) above
// bring-your-own, under ONE primary that names what goes in; 예시 opens the viewer with the example made on the invented
// 예시커피 / Example Coffee (one per open, Esc back to the row). Own skills
// still being checked hold the primary, and a check past 30 seconds is ended (the list then shows unticked, "AI 없이").
// A press that does not all go in stays with the reason (a request that failed with 다시 시도; a name already taken) and
// a 다음. The Team skills page (components/AvailableSkills.tsx): for owners and admins the kept skills folded under the
// lists, nothing checked, installed rows moving up into the list; "내 스킬 가져오기" for everyone on a computer (the
// bring sheet, a member's suggestion sheet); a phone's plain line. The step with own skills only: welcome-skills.spec.ts.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { PRODUCT } from '@mycel/shared'
import { CSRF_HEADER } from '@mycel/shared/api'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }
const H = { [CSRF_HEADER]: '1' }
/** a saved company profile (what 회사 소개 saves): the visual kept skills come checked */
const PROFILE = { website: 'https://acme.example/', oneLine: 'Acme는 조용한 책상 선풍기를 만들어요', products: '책상 선풍기', audience: '작은 사무실', tone: [], avoid: '', sources: [] }
/** the kept skills in the catalog's order, with their Korean titles */
const KEPT = ['intro-deck', 'card-news', 'promo-video', 'humanizer']
const TITLES = ['회사 소개서', '카드뉴스', '홍보 영상', '자연스러운 글']

/** A .claude folder with two skills (welcome-skills.spec.ts has the full one). */
const TREE = {
  skills: {
    'weekly-report': { 'SKILL.md': '---\nname: weekly-report\ndescription: 주간 업무 보고를 써요\n---\n이번 주 한 일을 정리해요.\n' },
    'meeting-notes': { 'SKILL.md': '---\nname: meeting-notes\ndescription: 회의록을 정리해요\n---\n회의 내용을 정리해요.\n' },
  },
}

async function post(page: Page, path: string, data: unknown) {
  const r = await page.request.post(path, { headers: H, data })
  expect(r.ok(), `${path}: ${r.status()}`).toBeTruthy()
}

/** Chrome's folder window, answered with TREE (Playwright cannot drive the OS window). */
async function stubFolderWindow(page: Page) {
  await page.addInitScript((tree) => {
    type Node = string | { [name: string]: Node }
    const dir = (name: string, t: { [name: string]: Node }): unknown => ({
      kind: 'directory', name,
      async getDirectoryHandle(n: string) { const c = t[n]; if (!c || typeof c === 'string') throw new DOMException('NotFound', 'NotFoundError'); return dir(n, c) },
      async getFileHandle(n: string) { const c = t[n]; if (typeof c !== 'string') throw new DOMException('NotFound', 'NotFoundError'); return { kind: 'file', name: n, getFile: async () => new File([c], n, { type: 'text/plain' }) } },
      async *entries() { for (const [n, c] of Object.entries(t)) yield [n, typeof c === 'string' ? { kind: 'file', name: n } : { kind: 'directory', name: n }] },
    })
    ;(window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => dir('.claude', tree as { [name: string]: Node })
  }, TREE)
}

/** The owner on 2/4 내 스킬 with all four kept skills offered: 회사 소개 put off (no deck), with or without a saved
 * profile. The mock's team start may still put the visual three in (an older mock, like the server before W6): they are
 * taken out and the step opened again, so the step offers all four either way. */
async function toSkillsStep(page: Page, o: { profile?: boolean } = {}) {
  await signIn(page)
  if (o.profile) expect((await page.request.put('/api/onboarding/profile', { headers: H, data: PROFILE })).ok()).toBeTruthy()
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await expect(page.getByTestId('skills-step')).toBeVisible()
  await post(page, '/__test/rmdir', { path: 'skills/general' })
  await page.reload()
  await expect(page.getByTestId('skills-step')).toBeVisible()
  await expect(page.getByTestId('skill-packs').getByTestId('skill-pack-row')).toHaveCount(4)
}

const packRow = (root: Page | Locator, name: string) => root.locator(`[data-testid="skill-pack-row"][data-name="${name}"]`)
const checks = (root: Locator) => root.getByTestId('skill-pack-check').evaluateAll((xs) => xs.map((x) => (x as HTMLInputElement).checked))
const progress = async (page: Page) => (await (await page.request.get('/api/onboarding/welcome')).json()).progress
const inTeam = async (page: Page) => ((await (await page.request.get('/api/onboarding/packs')).json()).skills as { name: string; inTeam: boolean }[]).filter((s) => s.inTeam).map((s) => s.name)

test('내 스킬 with a company profile: four kept skills, the visual three checked; 예시 with ‹ › and Esc; one press puts them in; 이전 shows 다음', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await toSkillsStep(page, { profile: true })
  await expect(page.getByRole('heading', { name: '팀이 쓸 스킬을 골라 주세요' })).toBeVisible()
  const packs = page.getByTestId('skill-packs')
  await expect(packs.getByRole('heading', { name: `${PRODUCT.displayName}가 준비한 스킬` })).toBeVisible()
  await expect(packs.getByTestId('skill-pack-title')).toHaveText(TITLES)
  expect(await packs.getByTestId('skill-pack-row').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-name')))).toEqual(KEPT)
  await expect(packs.getByTestId('skill-pack-line')).toHaveCount(4)
  await expect(packRow(packs, 'intro-deck').getByTestId('skill-pack-line')).toHaveText('회사 소개로 6~10장짜리 소개서를 만들어요')
  expect(await checks(packs)).toEqual([true, true, true, false])
  // one primary naming what goes in; 나중에 하기 beside it; the own part under it with its folder button
  const primary = page.getByTestId('skills-primary')
  await expect(primary).toHaveAttribute('data-state', 'put')
  await expect(primary).toHaveText('회사 소개서·카드뉴스·홍보 영상 넣기')
  await expect(page.getByTestId('skills-later')).toBeVisible()
  await expect(page.getByTestId('skills-own').getByRole('heading', { name: '내 스킬 가져오기' })).toBeVisible()
  await expect(page.getByTestId('skills-find')).toBeVisible()
  await expect(page.getByTestId('skills-hint')).toBeVisible()
  await expect(page.getByTestId('skills-promise')).toHaveText('고른 폴더의 스킬만 읽어요 · 넣기 전에 목록을 먼저 보여 드려요')
  // a check moves the words: 자연스러운 글 too → four items, counted
  await packRow(packs, 'humanizer').getByTestId('skill-pack-check').check()
  await expect(primary).toHaveText('팀에 넣기 · 4개')
  await packRow(packs, 'humanizer').getByTestId('skill-pack-check').uncheck()
  await expect(primary).toHaveText('회사 소개서·카드뉴스·홍보 영상 넣기')

  // 예시: that row's example, one per open (the picture the skill made on the invented 예시커피; no stepping to the next
  // row), Esc closes and the focus goes back to that row's 예시
  await packRow(packs, 'card-news').getByTestId('skill-pack-example').click()
  const viewer = page.getByTestId('skill-example')
  await expect(viewer).toHaveAttribute('data-name', 'card-news')
  await expect(viewer).toHaveAttribute('data-state', 'shown')
  const picture = viewer.getByTestId('skill-example-image')
  await expect(picture).toHaveAttribute('src', '/skill-examples/ko/card-news.webp')
  await expect(picture).toBeVisible()
  expect(await picture.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1280)
  await expect(viewer).not.toContainText('예시를 준비하고 있어요')
  await expect(viewer.getByTestId('skill-example-fictional')).toHaveText("가상의 회사 '예시커피'로 만든 예시예요. 우리 팀 자료로 쓰면 결과도 우리 회사 것으로 나와요.")
  await expect(viewer.getByTestId('skill-example-source')).toHaveText(`${PRODUCT.displayName} 팀이 만들었어요`)
  await expect(page.getByRole('dialog')).toContainText("'카드뉴스' 예시")
  await expect(viewer.getByTestId('skill-example-next')).toHaveCount(0)
  await expect(viewer.getByTestId('skill-example-prev')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(viewer).toHaveAttribute('data-name', 'card-news')
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(packRow(packs, 'card-news').getByTestId('skill-pack-example')).toBeFocused()
  await packRow(packs, 'humanizer').getByTestId('skill-pack-example').click()
  await expect(viewer).toHaveAttribute('data-name', 'humanizer')
  // the before → after text, drawn in the page: the AI-sounding notice quoted, its rewrite under it
  await expect(viewer).toHaveAttribute('data-state', 'shown')
  await expect(viewer.getByTestId('skill-example-body').locator('blockquote')).toContainText('이번 공지에서는 사무실 구독 배송 일정 변경에 대해 자세히 알아보겠습니다')
  await expect(viewer.getByTestId('skill-example-body')).toContainText('지금처럼 수요일에 받고 싶으시면 11월 25일까지 hello@coffee.example로 알려 주세요.')
  await expect(viewer).not.toContainText('예시를 준비하고 있어요')
  await expect(viewer.getByTestId('skill-example-source')).toHaveText(`${PRODUCT.displayName} 팀이 쓰던 한국어 글쓰기 스킬을 바탕으로 만들었어요`)
  await expect(viewer.getByTestId('skill-example-original')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(packRow(packs, 'humanizer').getByTestId('skill-pack-example')).toBeFocused()
  // the checks never moved
  expect(await checks(packs)).toEqual([true, true, true, false])

  // the press: all in → a toast and 3/4 팀 파일; the server recorded 내 스킬 done
  await primary.click()
  await expect(page.getByTestId('toast').filter({ hasText: '스킬 3개를 팀에 넣었어요' })).toBeVisible()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  expect((await progress(page)).steps.skills).toBe('done')
  expect(await inTeam(page)).toEqual(['intro-deck', 'card-news', 'promo-video'])
  // ← 이전: only the one still missing, unchecked (a revisit checks nothing); the primary is 다음, no 나중에 하기
  await page.getByTestId('welcome-back').click()
  await expect(page.getByTestId('skills-step')).toBeVisible()
  await expect(packs.getByTestId('skill-pack-row')).toHaveCount(1)
  await expect(packRow(packs, 'humanizer').getByTestId('skill-pack-check')).not.toBeChecked()
  await expect(primary).toHaveAttribute('data-state', 'next')
  await expect(primary).toHaveText('다음: 팀 파일 가져오기')
  await expect(page.getByTestId('skills-later')).toHaveCount(0)
  await primary.click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('내 스킬, own skills and a kept one: the primary waits while they are checked; past 30 seconds the list shows unticked; one own + 카드뉴스 → "카드뉴스·주간 업무 보고 넣기" (own skills named too), both go in', async ({ page }) => {
  const errors = watchConsole(page)
  // the page's own clock (time still runs): the 30 seconds are skipped instead of waited for
  await page.clock.install()
  await stubFolderWindow(page)
  await reset(page)
  await toSkillsStep(page)
  // no profile: nothing checked, so no primary yet
  const packs = page.getByTestId('skill-packs')
  expect(await checks(packs)).toEqual([false, false, false, false])
  const primary = page.getByTestId('skills-primary')
  await expect(primary).toHaveCount(0)
  await expect(page.getByTestId('skills-later')).toBeVisible()
  // the AI's check of the folder held (the mock answers checking until the page ends it)
  await post(page, '/__test/share-hold', { on: true })
  await page.getByTestId('skills-find').click()
  const review = page.getByTestId('skill-review')
  await expect(review).toHaveAttribute('data-status', 'checking')
  await expect(primary).toHaveAttribute('data-state', 'checking')
  await expect(primary).toHaveText('내 스킬 살펴보는 중…')
  await expect(primary).toBeDisabled()
  // a kept skill checked meanwhile does not free the primary
  await packRow(packs, 'card-news').getByTestId('skill-pack-check').check()
  await expect(primary).toHaveAttribute('data-state', 'checking')
  // 30 seconds on screen: the page ends the check (stop-check); the list shows with nothing ticked
  const stopped = page.waitForRequest((r) => r.method() === 'POST' && /^\/api\/skill-shares\/[^/]+\/stop-check$/.test(new URL(r.url()).pathname))
  await page.clock.fastForward('00:31')
  await stopped
  await expect(review).toHaveAttribute('data-status', 'ready')
  await expect(page.getByTestId('skill-review-no-ai')).toHaveText('AI 없이 찾았어요 · 직접 골라 주세요')
  await expect(review.getByRole('checkbox', { checked: true })).toHaveCount(0)
  await expect(review.locator('[data-testid="skill-row"][data-name="weekly-report"]')).toBeVisible()
  // only 카드뉴스 so far: named
  await expect(primary).toHaveAttribute('data-state', 'put')
  await expect(primary).toHaveText('카드뉴스 넣기')
  await review.locator('[data-testid="skill-row"][data-name="weekly-report"]').getByTestId('skill-check').check()
  await expect(primary).toHaveText('카드뉴스·주간 업무 보고 넣기')
  await primary.click()
  // own first, then the kept one: both in, one toast, 팀 파일
  await expect(page.getByTestId('toast').filter({ hasText: '스킬 2개를 팀에 넣었어요' })).toBeVisible()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  const names = ((await (await page.request.get('/api/skills')).json()).items as { name: string }[]).map((s) => s.name)
  expect(names).toEqual(expect.arrayContaining(['weekly-report', 'card-news']))
  expect(names).not.toContain('meeting-notes')
  expect(await inTeam(page)).toEqual(['card-news'])
  expect((await progress(page)).steps.skills).toBe('done')
  expect(realErrors(errors)).toEqual([])
})

test('내 스킬, a request that fails: the note with 다시 시도, the primary 다음; 다시 시도 puts them in and goes on', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await toSkillsStep(page, { profile: true })
  await post(page, '/__test/pack-install-fail', { times: 1 })
  const primary = page.getByTestId('skills-primary')
  await primary.click()
  const failed = page.getByTestId('skill-pack-failed')
  await expect(failed).toBeVisible()
  // the step stays: nothing marked in, the primary is 다음 (it puts nothing in)
  await expect(page.getByTestId('skills-step')).toBeVisible()
  await expect(page.getByTestId('skill-packs').locator('[data-testid="skill-pack-row"][data-state="in"]')).toHaveCount(0)
  await expect(primary).toHaveAttribute('data-state', 'next')
  await expect(primary).toHaveText('다음: 팀 파일 가져오기')
  expect(await inTeam(page)).toEqual([])
  await failed.getByRole('button', { name: '다시 시도' }).click()
  await expect(page.getByTestId('toast').filter({ hasText: '스킬 3개를 팀에 넣었어요' })).toBeVisible()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  expect(await inTeam(page)).toEqual(['intro-deck', 'card-news', 'promo-video'])
  expect((await progress(page)).steps.skills).toBe('done')
  // the one failed request (500) is the browser's log line, and no other
  expect(realErrors(errors).filter((e) => !/status of 500/.test(e))).toEqual([])
  expect(realErrors(errors).filter((e) => /status of 500/.test(e))).toHaveLength(1)
})

test('내 스킬, a name already taken: that one stays out with why, the others go in, the primary reads 다음', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await toSkillsStep(page, { profile: true })
  // after the rows showed, another team skill takes the name 카드뉴스 uses
  await post(page, '/__test/file', { path: 'skills/mine/card-news/SKILL.md', text: '---\nname: card-news\ndescription: 우리 팀 카드뉴스\n---\n# 우리 팀 카드뉴스\n' })
  const primary = page.getByTestId('skills-primary')
  await expect(primary).toHaveText('회사 소개서·카드뉴스·홍보 영상 넣기')
  await primary.click()
  const packs = page.getByTestId('skill-packs')
  await expect(page.getByTestId('skill-pack-taken')).toHaveText('1개는 넣지 못했어요 · 같은 이름의 스킬이 이미 있어요')
  await expect(packRow(packs, 'card-news')).toHaveAttribute('data-state', 'out')
  await expect(packRow(packs, 'card-news')).toContainText('같은 이름의 스킬이 이미 있어요')
  for (const name of ['intro-deck', 'promo-video']) {
    await expect(packRow(packs, name)).toHaveAttribute('data-state', 'in')
    await expect(packRow(packs, name)).toContainText('팀에 넣었어요')
  }
  // not all in: no toast, the step stays, its primary goes on
  await expect(page.getByTestId('toast').filter({ hasText: '팀에 넣었어요' })).toHaveCount(0)
  await expect(primary).toHaveAttribute('data-state', 'next')
  await expect(primary).toHaveText('다음: 팀 파일 가져오기')
  // the server kept the team's own 카드뉴스 and put the other two in
  expect((await (await page.request.get(`/api/files/tree?path=${encodeURIComponent('skills/general')}`)).json()).entries.map((e: { name: string }) => e.name).sort()).toEqual(['intro-deck', 'promo-video'])
  expect((await progress(page)).steps.skills).toBe('done')
  await primary.click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('Team skills (owner): the kept skills folded under the list, nothing checked; two in move up into the list; hidden while searching, gone when none is missing; 내 스킬 가져오기 opens the bring sheet', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await page.goto('/skills')
  const fold = page.getByTestId('skill-catalog')
  const toggle = page.getByTestId('skill-catalog-toggle')
  await expect(toggle).toHaveText(`${PRODUCT.displayName}가 준비한 스킬 · 4개 더`)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(fold.getByTestId('skill-pack-row')).toHaveCount(0)
  // the search box hides it; emptied, it is back
  await page.getByTestId('skill-search').fill('카드')
  await expect(fold).toHaveCount(0)
  await page.getByTestId('skill-search').fill('')
  await expect(toggle).toBeVisible()
  // open: the four, nothing checked, the button counts what is
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(fold.getByTestId('skill-pack-title')).toHaveText(TITLES)
  expect(await checks(fold)).toEqual([false, false, false, false])
  const install = page.getByTestId('skill-catalog-install')
  await expect(install).toHaveText('팀에 넣기 · 0개')
  await expect(install).toBeDisabled()
  await packRow(fold, 'card-news').getByTestId('skill-pack-check').check()
  await packRow(fold, 'humanizer').getByTestId('skill-pack-check').check()
  await expect(install).toHaveText('팀에 넣기 · 2개')
  await install.click()
  await expect(page.getByTestId('toast').filter({ hasText: '스킬 2개를 넣었어요.' })).toBeVisible()
  // the two are in the list now, and the fold counts the rest
  const list = page.getByTestId('skill-list')
  await expect(list.locator('[data-testid="skill-row"][data-path="skills/general/card-news/SKILL.md"]')).toBeVisible()
  await expect(list.locator('[data-testid="skill-row"][data-path="skills/work/humanizer/SKILL.md"]')).toBeVisible()
  await expect(toggle).toHaveText(`${PRODUCT.displayName}가 준비한 스킬 · 2개 더`)
  await expect(fold.getByTestId('skill-pack-title')).toHaveText(['회사 소개서', '홍보 영상'])
  // 접기, open again, the rest in: the fold is gone
  await page.getByTestId('skill-catalog-fold').click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  expect(await checks(fold)).toEqual([false, false])
  await packRow(fold, 'intro-deck').getByTestId('skill-pack-check').check()
  await packRow(fold, 'promo-video').getByTestId('skill-pack-check').check()
  await install.click()
  await expect(page.getByTestId('toast').filter({ hasText: '스킬 2개를 넣었어요.' }).last()).toBeVisible()
  await expect(fold).toHaveCount(0)
  await expect(list.locator('[data-testid="skill-row"][data-path^="skills/general/"]')).toHaveCount(3)
  // 내 스킬 가져오기 (an owner): the bring sheet, its folder button
  const bring = page.getByTestId('skill-bring')
  await expect(bring).toHaveAttribute('data-role', 'admin')
  await expect(bring).toHaveText('내 스킬 가져오기')
  await bring.click()
  await expect(page.getByTestId('bring-sheet')).toBeVisible()
  await expect(page.getByTestId('bring-find')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('bring-sheet')).toHaveCount(0)
  await expect(bring).toBeFocused()
  expect(realErrors(errors)).toEqual([])
})

test('Team skills (owner): a catalog that does not load says so with 다시 시도; examples show, or say they did not load, or are still being made', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await post(page, '/__test/packs-fail', { on: true })
  await page.goto('/skills')
  const failed = page.getByTestId('skill-catalog-failed')
  await expect(failed).toContainText('준비한 스킬을 불러오지 못했어요')
  await expect(page.getByTestId('skill-catalog')).toHaveCount(0)
  await post(page, '/__test/packs-fail', { on: false })
  // the examples that ship for the deck and the text (the server's own); a picture that is missing; one not made yet
  await post(page, '/__test/pack-examples', { examples: {
    'card-news': { kind: 'image', url: '/examples/missing-card-news.png' },
    'promo-video': null,
  } })
  await failed.getByRole('button', { name: '다시 시도' }).click()
  await expect(failed).toHaveCount(0)
  await page.getByTestId('skill-catalog-toggle').click()
  const fold = page.getByTestId('skill-catalog')
  await packRow(fold, 'intro-deck').getByTestId('skill-pack-example').click()
  const viewer = page.getByTestId('skill-example')
  await expect(viewer).toHaveAttribute('data-state', 'shown')
  await expect(viewer.getByTestId('skill-example-image')).toBeVisible()
  await expect(viewer.getByTestId('skill-example-image')).toHaveAttribute('src', '/skill-examples/ko/intro-deck.webp')
  await expect(viewer.getByTestId('skill-example-fictional')).toHaveText("가상의 회사 '예시커피'로 만든 예시예요. 우리 팀 자료로 쓰면 결과도 우리 회사 것으로 나와요.")
  await page.keyboard.press('Escape')
  await packRow(fold, 'card-news').getByTestId('skill-pack-example').click()
  await expect(viewer).toHaveAttribute('data-name', 'card-news')
  await expect(viewer).toHaveAttribute('data-state', 'failed')
  await expect(viewer).toContainText('예시를 불러오지 못했어요')
  await expect(viewer).toContainText('회사 소개로 정사각형 카드 5장을 만들어요')
  await expect(viewer.getByTestId('skill-example-fictional')).toHaveCount(0)
  await page.keyboard.press('Escape')
  // a skill whose example is not made yet still says so
  await packRow(fold, 'promo-video').getByTestId('skill-pack-example').click()
  await expect(viewer).toHaveAttribute('data-name', 'promo-video')
  await expect(viewer).toHaveAttribute('data-state', 'placeholder')
  await expect(viewer).toContainText('예시를 준비하고 있어요')
  await expect(viewer.getByTestId('skill-example-fictional')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await packRow(fold, 'humanizer').getByTestId('skill-pack-example').click()
  await expect(viewer).toHaveAttribute('data-name', 'humanizer')
  await expect(viewer).toHaveAttribute('data-state', 'shown')
  await expect(viewer).toContainText('예시커피, 12월 1일부터 사무실 구독 배송일 목요일로 변경')
  await expect(viewer.getByTestId('skill-example-fictional')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(packRow(fold, 'humanizer').getByTestId('skill-pack-example')).toBeFocused()
  // the catalog's failed read (500) and the missing example image (404): the browser's log lines, and no other
  const other = realErrors(errors).filter((e) => !/status of (500|404)/.test(e))
  expect(other).toEqual([])
  expect(realErrors(errors).filter((e) => /status of 500/.test(e))).toHaveLength(1)
  expect(realErrors(errors).filter((e) => /status of 404/.test(e))).toHaveLength(1)
})

test('Team skills, an English team: the English examples (Example Coffee); 자연스러운 글 names the open-source original it was adapted from, in a new tab', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page, { teamLocale: 'en' })
  await signIn(page)
  await page.goto('/skills')
  await page.getByTestId('skill-catalog-toggle').click()
  const fold = page.getByTestId('skill-catalog')
  await expect(fold.getByTestId('skill-pack-title')).toHaveText(['Company profile', 'Promo cards', 'Promo video', 'Natural writing'])
  await packRow(fold, 'humanizer').getByTestId('skill-pack-example').click()
  const viewer = page.getByTestId('skill-example')
  await expect(viewer).toHaveAttribute('data-name', 'humanizer')
  await expect(viewer).toHaveAttribute('data-state', 'shown')
  await expect(viewer.getByTestId('skill-example-body').locator('blockquote')).toContainText("In today's fast-paced world")
  await expect(viewer.getByTestId('skill-example-body')).toContainText('Offices can now get a free tasting kit from us.')
  await expect(viewer.getByTestId('skill-example-fictional')).toContainText('Example Coffee')
  await expect(viewer.getByTestId('skill-example-source')).toHaveAttribute('data-kind', 'adapted')
  await expect(viewer.getByTestId('skill-example-source')).toContainText('Siqi Chen')
  await expect(viewer.getByTestId('skill-example-source')).toContainText('MIT')
  const original = viewer.getByTestId('skill-example-original')
  await expect(original).toHaveAttribute('href', 'https://github.com/blader/humanizer')
  await expect(original).toHaveAttribute('target', '_blank')
  await expect(original).toHaveAttribute('rel', /noopener/)
  // the others were made by the product's team: no link out
  await page.keyboard.press('Escape')
  await packRow(fold, 'promo-video').getByTestId('skill-pack-example').click()
  await expect(viewer).toHaveAttribute('data-name', 'promo-video')
  await expect(viewer).toHaveAttribute('data-state', 'shown')
  await expect(viewer.getByTestId('skill-example-image')).toHaveAttribute('src', '/skill-examples/en/promo-video.webp')
  await expect(viewer.getByTestId('skill-example-source')).toHaveAttribute('data-kind', 'team')
  await expect(viewer.getByTestId('skill-example-original')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('Team skills (member): no catalog; 내 스킬 가져오기 opens the suggestion sheet; an empty team says who puts skills in', async ({ page }) => {
  const errors = watchConsole(page)
  const asked: string[] = []
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/onboarding/packs')) asked.push(r.url()) })
  // the 404s a member's Home gets, and no other (welcome-notes.spec.ts says why): GET /api/demo, and the first-time
  // card's listing of a folder the member cannot open
  const missing: string[] = []
  page.on('response', (r) => { if (r.status() === 404) { const u = new URL(r.url()); missing.push(`${u.pathname}${u.search}`) } })
  await reset(page)
  await signIn(page, BOB)
  await page.goto('/skills')
  await expect(page.getByText('아직 팀 스킬이 없어요 · 팀장이나 관리자가 넣으면 여기에 보여요')).toBeVisible()
  const bring = page.getByTestId('skill-bring')
  await expect(bring).toHaveAttribute('data-role', 'member')
  await expect(page.getByTestId('skill-catalog')).toHaveCount(0)
  await expect(page.getByTestId('skill-catalog-failed')).toHaveCount(0)
  await bring.click()
  await expect(page.getByTestId('contribute-find')).toBeVisible()
  await expect(page.getByTestId('bring-sheet')).toHaveCount(0)
  // a member's page never reads the catalog
  expect(asked).toEqual([])
  const other = missing.filter((u) => u !== '/api/demo' && !/^\/api\/files\/tree\?path=finance(&|$)/.test(u))
  expect(other).toEqual([])
  expect(realErrors(errors).filter((e) => !(/status of 404/.test(e) && missing.length))).toEqual([])
})

test.describe('a phone (390 × 844, dark)', () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' })

  test('내 스킬: the rows with their one line, one line that own skills go in on a computer, the primary full width and working; Team skills says the same in one line', async ({ page }) => {
    const errors = watchConsole(page)
    await reset(page)
    await toSkillsStep(page, { profile: true })
    const packs = page.getByTestId('skill-packs')
    await expect(packs.getByTestId('skill-pack-title')).toHaveText(TITLES)
    // each row keeps its one line on a phone too
    await expect(packs.getByTestId('skill-pack-line')).toHaveCount(4)
    await expect(packRow(packs, 'card-news').getByTestId('skill-pack-line')).toHaveText('회사 소개로 정사각형 카드 5장을 만들어요')
    expect(await checks(packs)).toEqual([true, true, true, false])
    await expect(page.getByTestId('skills-phone-own')).toHaveText('쓰던 스킬은 컴퓨터에 있어요 · 컴퓨터의 팀 스킬 › 내 스킬 가져오기에서 넣어요')
    await expect(page.getByTestId('skills-find')).toHaveCount(0)
    const primary = page.getByTestId('skills-primary')
    await expect(primary).toHaveText('회사 소개서·카드뉴스·홍보 영상 넣기')
    const [p, s] = [await primary.boundingBox(), await page.getByTestId('skills-step').boundingBox()]
    expect(Math.round(p!.width)).toBe(Math.round(s!.width))
    // nothing wider than the screen
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    // the examples on a phone, dark: the tallest picture (the video's frames) fits the sheet; the text in the page's
    // own colours, as wide as the screen at most
    await packRow(packs, 'promo-video').getByTestId('skill-pack-example').click()
    const viewer = page.getByTestId('skill-example')
    await expect(viewer).toHaveAttribute('data-state', 'shown')
    const pic = (await viewer.getByTestId('skill-example-image').boundingBox())!
    expect(pic.x).toBeGreaterThanOrEqual(0)
    expect(pic.x + pic.width).toBeLessThanOrEqual(390)
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await packRow(packs, 'humanizer').getByTestId('skill-pack-example').click()
    await expect(viewer).toHaveAttribute('data-state', 'shown')
    const words = (await viewer.getByTestId('skill-example-body').boundingBox())!
    expect(words.x + words.width).toBeLessThanOrEqual(390)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await primary.click()
    await expect(page.getByTestId('toast').filter({ hasText: '스킬 3개를 팀에 넣었어요' })).toBeVisible()
    await expect(page.getByTestId('welcome-team-files')).toBeVisible()
    expect((await progress(page)).steps.skills).toBe('done')
    // Team skills on a phone: the plain line, no button
    await page.goto('/skills')
    await expect(page.getByTestId('skill-bring-phone')).toHaveText('쓰던 스킬은 컴퓨터에서 넣어요')
    await expect(page.getByTestId('skill-bring')).toHaveCount(0)
    expect(realErrors(errors)).toEqual([])
  })
})
