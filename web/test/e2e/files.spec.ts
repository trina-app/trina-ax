import { expect, test, type Page, type Request } from '@playwright/test'
import { reset, signIn } from './helpers'
import { DICTS, translate } from '../../src/i18n'
import { formatDateTime } from '../../src/lib/format'
import { CSRF_HEADER, type TrashItem } from '@mycel/shared/api'

const row = (page: Page, name: string) => page.getByTestId('file-row').filter({ hasText: name })
async function rowMenu(page: Page, name: string, item: string | RegExp) {
  await row(page, name).hover()
  await row(page, name).getByTestId('file-menu').click()
  await page.getByRole('menuitem', { name: item }).click()
}

test('browse, previews (CSV, Markdown, HTML in the sandbox), conflict copies, read-only folders', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files')
  await row(page, 'marketing').getByRole('button').first().click()
  await expect(page).toHaveURL(/path=marketing/)
  await expect(row(page, 'plan (충돌 사본')).toContainText('충돌 사본')
  await row(page, 'data.csv').getByRole('button').first().click()
  await expect(page.getByTestId('file-panel').locator('table')).toContainText('beta')
  await row(page, 'plan.md').getByRole('button').first().click()
  await expect(page.getByTestId('file-panel').getByRole('heading', { name: 'Plan', exact: true })).toBeVisible()
  await row(page, 'page.html').getByRole('button').first().click()
  const frame = page.getByTestId('file-panel').locator('iframe')
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(page.frameLocator('[data-testid="file-panel"] iframe').locator('h1')).toHaveText('Hi')
  // the owner can only read finance: no upload there
  await page.goto('/files?path=finance')
  await expect(page.getByText('읽기 전용 폴더')).toBeVisible()
  await expect(page.getByTestId('upload-button')).toBeDisabled()
})

test('Markdown preview hides HTML comments on open and reopen, keeping code examples and HTML inert', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  const text = [
    '# QA weekly memo',
    '',
    'Visible before<!-- QA inline instruction --> and after.',
    '',
    '<!-- QA hidden instructions',
    'These instructions must not appear in the preview.',
    '-->',
    '',
    'Visible after the comment.',
    '',
    '`<!-- inline example -->`',
    '',
    '```html',
    '<!-- fenced example -->',
    '```',
    '',
    '<script>document.documentElement.dataset.qaExecuted = "yes"</script>',
    '',
    '<img src=x onerror="document.documentElement.dataset.qaExecuted = \'yes\'">',
  ].join('\n')
  await page.getByTestId('files-input').setInputFiles({ name: 'qa-weekly-memo.md', mimeType: 'text/markdown', buffer: Buffer.from(text) })
  const panel = page.getByTestId('file-panel')
  for (let attempt = 0; attempt < 2; attempt++) {
    await row(page, 'qa-weekly-memo.md').getByRole('button').first().click()
    await expect(panel.getByRole('heading', { name: 'QA weekly memo', exact: true })).toBeVisible()
    await expect(panel).toContainText('Visible before and after.')
    await expect(panel).toContainText('Visible after the comment.')
    await expect(panel).not.toContainText('QA inline instruction')
    await expect(panel).not.toContainText('QA hidden instructions')
    await expect(panel).not.toContainText('These instructions')
    await expect(panel.locator('code').filter({ hasText: '<!-- inline example -->' })).toBeVisible()
    await expect(panel.locator('pre')).toContainText('<!-- fenced example -->')
    await expect(panel.locator('.answer')).toContainText('<script>')
    await expect(panel.locator('.answer script, .answer img')).toHaveCount(0)
    await expect(page.locator('html')).not.toHaveAttribute('data-qa-executed')
    await panel.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(panel).toHaveCount(0)
  }
})

test('cancelling a chunked upload drops its session on the server', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  // hold the second chunk so the upload is still running when the person cancels
  await page.route(/\/api\/upload-sessions\/[^/]+\/chunks\/1$/, () => {})
  // the page asks for the second chunk once the first is stored. Waiting for that request, not 10 s of polling: the
  // page hashes the 9 MB first and sends an 8 MB chunk, which took 15-28 s on a 2-CPU Linux machine
  const second = page.waitForRequest(/\/api\/upload-sessions\/[^/]+\/chunks\/1$/, { timeout: 40_000 })
  await page.getByTestId('files-input').setInputFiles([{ name: 'cancel-me.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(9 * 1024 * 1024, 3) }])
  const list = page.getByTestId('upload-list')
  await second
  expect(((await (await page.request.post('/__test/log')).json()) as string[]).some((l) => /\/chunks\/0$/.test(l))).toBe(true)
  await list.getByRole('button', { name: '취소' }).click()
  await expect(list).toHaveCount(0)
  await expect.poll(async () => ((await (await page.request.post('/__test/log')).json()) as string[]).some((l) => /^DELETE \/api\/upload-sessions\//.test(l))).toBe(true)
})

test('a file picked while the folder is still loading is uploaded, not refused as read-only', async ({ page }) => {
  await reset(page)
  await signIn(page)
  // the folder's first listing answers late (a slow server) and the person picks a file before the table shows; the
  // upload's own reload answers first, so the late listing must not hide the new file either
  let held: Request | null = null
  let lateDone = false
  page.on('requestfinished', (r) => { if (r === held) lateDone = true })
  await page.route(/\/api\/files\/tree\?.*path=marketing/, async (route) => {
    if (!held) {
      held = route.request()
      await new Promise((r) => setTimeout(r, 2000))
    }
    await route.continue()
  })
  await page.goto('/files?path=marketing')
  await page.getByTestId('files-input').setInputFiles({ name: 'early-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('picked while loading') })
  await expect(row(page, 'early-upload.txt')).toBeVisible()
  await expect.poll(() => lateDone).toBe(true)
  await page.waitForTimeout(300) // the app handles that late answer
  await expect(row(page, 'early-upload.txt')).toBeVisible()
  await expect(page.getByText('읽기 전용 폴더')).toHaveCount(0)
})

test('upload small and chunked files, new folder, rename, trash and restore', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await page.getByTestId('files-input').setInputFiles([
    { name: 'small.txt', mimeType: 'text/plain', buffer: Buffer.from('small file') },
    { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(9 * 1024 * 1024, 7) },
  ])
  await expect(row(page, 'small.txt')).toBeVisible()
  await expect(row(page, 'big.bin')).toBeVisible({ timeout: 20_000 })
  const log = (await (await page.request.post('/__test/log')).json()) as string[]
  expect(log).toContain('POST /api/files/upload')
  expect(log.filter((l) => /^PUT \/api\/upload-sessions\/.+\/chunks\/\d$/.test(l))).toHaveLength(2)
  expect(log.some((l) => /\/complete$/.test(l))).toBe(true)

  await page.getByRole('button', { name: '새 폴더' }).click()
  await page.getByLabel('폴더 이름').fill('drafts')
  await page.getByTestId('dialog-confirm').click()
  await expect(row(page, 'drafts')).toBeVisible()

  await rowMenu(page, 'small.txt', '이름 바꾸기')
  await page.getByLabel('새 이름').fill('renamed.txt')
  await page.getByTestId('dialog-confirm').click()
  await expect(row(page, 'renamed.txt')).toBeVisible()

  await rowMenu(page, 'renamed.txt', '휴지통으로')
  await page.getByTestId('dialog-confirm').click()
  await expect(row(page, 'renamed.txt')).toHaveCount(0)
  await page.getByRole('tab', { name: '휴지통' }).click()
  await expect(page.getByTestId('trash-list')).toContainText('marketing/renamed.txt')
  await page.getByTestId('trash-list').getByRole('button', { name: '되돌리기' }).click()
  await expect(page.getByText('marketing/renamed.txt(으)로 되돌렸어요.')).toBeVisible()
})

for (const locale of ['ko', 'en', 'id'] as const) {
  test(`deletion guidance: single and bulk trash keep their saved expiry after retention changes (${locale})`, async ({ page }) => {
    const t = DICTS[locale]
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    const timeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
    const savedDates = new Map<string, string>()
    for (const days of [30, 10]) {
      await page.goto('/admin/settings')
      await page.getByLabel(t['teamSettings.trashDays'], { exact: true }).fill(String(days))
      await page.getByRole('button', { name: t['common.save'], exact: true }).click()
      await expect(page.getByText(t['common.saved'], { exact: true })).toBeVisible()
      await page.goto('/files?path=marketing')
      const names = [`retention-${days}-single.txt`, `retention-${days}-bulk-a.txt`, `retention-${days}-bulk-b.txt`]
      await page.getByTestId('files-input').setInputFiles(names.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from('retention test') })))
      for (const name of names) await expect(row(page, name)).toBeVisible()

      await rowMenu(page, names[0]!, t['files.moveToTrash'])
      await expect(page.getByRole('dialog')).toContainText(t['files.deleteBody'])
      await page.getByTestId('dialog-confirm').click()
      await expect(row(page, names[0]!)).toHaveCount(0)
      for (const name of names.slice(1)) await row(page, name).getByTestId('file-check').click()
      await page.getByTestId('bulk-delete').click()
      await expect(page.getByRole('dialog')).toContainText(t['files.deleteBody'])
      await page.getByTestId('dialog-confirm').click()
      for (const name of names) await expect(row(page, name)).toHaveCount(0)

      await page.getByRole('tab', { name: t['files.trash'], exact: true }).click()
      await expect(page.getByText(t['files.trashNote'], { exact: true })).toBeVisible()
      const response = await page.request.get('/api/files/trash')
      expect(response.ok()).toBe(true)
      const { items } = await response.json() as { items: TrashItem[] }
      expect(items).toHaveLength(days === 30 ? 3 : 6)
      for (const item of items) {
        if (savedDates.has(item.id)) {
          // The 30-day items keep their original dates after the team changes to 10 days.
          expect(item.purgeAt).toBe(savedDates.get(item.id))
        } else {
          expect(Math.abs(Date.parse(item.purgeAt) - Date.parse(item.deletedAt) - days * 86400_000)).toBeLessThan(1000)
          savedDates.set(item.id, item.purgeAt)
        }
        const entry = page.getByTestId('trash-list').getByRole('listitem').filter({ hasText: item.originalPath })
        await expect(entry).toContainText(translate(locale, 'files.purgeAt', { date: formatDateTime(item.purgeAt, locale, timeZone) }))
      }
    }
    // Returning to the original setting must not extend the newer 10-day items either.
    expect((await page.request.patch('/api/admin/settings', { headers: { [CSRF_HEADER]: '1' }, data: { trashRetentionDays: 30 } })).ok()).toBe(true)
    await page.reload()
    await page.getByRole('tab', { name: t['files.trash'], exact: true }).click()
    await expect(page.getByText(t['files.trashNote'], { exact: true })).toBeVisible()
    const { items } = await (await page.request.get('/api/files/trash')).json() as { items: TrashItem[] }
    expect(items).toHaveLength(6)
    for (const item of items) {
      expect(item.purgeAt).toBe(savedDates.get(item.id))
      await expect(page.getByTestId('trash-list').getByRole('listitem').filter({ hasText: item.originalPath }))
        .toContainText(translate(locale, 'files.purgeAt', { date: formatDateTime(item.purgeAt, locale, timeZone) }))
    }
  })

  test(`folder names: validation, recovery, rename and cancel (${locale})`, async ({ page }) => {
    const t = DICTS[locale]
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    await page.goto('/files?path=marketing')
    const dialog = page.getByRole('dialog')
    const input = dialog.getByRole('textbox')
    const confirm = dialog.getByTestId('dialog-confirm')
    const error = dialog.getByRole('alert')
    const mutations = async () => ((await (await page.request.post('/__test/log')).json()) as string[])
      .filter((line) => /^POST \/api\/files\/(mkdir|move)$/.test(line))
    const before = await mutations()

    // Both blur and Enter validate an untouched empty input. Reopening resets the feedback.
    for (const key of ['Tab', 'Enter']) {
      await page.getByRole('button', { name: t['files.newFolder'], exact: true }).click()
      await expect(input).toHaveValue('')
      await expect(input).toBeFocused()
      await expect(error).toHaveCount(0)
      await expect(confirm).toBeDisabled()
      await input.press(key)
      await expect(error).toHaveText(t['files.name.empty'])
      await expect(input).toHaveAttribute('aria-invalid', 'true')
      await expect(input).toHaveAccessibleDescription(t['files.name.empty'])
      await expect(confirm).toBeDisabled()
      await dialog.getByRole('button', { name: t['common.cancel'], exact: true }).click()
      await expect(dialog).toHaveCount(0)
    }

    await page.getByRole('button', { name: t['files.newFolder'], exact: true }).click()
    await expect(error).toHaveCount(0)
    for (const [value, message] of [
      ['   ', t['files.name.empty']],
      ['a:b', t['files.name.chars']],
      ['drafts.', t['files.name.dots']],
    ] as const) {
      await input.fill(value)
      await input.press('Enter')
      await expect(error).toHaveText(message)
      await expect(confirm).toBeDisabled()
    }
    for (const key of ['Tab', 'Enter']) {
      await input.fill('drafts')
      await expect(error).toHaveCount(0)
      await expect(confirm).toBeEnabled()
      await input.fill('')
      await expect(error).toHaveText(t['files.name.empty'])
      await input.press(key)
      await expect(error).toHaveText(t['files.name.empty'])
      await expect(confirm).toBeDisabled()
    }
    expect(await mutations()).toEqual(before)

    await input.fill('drafts')
    await expect(error).toHaveCount(0)
    await expect(input).not.toHaveAttribute('aria-invalid', 'true')
    await input.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect(row(page, 'drafts')).toBeVisible()

    await rowMenu(page, 'drafts', t['files.rename'])
    await expect(input).toHaveValue('drafts')
    await expect(error).toHaveCount(0)
    await input.fill('')
    await input.press('Enter')
    await expect(error).toHaveText(t['files.name.empty'])
    await expect(confirm).toBeDisabled()
    await input.fill('drafts-renamed')
    await expect(error).toHaveCount(0)
    await confirm.click()
    await expect(dialog).toHaveCount(0)
    await expect(row(page, 'drafts-renamed')).toBeVisible()
    const afterRename = await mutations()
    expect(afterRename.slice(before.length)).toEqual(['POST /api/files/mkdir', 'POST /api/files/move'])

    await rowMenu(page, 'drafts-renamed', t['files.rename'])
    await input.fill('cancelled-rename')
    await dialog.getByRole('button', { name: t['common.cancel'], exact: true }).click()
    await page.getByRole('button', { name: t['files.newFolder'], exact: true }).click()
    await expect(input).toHaveValue('')
    await expect(error).toHaveCount(0)
    await input.fill('cancelled-folder')
    await input.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(row(page, 'drafts-renamed')).toBeVisible()
    await expect(row(page, 'cancelled-')).toHaveCount(0)
    expect(await mutations()).toEqual(afterRename)
  })
}

test('version history with restore; start a chat with a file', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await rowMenu(page, 'plan.md', '버전 기록')
  const list = page.getByTestId('history-list')
  await expect(list).toContainText('v2')
  await expect(list).toContainText('Bob')
  await list.locator('[data-version="1"]').getByRole('button', { name: '되돌리기' }).click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByText('v1으로 되돌렸어요.')).toBeVisible()

  // a file goes into a new chat as an attached team file (a folder is still named in the prompt)
  await rowMenu(page, 'notes.txt', 'AI에게 이 파일 물어보기')
  await expect(page.locator('[data-testid="attachment-chip"][data-source="team"]')).toContainText('notes.txt')
})

test('version history: every earlier version can be restored, the newest too; one equal to now is marked; read-only files offer download only', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await rowMenu(page, 'plan.md', '버전 기록')
  const list = page.getByTestId('history-list')
  // v3 is the file as it is now: nothing to restore
  await expect(list.locator('[data-version="3"]')).toContainText('지금 내용과 같음')
  await expect(list.locator('[data-version="3"]').getByRole('button', { name: '되돌리기' })).toHaveCount(0)
  // v2 is the newest version that differs from now (before the fix only versions below the newest had the button)
  for (const v of ['1', '2']) await expect(list.locator(`[data-version="${v}"]`).getByRole('button', { name: '되돌리기' })).toBeVisible()
  await list.locator('[data-version="2"]').getByRole('button', { name: '되돌리기' }).click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByText('v2으로 되돌렸어요.')).toBeVisible()

  // finance is read-only for this person: the history shows, versions download, nothing restores
  await page.goto('/files?path=finance/2026')
  await rowMenu(page, 'q3.csv', '버전 기록')
  const ro = page.getByTestId('history-list')
  await expect(ro.locator('[data-version="1"]')).toBeVisible()
  await expect(ro.locator('[data-version="1"]').getByRole('button', { name: '내려받기' })).toBeVisible()
  await expect(ro.getByRole('button', { name: '되돌리기' })).toHaveCount(0)
})

test('files.changed from an answer refreshes the folder on screen', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await expect(row(page, 'notes.txt')).toBeVisible()
  // the same person in a second window asks the AI to write a file
  const other = await browser.newContext()
  const p2 = await other.newPage()
  await signIn(p2)
  await p2.getByTestId('composer-input').fill('write the files please')
  await p2.getByTestId('send').click()
  await expect(row(page, 'report.md')).toBeVisible()
  await other.close()
})

test('nested dialogs: Esc closes only the top one (new-folder prompt over the move picker)', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await rowMenu(page, 'notes.txt', '옮기기')
  const picker = page.getByRole('dialog', { name: '"notes.txt" 옮기기' })
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: '새 폴더' }).click()
  await expect(page.getByLabel('폴더 이름')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('폴더 이름')).toHaveCount(0)
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
})

test('fix a text file in the preview panel; a save after someone else\'s becomes a conflict copy', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await row(page, 'plan.md').getByRole('button').first().click()
  const panel = page.getByTestId('file-panel')
  await panel.getByTestId('file-edit').click()
  const editor = panel.getByTestId('file-editor')
  await expect(editor).toHaveValue(/# Plan/)
  await expect(panel.getByTestId('file-save')).toBeDisabled()

  // the same file open in a second window, edited there first
  const other = await browser.newPage()
  await signIn(other)
  await other.goto('/files?path=marketing')
  await row(other, 'plan.md').getByRole('button').first().click()
  await other.getByTestId('file-panel').getByTestId('file-edit').click()
  await other.getByTestId('file-editor').fill('# Plan\n\nfirst change\n')
  await other.getByTestId('file-save').click()
  await expect(other.getByText('저장했어요.')).toBeVisible()
  await expect(other.getByTestId('file-panel').getByRole('heading', { name: 'Plan', exact: true })).toBeVisible()
  await expect(other.getByTestId('file-panel')).toContainText('first change')
  await other.close()

  // this window still has the old text: its save keeps the other version and goes to a conflict copy
  await editor.fill('# Plan\n\nsecond change\n')
  await panel.getByTestId('file-save').click()
  await expect(page.getByText(/충돌 사본\(marketing\/plan \(충돌 사본/)).toBeVisible()
  await expect(panel.getByRole('heading', { level: 2 })).toContainText('plan (충돌 사본')
  await expect(panel).toContainText('second change')
  await page.getByRole('button', { name: '새로 고침' }).click()
  // this save's copy (the mock also has an older copy of Bob's)
  await expect(row(page, 'plan (충돌 사본 - Olga)')).toBeVisible()
})

// ---------------- several items at once (checkboxes and the selection bar) ----------------
const check = (page: Page, name: string) => row(page, name).getByTestId('file-check')
const bar = (page: Page) => page.getByTestId('bulk-bar')
const moves = async (page: Page) => ((await (await page.request.post('/__test/log')).json()) as string[]).filter((l) => l === 'POST /api/files/move').length

test('select several rows: Shift+click a range, the header selects all, Esc and another folder clear it', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  const rows = page.getByTestId('file-row')
  const boxes = page.getByTestId('file-check')
  await expect(rows).toHaveCount(5)
  await boxes.nth(0).click()
  await expect(bar(page)).toContainText('1개 선택됨')
  // the selection bar takes the breadcrumbs' place
  await expect(page.getByRole('navigation', { name: '현재 위치' })).toHaveCount(0)
  await boxes.nth(2).click({ modifiers: ['Shift'] })
  await expect(bar(page)).toContainText('3개 선택됨')
  for (const i of [0, 1, 2]) await expect(boxes.nth(i)).toBeChecked()
  for (const i of [3, 4]) await expect(boxes.nth(i)).not.toBeChecked()
  const all = page.getByTestId('select-all')
  await expect(all).toHaveJSProperty('indeterminate', true)
  await all.click()
  await expect(bar(page)).toContainText('5개 선택됨')
  await expect(all).toBeChecked()
  await all.click()
  await expect(bar(page)).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '현재 위치' })).toBeVisible()

  // the keyboard: Space checks, Shift+Space selects the range, Esc clears (the focus stays on the row)
  await boxes.nth(1).focus()
  await page.keyboard.press('Space')
  await boxes.nth(3).focus()
  await page.keyboard.press('Shift+Space')
  await expect(bar(page)).toContainText('3개 선택됨')
  for (const i of [1, 2, 3]) await expect(boxes.nth(i)).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  await expect(page.getByTestId('file-row').locator('input:checked')).toHaveCount(0)
  await expect(boxes.nth(3)).toBeFocused()
  // the clear button gives the focus to the header checkbox, not to the page
  await boxes.nth(0).click()
  await page.getByRole('button', { name: '선택 해제' }).click()
  await expect(bar(page)).toHaveCount(0)
  await expect(all).toBeFocused()

  // another folder: nothing stays selected (a navigation-only folder cannot be selected at all)
  await page.goto('/files')
  await expect(check(page, 'secret')).toBeDisabled()
  await check(page, 'docs').click()
  await expect(bar(page)).toContainText('1개 선택됨')
  await row(page, 'marketing').getByRole('button').first().click()
  await expect(page).toHaveURL(/path=marketing/)
  await expect(bar(page)).toHaveCount(0)
  await page.goBack()
  await expect(check(page, 'docs')).not.toBeChecked()
  await expect(bar(page)).toHaveCount(0)
})

test('move several files: one question for all that would become private, one toast; then share and trash them together', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  for (const name of ['notes.txt', 'data.csv', 'page.html']) await check(page, name).click()
  await expect(bar(page)).toContainText('3개 선택됨')
  const before = await moves(page)
  await bar(page).getByRole('button', { name: '옮기기' }).click()
  const picker = page.getByRole('dialog', { name: '3개 옮기기' })
  await picker.getByRole('button', { name: '팀 폴더' }).click()
  await picker.getByRole('button', { name: 'users' }).click()
  await picker.getByRole('button', { name: 'olga' }).click()
  await picker.getByTestId('folder-pick').click()
  // Bob can read marketing and not Olga's own folder: asked once for the three, with the single move's words
  const ask = page.getByRole('dialog', { name: '나만 보게 옮길까요?' })
  await expect(ask).toContainText('3개를 개인 폴더로 옮기면 1명이 더 이상 볼 수 없어요.')
  await ask.getByTestId('dialog-confirm').click()
  await expect(page.getByText('3개를 users/olga(으)로 옮겼어요.')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // three tries answered audience_narrowed, then the same three with confirm
  expect((await moves(page)) - before).toBe(6)
  for (const name of ['notes.txt', 'data.csv', 'page.html']) await expect(row(page, name)).toHaveCount(0)
  await expect(bar(page)).toHaveCount(0)

  // share them from the personal folder into docs: one dry run each, one question, three copies
  await page.goto('/files?path=users/olga')
  await page.getByTestId('select-all').click()
  await expect(bar(page)).toContainText('3개 선택됨')
  await bar(page).getByRole('button', { name: '공유(복사)' }).click()
  const sharePicker = page.getByRole('dialog', { name: '파일 3개 공유할 폴더 고르기' })
  await sharePicker.getByRole('button', { name: '팀 폴더' }).click()
  await sharePicker.getByRole('button', { name: 'docs' }).click()
  await sharePicker.getByTestId('folder-pick').click()
  const shareAsk = page.getByRole('dialog', { name: '파일 3개를 복사할까요?' })
  await expect(shareAsk).toContainText('파일 3개를 1명이 더 보게 돼요.')
  await shareAsk.getByTestId('dialog-confirm').click()
  await expect(page.getByText('파일 3개를 docs에 복사했어요.')).toBeVisible()

  // and into the trash together, with one undo
  await page.goto('/files?path=docs')
  for (const name of ['notes.txt', 'data.csv']) await check(page, name).click()
  await bar(page).getByRole('button', { name: '휴지통으로' }).click()
  await page.getByRole('dialog', { name: '2개를 휴지통으로 옮길까요?' }).getByTestId('dialog-confirm').click()
  await expect(page.getByText('2개를 휴지통으로 옮겼어요.')).toBeVisible()
  await expect(row(page, 'notes.txt')).toHaveCount(0)
  await page.getByRole('button', { name: '실행 취소' }).click()
  await expect(row(page, 'notes.txt')).toBeVisible()
  await expect(row(page, 'data.csv')).toBeVisible()
})

test('read-only items in a selection: move and trash are off and say why; share still works for files', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=finance/2026')
  await check(page, 'q3.csv').click()
  await expect(bar(page)).toContainText('읽기 전용 1개')
  await expect(page.getByTestId('bulk-move')).toBeDisabled()
  await expect(page.getByTestId('bulk-delete')).toBeDisabled()
  await expect(page.getByTestId('bulk-share')).toBeEnabled()
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('phone: checkboxes and the selection bar fit the screen', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.goto('/files?path=marketing')
    await page.getByTestId('select-all').tap()
    await expect(bar(page)).toContainText('5개 선택됨')
    for (const id of ['bulk-move', 'bulk-share', 'bulk-delete', 'bulk-clear']) await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
    const table = page.getByTestId('file-table')
    expect(await table.evaluate((t) => t.parentElement!.scrollWidth - t.parentElement!.clientWidth)).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    await check(page, 'notes.txt').tap()
    await expect(bar(page)).toContainText('4개 선택됨')
  })
})
