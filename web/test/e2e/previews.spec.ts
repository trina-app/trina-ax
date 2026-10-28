import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const open = async (page: Page, name: string) => {
  await page.getByTestId('file-row').filter({ hasText: name }).getByRole('button').first().click()
  return page.getByTestId('file-panel')
}

test.describe('media previews', () => {
  let dir: string
  const fixtures = [
    { name: 'video.webm', video: true, codecs: ['-c:v', 'libvpx-vp9', '-c:a', 'libopus'] },
    { name: 'audio.webm', video: false, codecs: ['-c:a', 'libopus'] },
    { name: 'video.mp4', video: true, codecs: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] },
    { name: 'audio.m4a', video: false, codecs: ['-c:a', 'aac'] },
  ]

  test.beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mycel-preview-media-'))
    // Synthetic, four-second red frames and a tone; requires ffmpeg with VP9/Opus and H.264/AAC encoders.
    for (const fixture of fixtures) {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        ...(fixture.video ? ['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10'] : []),
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '4', ...fixture.codecs, path.join(dir, fixture.name)], { timeout: 20_000 })
    }
  })
  test.afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  for (const fixture of fixtures) {
    test(`${fixture.name} decodes, plays, seeks and changes volume after opening and reopening`, async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      const errors = watchConsole(page)
      await signIn(page)
      await page.goto('/files?path=marketing')
      await page.getByTestId('files-input').setInputFiles(path.join(dir, fixture.name))
      for (let attempt = 0; attempt < 2; attempt++) {
        const panel = await open(page, fixture.name)
        // A video element also plays audio-only WebM without discarding video tracks in other WebMs.
        const tag = fixture.name.endsWith('.m4a') ? 'audio' : 'video'
        const media = panel.locator(tag)
        await expect(media).toBeVisible()
        await expect(panel.locator(tag === 'audio' ? 'video' : 'audio')).toHaveCount(0)
        await expect(media).toHaveJSProperty('controls', true)
        await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.readyState)).toBeGreaterThanOrEqual(2)
        await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.duration)).toBeGreaterThan(3)
        await media.evaluate((m: HTMLMediaElement) => m.play())
        await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime)).toBeGreaterThan(0.2)
        await media.evaluate((m: HTMLMediaElement) => { m.pause(); m.currentTime = 2; m.volume = 0.25 })
        await expect.poll(() => media.evaluate((m: HTMLMediaElement) => !m.seeking && m.currentTime >= 2)).toBe(true)
        await expect(media).toHaveJSProperty('volume', 0.25)
        await media.evaluate((m: HTMLMediaElement) => m.play())
        await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime)).toBeGreaterThan(2.2)
        if (fixture.video) {
          await expect(media).toHaveJSProperty('videoWidth', 160)
          await expect(media).toHaveJSProperty('videoHeight', 90)
          // Decoded frame pixels must be red, not a blank/black video rectangle or just an audio track.
          const pixel = await media.evaluate((m: HTMLVideoElement) => {
            const canvas = document.createElement('canvas')
            canvas.width = m.videoWidth
            canvas.height = m.videoHeight
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(m, 0, 0)
            return Array.from(ctx.getImageData(80, 45, 1, 1).data)
          })
          expect(pixel[0]).toBeGreaterThan(180)
          expect(pixel[1]).toBeLessThan(70)
          expect(pixel[2]).toBeLessThan(70)
        } else if (tag === 'video') {
          await expect(media).toHaveJSProperty('videoWidth', 0)
          await expect(media).toHaveJSProperty('videoHeight', 0)
        }
        await expect(media).toHaveJSProperty('error', null)
        await panel.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(panel).toHaveCount(0)
      }
      expect(realErrors(errors)).toEqual([])
    })
  }

  test('WebM above 60 MB stays download-only', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await page.goto('/files?path=marketing')
    await page.getByTestId('files-input').setInputFiles(path.join(dir, 'video.webm'))
    // Simulate an oversized Content-Length without transferring a 60 MB test file.
    await page.route('**/api/files/download?**', async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, headers: { ...response.headers(), 'content-length': String(60 * 1024 * 1024 + 1) } })
    })
    const panel = await open(page, 'video.webm')
    await expect(panel).toContainText('This file is too large to preview')
    await expect(panel.locator('audio, video')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Download', exact: true })).toBeVisible()
  })
})

// Office and PDF previews are drawn in the page under the app's CSP (no eval): any violation would show up as a
// console error here.
test('PDF, Excel, Word and PowerPoint previews render under the app CSP', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/files?path=docs')
  let panel = await open(page, 'handbook.pdf')
  await expect(panel.locator('.react-pdf__Page canvas').first()).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.textLayer')).toContainText('Company Handbook 2026')
  panel = await open(page, 'spend.xlsx')
  await expect(panel.locator('table')).toContainText('August')
  if (await page.getByTestId('file-row').filter({ hasText: 'brand.docx' }).count()) {
    panel = await open(page, 'brand.docx')
    await expect(panel.locator('.docx-wrapper')).toContainText('Primary color: mint.', { timeout: 15_000 })
    panel = await open(page, 'kickoff.pptx')
    await expect(panel).toContainText('Q4 kickoff', { timeout: 15_000 })
  }
  expect(realErrors(errors)).toEqual([])
})

// pdf.js 6 draws scanned images (CCITT fax and JBIG2, JPEG 2000) with WebAssembly decoders and text in fonts a PDF
// does not embed with CMap files, all from /assets/pdfjs-<version>/ (web/src/lib/pdfjs-assets.ts). Without them pdf.js
// only logs a warning and the page stays blank or loses its text, so this looks at the drawn pixels, the text layer
// and pdf.js's warnings about its data files, not only at console errors.
test('PDF preview draws scanned pages and Korean text in a font the file does not embed', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'warning' && /wasmUrl|cMapUrl|standardFontDataUrl|iccUrl|failed to initialize|Unable to (decode|load)|font loading|getJsModule|instantiateWasm|ICC/i.test(m.text())) warnings.push(m.text())
  })
  const failed: string[] = []
  page.on('response', (r) => {
    if (new URL(r.url()).pathname.startsWith('/assets/') && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`)
  })
  await signIn(page)
  await page.goto('/files?path=docs')
  const firstPage = (panel: Locator) => panel.locator('.react-pdf__Page canvas').first()
  // pixels clearly darker than the paper
  const ink = (panel: Locator) =>
    firstPage(panel).evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! < 450) n++
      return n
    })

  let panel = await open(page, 'quote-form.pdf')
  await expect(firstPage(panel)).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.textLayer')).toContainText('견적서 2026')
  await expect(panel.locator('.textLayer')).toContainText('공급가액 합계 1,500,000원')
  for (const name of ['scan-fax.pdf', 'scan-jpeg2000.pdf']) {
    panel = await open(page, name)
    await expect(firstPage(panel)).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => ink(panel), { message: `${name}: the scanned image is drawn`, timeout: 10_000 }).toBeGreaterThan(2000)
  }
  expect(warnings).toEqual([])
  expect(failed).toEqual([])
  expect(realErrors(errors)).toEqual([])
})

test('links inside Word and Excel previews: javascript: is not a link, web links ask first, altChunk HTML is not drawn', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  const popups: string[] = []
  page.on('popup', (p) => popups.push(p.url()))
  await signIn(page)
  await page.goto('/files?path=docs')
  await expect(page.getByTestId('file-row').filter({ hasText: 'handbook.pdf' })).toBeVisible()
  test.skip(!(await page.getByTestId('file-row').filter({ hasText: 'links.docx' }).count()), 'needs pandoc, unzip and zip')
  const title = await page.title()
  let panel = await open(page, 'links.docx')
  await expect(panel.locator('.docx-wrapper')).toContainText('evil link', { timeout: 15_000 })
  // the altChunk (an HTML part) would be an unsandboxed same-origin iframe: not drawn at all
  await expect(panel.locator('iframe')).toHaveCount(0)
  const evil = panel.locator('a', { hasText: 'evil link' })
  await expect(evil).not.toHaveAttribute('href', /.*/)
  await evil.click()
  const appLink = panel.locator('a', { hasText: 'app link' })
  await expect(appLink).not.toHaveAttribute('href', /.*/)
  const web = panel.locator('a', { hasText: 'web link' })
  await expect(web).toHaveAttribute('href', 'https://example.com/doc')
  await expect(web).toHaveAttribute('rel', 'noopener noreferrer nofollow')
  // a web link asks first; saying no opens nothing
  const asked: string[] = []
  page.once('dialog', (d) => {
    asked.push(d.message())
    void d.dismiss()
  })
  await web.click()
  await expect.poll(() => asked.length).toBe(1)
  expect(asked[0]).toContain('https://example.com/doc')

  panel = await open(page, 'links.xlsx')
  await expect(panel.locator('table')).toContainText('evil cell')
  await expect(panel.locator('a', { hasText: 'evil cell' })).not.toHaveAttribute('href', /.*/)
  await panel.locator('a', { hasText: 'evil cell' }).click()
  await expect(panel.locator('a', { hasText: 'web cell' })).toHaveAttribute('href', 'https://example.com/sheet')

  await page.waitForTimeout(300)
  expect(await page.title()).toBe(title)
  expect(popups).toEqual([])
  expect(realErrors(errors).filter((e) => !e.includes('Content Security Policy'))).toEqual([])
})
