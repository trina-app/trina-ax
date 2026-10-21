// The desktop app's own language: English on a fresh install whatever the system language, a pick on the team list
// applies at once and is remembered, and the team page's language (reported over the bridge) moves the menus, the
// pane toolbar and the team list along without a reload.
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ACME, bindWindow, chrome, close, launch, newUserData, ROOT, teamPage, welcome } from './helpers'

const menuLabels = (app: Awaited<ReturnType<typeof launch>>) =>
  app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) ?? [])
/** every item of every menu (the standard Undo / Copy / Minimize ones too) */
const allMenuItems = (app: Awaited<ReturnType<typeof launch>>) =>
  app.evaluate(({ Menu }) => (Menu.getApplicationMenu()?.items ?? []).flatMap((m) => (m.submenu?.items ?? []).filter((i) => i.type !== 'separator').map((i) => i.label)))

test('fresh install on a Korean system: English; a pick on the team list applies at once and survives a restart', async () => {
  const data = newUserData(null)
  let app = await launch(data)
  try {
    const w = await welcome(app)
    await expect(w.getByRole('heading', { name: 'Enter your team address' })).toBeVisible()
    await expect(w.locator('html')).toHaveAttribute('lang', 'en')
    await expect(w.getByTestId('ui-locale')).toHaveValue('en')
    await expect(w.getByTestId('ui-locale').locator('option')).toHaveText(['English', '한국어', 'Bahasa Indonesia'])
    expect(await menuLabels(app)).toContain('View')
    // a half-typed address survives the switch (the screen redraws, it does not reload)
    await w.getByRole('textbox', { name: 'Team address' }).fill('acme.local')
    await w.getByTestId('ui-locale').selectOption('id')
    await expect(w.getByRole('heading', { name: 'Masukkan alamat tim' })).toBeVisible()
    await expect(w.locator('#address')).toHaveValue('acme.local')
    await expect.poll(() => menuLabels(app)).toContain('Tampilan')
    // the standard items carry the app's language, not the system's (no "Undo" next to "Tampilan")
    const items = await allMenuItems(app)
    expect(items).toEqual(expect.arrayContaining(['Urungkan', 'Salin', 'Tempel', 'Minimalkan', 'Perbesar']))
    expect(items).not.toContain('Undo')
    expect(items).not.toContain('Copy')
  } finally {
    await close(app)
  }
  app = await launch(data)
  try {
    await expect((await welcome(app)).locator('html')).toHaveAttribute('lang', 'id')
  } finally {
    await close(app)
  }
})

test('the team page reports its language: menus, pane toolbar and team list follow without a reload', async () => {
  const app = await launch(newUserData('en'))
  try {
    const w = await welcome(app)
    await w.getByRole('textbox', { name: 'Team address' }).fill('acme.localhost:19151')
    await w.getByRole('button', { name: 'Connect' }).click()
    const page = await bindWindow(await teamPage(app, ACME), ACME)
    const c = await chrome(app)
    await expect(c.locator('html')).toHaveAttribute('lang', 'en')
    expect(await menuLabels(app)).toContain('Team')
    // what the web app does whenever its language changes (web/src/i18n/index.ts)
    await page.evaluate(() => (window as any).mycelDesktop.setLocale('ko'))
    await expect.poll(() => menuLabels(app)).toContain('팀')
    expect(await allMenuItems(app)).toEqual(expect.arrayContaining(['실행 취소', '복사하기', '붙여넣기', '최소화']))
    await expect(c.locator('html')).toHaveAttribute('lang', 'ko')
    await expect(c.getByRole('button', { name: '새 탭' })).toHaveCount(1)
    // nonsense is ignored
    await page.evaluate(() => (window as any).mycelDesktop.setLocale('fr'))
    await page.evaluate(() => (window as any).mycelDesktop.setLocale('en'))
    await expect.poll(() => menuLabels(app)).toContain('Team')
    await expect(c.getByRole('button', { name: 'New tab' })).toHaveCount(1)
  } finally {
    await close(app)
  }
})

test('a kit build (dist/kit.json): Korean first-run screen with the team address filled in, until a team is remembered', async () => {
  const kitFile = join(ROOT, 'dist', 'kit.json')
  writeFileSync(kitFile, JSON.stringify({ team: 'exampleteam.example.com', locale: 'ko' }))
  const data = newUserData(null)
  try {
    let app = await launch(data)
    try {
      const w = await welcome(app)
      await expect(w.getByRole('heading', { name: '팀 주소를 입력하세요' })).toBeVisible()
      await expect(w.locator('#address')).toHaveValue('exampleteam.example.com')
      // the person's own edit wins over the suggestion; a team that answers is remembered as usual
      await w.locator('#address').fill('acme.localhost:19151')
      await w.getByRole('button', { name: '연결' }).click()
      await teamPage(app, ACME)
    } finally {
      await close(app)
    }
    // a remembered team: no suggestion any more (the team list is the first screen)
    app = await launch(data)
    try {
      const page = await teamPage(app, ACME)
      await page.evaluate(() => (window as any).mycelDesktop.openTeams())
      const w = await welcome(app)
      await expect(w.getByTestId('team-list')).toBeVisible()
      await expect(w.locator('#address')).toHaveValue('')
    } finally {
      await close(app)
    }
  } finally {
    rmSync(kitFile, { force: true })
  }
})
