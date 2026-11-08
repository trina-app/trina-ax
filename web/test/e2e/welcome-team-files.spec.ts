// 팀 파일 in a real browser against the mock (docs/DECISIONS.md "W6"; FLOW v6 §3): [폴더 고르기] opens the folder window
// (Chrome's showDirectoryPicker, stubbed with an in-memory folder that logs every file it hands over: Playwright cannot
// drive the OS folder window), F2 looks, F3 lists with the AI's picks ticked (names and metadata only reach the AI, never
// a personal-looking file), one confirm uploads them as the step's run, F5 says where, 팀 파일 is recorded by the run.
// Leaving during F4 and coming back shows the run, never F1, and picking the same files again makes no "(1)" copy. No
// recommendation, no AI. A phone uploads hand-picked files only. The Files screen offers the same steps in a dialog.
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

type Node = { size?: number; at?: string } | { [name: string]: Node }
/** a company folder: forms, an intro, minutes, a payroll file (personal), a big video folder, things never listed */
const COMPANY = {
  '2026 견적서 양식.xlsx': { at: '2026-10-03' },
  '회사 소개서_2026.pdf': { at: '2026-09-12' },
  '회의': { '10월 주간 회의록.docx': { at: '2026-10-28' } },
  '규정': { '휴가 규정.hwp': { at: '2026-03-04' } },
  '인사': { '급여': { '2026-10.xlsx': { at: '2026-11-01' } } },
  'misc.txt': { at: '2026-01-01' },
  'big deck.pptx': { size: 60 * 1024 * 1024 },
  'video.mp4': {},
  '.git': { 'HEAD.txt': {} },
  'node_modules': { 'x.md': {} },
}
const PLAIN = { 'a.pdf': {}, 'b.docx': {}, 'c.xlsx': {} }

/** Chrome's folder window, stubbed: `window.__pick(tree)` sets what the next pick returns. */
async function stubPicker(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __tree: unknown; __handed: string[]; showDirectoryPicker: unknown; __pick: (name: string, t: unknown) => void }
    w.__handed = []
    let name = '회사 자료'
    w.__pick = (n, t) => { name = n; w.__tree = t }
    type N = { size?: number; at?: string } | { [k: string]: N }
    const isFile = (v: N) => !!v && typeof v === 'object' && Object.keys(v).every((k) => k === 'size' || k === 'at')
    const dir = (n: string, t: Record<string, N>, at: string): unknown => ({
      kind: 'directory', name: n,
      async *entries() {
        for (const [k, v] of Object.entries(t)) {
          if (isFile(v)) {
            const f = v as { size?: number; at?: string }
            yield [k, { kind: 'file', name: k, getFile: async () => {
              w.__handed.push(`${at}${k}`)
              const file = new File([`content of ${k}`], k, { lastModified: f.at ? Date.parse(f.at) : Date.parse('2026-06-01') })
              if (f.size) Object.defineProperty(file, 'size', { value: f.size })
              return file
            } }]
          } else yield [k, dir(k, v as Record<string, N>, `${at}${k}/`)]
        }
      },
    })
    w.showDirectoryPicker = async () => dir(name, w.__tree as Record<string, N>, '')
  })
}
const pick = (page: Page, name: string, tree: Record<string, Node>) => page.evaluate(([n, t]) => (window as unknown as { __pick: (n: string, t: unknown) => void }).__pick(n as string, t), [name, tree] as const)
const doc = (name: string, text = `# ${name}\n`) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })

/** 회사 소개 and 내 스킬 put off: 3/4 팀 파일 (the team's folder made by the start) */
async function toFiles(page: Page) {
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await page.getByTestId('skills-later').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
}
const tree = async (page: Page, path: string) => ((await (await page.request.get(`/api/files/tree?path=${encodeURIComponent(path)}`)).json()).entries ?? []) as { name: string; type: string }[]

test('F1 → F2 → F3 (the AI\'s picks ticked, personal apart, nothing of it sent) → one confirm → F4/F5; 팀 파일 recorded by the run; a second pick finds them "이미 있어요"', async ({ page }) => {
  const errors = watchConsole(page)
  await stubPicker(page)
  await reset(page)
  await signIn(page)
  await toFiles(page)
  // F1: the question, one primary, the hint about the folders the browser will not open, the quiet ways out
  const step = page.getByTestId('welcome-team-files')
  await expect(step.getByRole('heading', { name: '팀이 같이 볼 회사 문서를 찾아 드릴까요?' })).toBeVisible()
  await expect(page.getByTestId('welcome-team-files-pick')).toHaveText('폴더 고르기')
  await expect(page.getByTestId('welcome-team-files-hint')).toContainText('그 안의 회사 폴더를 골라 주세요')
  await expect(page.getByTestId('welcome-team-files-pick-files')).toHaveText('파일 직접 올리기')
  await expect(page.getByTestId('welcome-later')).toBeVisible()
  await expect(page.getByTestId('welcome-files-who')).toContainText('Acme')
  await pick(page, '회사 자료', COMPANY)
  await page.getByTestId('welcome-team-files-pick').click()
  // F3: the AI's picks ticked with their reason words, the personal file apart and unticked
  const list = page.getByTestId('welcome-team-files-list')
  await expect(list.getByRole('heading', { name: '팀에 올리면 좋을 파일 4개를 골랐어요' })).toBeVisible()
  await expect(list).toContainText('체크한 파일만 Acme 폴더에 올라가요.')
  const recommended = page.getByTestId('team-files-recommended').getByTestId('team-file-row')
  await expect(recommended).toHaveCount(4)
  await expect(recommended.filter({ hasText: '2026 견적서 양식.xlsx' })).toContainText('양식 · 회사 자료 ·')
  await expect(recommended.filter({ hasText: '10월 주간 회의록.docx' })).toContainText('회의록 · 회사 자료 › 회의 ·')
  for (const r of await recommended.all()) await expect(r).toHaveAttribute('data-checked', 'true')
  await expect(page.getByTestId('team-files-personal-toggle')).toHaveText('개인 정보일 수 있는 파일 1개 · 미리 고르지 않았어요')
  // never listed: the video, .git, node_modules; the 60 MB deck is only counted
  const handed = await page.evaluate(() => (window as unknown as { __handed: string[] }).__handed)
  expect(handed.filter((x) => /HEAD|node_modules|video/.test(x))).toEqual([])
  // what the AI got: names and metadata, never the personal file, never content
  const sent = (await (await page.request.get('/__test/file-rank')).json()) as { entries: { name: string; path: string }[] }[]
  expect(sent).toHaveLength(1)
  expect(sent[0]!.entries.map((e) => e.name).sort()).toEqual(['10월 주간 회의록.docx', '2026 견적서 양식.xlsx', 'misc.txt', '회사 소개서_2026.pdf', '휴가 규정.hwp'].sort())
  expect(JSON.stringify(sent)).not.toContain('content of')
  expect(Object.keys(sent[0]!.entries[0]!).sort()).toEqual(['id', 'modified', 'name', 'path', 'size', 'type'])
  // the primary names the picks; a change of ticks makes it a count
  await expect(page.getByTestId('welcome-team-files-upload')).toHaveText('추천 4개 올리기')
  await page.getByTestId('team-files-personal-toggle').click()
  const personal = page.getByTestId('team-files-personal').getByTestId('team-file-row')
  await personal.getByTestId('team-file-check').check()
  await expect(personal.getByTestId('team-file-personal-ticked')).toHaveText('Acme 모두가 봐요')
  await personal.getByTestId('team-file-check').uncheck()
  await page.getByTestId('team-files-more-toggle').click()
  await expect(page.getByTestId('team-files-more')).toContainText('misc.txt')
  await expect(page.getByTestId('team-files-too-big')).toHaveText('50MB가 넘는 파일 1개는 파일 화면에서 올려요')
  await page.getByTestId('team-files-more').getByTestId('team-file-check').check()
  await expect(page.getByTestId('welcome-team-files-upload')).toHaveText('5개 올리기')
  await page.getByTestId('team-files-more').getByTestId('team-file-check').uncheck()
  await expect(page.getByTestId('welcome-team-files-upload')).toHaveText('추천 4개 올리기')
  // ← 이전 and 다음 again: the same list, no second AI call
  await page.getByTestId('welcome-back').click()
  await expect(page.getByTestId('skills-step')).toBeVisible()
  await page.getByTestId('skills-later').click()
  await expect(page.getByTestId('welcome-team-files-list')).toBeVisible()
  expect(await (await page.request.get('/__test/file-rank')).json()).toHaveLength(1)
  // one confirm: up as a run of the file screen, each folder's own name first; F5 says where
  await page.getByTestId('welcome-team-files-upload').click()
  await expect(page.getByTestId('welcome-team-files-run-title')).toHaveText('Acme 폴더에 4개를 올렸어요')
  expect((await tree(page, 'groups/Acme/회사 자료')).map((e) => e.name).sort()).toEqual(['2026 견적서 양식.xlsx', '규정', '회사 소개서_2026.pdf', '회의'].sort())
  expect((await tree(page, 'groups/Acme/회사 자료/회의')).map((e) => e.name)).toEqual(['10월 주간 회의록.docx'])
  // the run recorded 팀 파일 done on the server (not the page's PATCH)
  expect((await (await page.request.get('/api/onboarding/welcome')).json()).progress.steps.files).toBe('done')
  await expect(page.getByTestId('welcome-team-files-next')).toHaveText('다음: 팀원 초대')
  await page.getByTestId('welcome-team-files-next').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  // back from the invite: F5 from the run in this tab; 폴더 더 고르기 with the same folder: what went up is "이미 있어요"
  await page.getByTestId('welcome-back').click()
  await expect(page.getByTestId('welcome-team-files-run-title')).toHaveText('Acme 폴더에 4개를 올렸어요')
  await page.getByTestId('welcome-team-files-more-folder').click()
  await expect(page.getByTestId('team-files-already-toggle')).toHaveText('이미 있어요 (4)')
  await expect(page.getByTestId('team-files-recommended')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('leaving during F4 and coming back shows the run, never F1; the same files again are skipped (no "(1)" copies)', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await toFiles(page)
  await page.request.post('/__test/upload-delay', { data: { ms: 1500 } })
  const files = [doc('a.md'), doc('b.md'), doc('c.md'), doc('d.md')]
  await page.getByTestId('welcome-team-files-input').setInputFiles(files)
  await expect(page.getByTestId('welcome-team-files-run')).toHaveAttribute('data-status', 'running')
  await expect(page.getByTestId('welcome-team-files-run-title')).toContainText('올리는 중 ·')
  await expect(page.getByTestId('welcome-team-files-stop-upload')).toHaveText('그만 올리기')
  // another page while it runs: the run goes on there
  await page.getByTestId('nav-files').click()
  await expect(page).toHaveURL(/\/files/)
  await page.getByTestId('setup-row-link').click()
  await expect(page).toHaveURL(/\/welcome$/)
  await expect(page.getByTestId('welcome-team-files')).toHaveAttribute('data-screen', 'run')
  await expect(page.getByTestId('welcome-team-files-pick')).toHaveCount(0)
  await expect(page.getByTestId('welcome-team-files-run-title')).toHaveText('Acme 폴더에 4개를 올렸어요', { timeout: 20_000 })
  await page.request.post('/__test/upload-delay', { data: { ms: 0 } })
  expect((await (await page.request.get('/api/onboarding/welcome')).json()).progress.steps.files).toBe('done')
  // the same files picked again on F1 (폴더 더 고르기 is the folder way; 파일 직접 올리기 lives on F1): skipped
  await page.getByTestId('welcome-team-files-input').setInputFiles(files)
  await expect(page.getByTestId('welcome-team-files-skipped')).toHaveText('이미 올린 파일 4개는 건너뛰었어요')
  expect((await tree(page, 'groups/Acme')).filter((e) => e.type === 'file').map((e) => e.name).sort()).toEqual(['a.md', 'b.md', 'c.md', 'd.md'])
  expect(realErrors(errors)).toEqual([])
})

test('0 recommendations: the line, "다른 파일도 보기" open, the primary "다른 폴더 고르기" until a tick; no AI: the same list unticked', async ({ page }) => {
  const errors = watchConsole(page)
  await stubPicker(page)
  await reset(page)
  await signIn(page)
  await toFiles(page)
  await pick(page, '잡동사니', PLAIN)
  await page.getByTestId('welcome-team-files-pick').click()
  await expect(page.getByTestId('welcome-team-files-note')).toHaveText('팀에 쓸 만한 파일을 못 골랐어요 · 직접 고르거나 다른 폴더를 골라 주세요')
  await expect(page.getByTestId('team-files-more')).toBeVisible()
  await expect(page.getByTestId('welcome-team-files-upload')).toHaveText('다른 폴더 고르기')
  await page.getByTestId('team-files-more').getByTestId('team-file-check').first().check()
  await expect(page.getByTestId('welcome-team-files-upload')).toHaveText('1개 올리기')
  // no AI: another folder, unticked, with the line
  await page.request.post('/__test/file-rank', { data: { ai: 'none' } })
  await pick(page, '회사 자료', COMPANY)
  await page.getByTestId('welcome-team-files-add-folder').click()
  await expect(page.getByTestId('welcome-team-files-note')).toHaveText('AI 없이 살펴봤어요 · 직접 골라 주세요')
  await expect(page.getByTestId('team-files-recommended')).toHaveCount(0)
  // the earlier tick stays, the new files come unticked
  await expect(page.getByTestId('welcome-team-files-upload')).toHaveText('1개 올리기')
  expect(realErrors(errors)).toEqual([])
})

test('the Files screen on a computer offers the steps in a dialog while the team folder is empty; a phone: no folders, [파일 직접 올리기] → F4/F5 → 다음', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  await toFiles(page)
  // the Files screen, the team folder with no file yet: one quiet line opens the same steps in a dialog
  await page.goto('/files')
  await expect(page.getByTestId('files-team-files-entry')).toHaveText('폴더에서 회사 문서 추천받기')
  await page.getByTestId('files-team-files-entry').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '회사 문서 추천받기' })).toBeVisible()
  await expect(dialog.getByTestId('welcome-team-files-pick')).toHaveText('폴더 고르기')
  await expect(dialog.getByTestId('welcome-later')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // a phone: the steps resume on 팀 파일, with no folder way
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/welcome')
  const step = page.getByTestId('welcome-team-files')
  await expect(step.getByRole('heading', { name: '팀이 같이 볼 회사 문서' })).toBeVisible()
  await expect(step).toContainText('휴대폰에서는 폴더째 살펴볼 수 없어요')
  await expect(page.getByTestId('welcome-team-files-pick')).toHaveCount(0)
  await expect(page.getByTestId('welcome-team-files-pick-files')).toHaveText('파일 직접 올리기')
  // nothing wider than the phone
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.getByTestId('welcome-team-files-input').setInputFiles([doc('견적 양식.md')])
  await expect(page.getByTestId('welcome-team-files-run-title')).toHaveText('Acme 폴더에 1개를 올렸어요')
  await page.getByTestId('welcome-team-files-next').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  // the team folder has a file now: no line on the Files screen
  await page.setViewportSize({ width: 1360, height: 860 })
  await page.goto('/files')
  await expect(page.getByTestId('file-table')).toBeVisible()
  await expect(page.getByTestId('files-team-files-entry')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})
