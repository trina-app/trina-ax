import { describe, expect, test } from 'bun:test'
import { cleanStatic } from '../../src/lib/artifacts'
import { classifyRef, cssUrls, FRAME_FILE_BYTES, FRAME_FILES_MAX, mediaMime, pageKey, PLACEHOLDER, resolveFrameFiles, srcsetParts, type FrameFilesOptions } from '../../src/lib/frame-files'
import { parseMini } from './mini-dom'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PNG_URL = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`

/** The team folder as the person sees it: path -> bytes; anything else fails like a 404 / 403 would. */
function team(files: Record<string, Uint8Array<ArrayBuffer> | number>) {
  const asked: string[] = []
  const fetchFile = async (p: string, max: number) => {
    asked.push(p)
    const f = files[p]
    if (f === undefined) throw new Error('not_found')
    const blob = new Blob([typeof f === 'number' ? new Uint8Array(f) : f])
    if (blob.size > max) throw new Error('too large')
    return blob
  }
  return { asked, fetchFile }
}
const run = (html: string, folder: string | null, files: Record<string, Uint8Array<ArrayBuffer> | number> = {}, o: Partial<FrameFilesOptions> = {}) => {
  const t = team(files)
  return resolveFrameFiles(html, { folder, fetchFile: t.fetchFile, parse: (s) => parseMini(s) as unknown as Document, ...o }).then((r) => ({ ...r, asked: t.asked }))
}
const srcs = (html: string, attr = 'src') => parseMini(html).querySelectorAll('*').map((e) => e.getAttribute(attr)).filter((v): v is string => v !== null)

describe('team paths of references', () => {
  test('relative to the page\'s folder, "/" from the team root, query / hash dropped, %-escapes decoded', () => {
    expect(classifyRef('images/hero.png', 'landing')).toEqual({ kind: 'team', path: 'landing/images/hero.png' })
    expect(classifyRef('./images/hero.png?v=2#x', 'landing')).toEqual({ kind: 'team', path: 'landing/images/hero.png' })
    expect(classifyRef('../logo.png', 'landing/sub')).toEqual({ kind: 'team', path: 'landing/logo.png' })
    expect(classifyRef('/brand/logo.png', 'landing/sub')).toEqual({ kind: 'team', path: 'brand/logo.png' })
    expect(classifyRef('images/hero%20one.png', 'landing')).toEqual({ kind: 'team', path: 'landing/images/hero one.png' })
    expect(classifyRef('hero.png', '')).toEqual({ kind: 'team', path: 'hero.png' })
  })
  test('a path that climbs above the team root is refused, also through %2e%2e and backslashes', () => {
    expect(classifyRef('../../x.png', 'landing')).toEqual({ kind: 'blocked' })
    expect(classifyRef('/../x.png', 'landing')).toEqual({ kind: 'blocked' })
    expect(classifyRef('%2e%2e/%2e%2e/x.png', 'landing')).toEqual({ kind: 'blocked' })
    expect(classifyRef('..\\..\\x.png', 'landing')).toEqual({ kind: 'blocked' })
    expect(classifyRef('%zz.png', 'landing')).toEqual({ kind: 'blocked' })
  })
  test('web addresses are external; other schemes are blocked; data:, blob: and #ids stay', () => {
    for (const u of ['https://cdn.example/a.png', 'HTTP://cdn.example/a.png', '//cdn.example/a.png']) expect(classifyRef(u, 'x')).toEqual({ kind: 'external' })
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y.png']) expect(classifyRef(u, 'x')).toEqual({ kind: 'blocked' })
    for (const u of [PNG_URL, 'blob:https://x/1', '#icon', '']) expect(classifyRef(u, 'x')).toEqual({ kind: 'keep' })
  })
  test('a page that is not a team file (from this computer) has no team paths', () => {
    expect(classifyRef('images/hero.png', null)).toEqual({ kind: 'blocked' })
  })
  test('srcset and CSS url() parsing', () => {
    expect(srcsetParts('a.png 1x, b c.png 2x,d.png')).toEqual([{ url: 'a.png', descriptor: '1x' }, { url: 'b', descriptor: 'c.png 2x' }, { url: 'd.png', descriptor: '' }])
    expect(srcsetParts(`${PNG_URL} 1x, x.png 480w`).map((p) => p.url)).toEqual([PNG_URL, 'x.png'])
    expect(cssUrls(`a{background:url("a.png")} b{background:url('b.png')} c{background: url( c.png )}`)).toEqual(['a.png', 'b.png', 'c.png'])
  })
  test('only images and clips by extension', () => {
    expect(mediaMime('a/b.PNG')).toBe('image/png')
    expect(mediaMime('x.jpeg')).toBe('image/jpeg')
    expect(mediaMime('x.svg')).toBe('image/svg+xml')
    expect(mediaMime('x.mp4')).toBe('video/mp4')
    expect(mediaMime('x.m4a')).toBe('audio/mp4')
    for (const p of ['x.html', 'x.md', 'x.js', 'x.pdf', 'x']) expect(mediaMime(p)).toBeNull()
  })
})

describe('resolveFrameFiles', () => {
  test('a relative image becomes a data: URL of the team file next to the page', async () => {
    const r = await run('<!doctype html><html><body><img src="images/hero.png" alt="hero"></body></html>', 'landing', { 'landing/images/hero.png': PNG })
    expect(r.asked).toEqual(['landing/images/hero.png'])
    expect(srcs(r.html)).toEqual([PNG_URL])
    expect(r.html.startsWith('<!doctype html><html>')).toBe(true)
    expect(r).toMatchObject({ external: 0, missing: 0 })
  })
  test('"../" and "/" paths; the same file named twice is fetched once', async () => {
    const r = await run('<img src="../logo.png"><img src="/brand/x.png"><img src="../logo.png?v=1">', 'site/pages', { 'site/logo.png': PNG, 'brand/x.png': PNG })
    expect(r.asked.sort()).toEqual(['brand/x.png', 'site/logo.png'])
    expect(srcs(r.html)).toEqual([PNG_URL, PNG_URL, PNG_URL])
  })
  test('a path above the team root is never fetched: placeholder, counted as missing', async () => {
    const r = await run('<img src="../../../etc/passwd.png">', 'landing', {})
    expect(r.asked).toEqual([])
    expect(srcs(r.html)).toEqual([PLACEHOLDER])
    expect(r.missing).toBe(1)
  })
  test('srcset (img and picture source); an <img> with only a srcset also gets a src a static view keeps', async () => {
    const r = await run('<picture><source srcset="w.webp 1x, w2.webp 2x"><img srcset="a.png 1x, b.png 2x"></picture>', 'p', { 'p/w.webp': PNG, 'p/w2.webp': PNG, 'p/a.png': PNG, 'p/b.png': PNG })
    const doc = parseMini(r.html)
    const [source, img] = [doc.querySelectorAll('source')[0]!, doc.querySelectorAll('img')[0]!]
    expect(srcsetParts(source.getAttribute('srcset')!).map((p) => p.descriptor)).toEqual(['1x', '2x'])
    expect(srcsetParts(source.getAttribute('srcset')!)[0]!.url).toStartWith('data:image/webp;base64,')
    expect(img.getAttribute('src')).toBe(PNG_URL)
  })
  test('CSS url() in style attributes and <style>', async () => {
    const r = await run(`<style>.hero{background:url("bg.png") no-repeat}</style><div style="background-image:url('tile.png')"></div>`, 'p', { 'p/bg.png': PNG, 'p/tile.png': PNG })
    expect(r.html).toContain(`.hero{background:url("${PNG_URL}") no-repeat}`)
    expect(parseMini(r.html).querySelectorAll('div')[0]!.getAttribute('style')).toBe(`background-image:url("${PNG_URL}")`)
  })
  test('video poster, audio / video / source src, link rel=icon, SVG image href and xlink:href', async () => {
    const files = { 'm/p.jpg': PNG, 'm/v.mp4': PNG, 'm/s.mp3': PNG, 'm/f.ico': PNG, 'm/i.png': PNG, 'm/j.png': PNG, 'm/w.webm': PNG }
    const r = await run('<link rel="shortcut icon" href="f.ico"><link rel="stylesheet" href="x.css"><video poster="p.jpg" src="v.mp4"><source src="w.webm"></video><audio src="s.mp3"></audio>' +
      '<svg viewBox="0 0 10 10"><image href="i.png"/><image xlink:href="j.png"/></svg>', 'm', files)
    expect(r.asked.sort()).toEqual(Object.keys(files).sort())
    // a stylesheet link is left alone (the frame's CSP blocks it)
    expect(r.html).toContain('href="x.css"')
    expect(r.html).toContain('data:video/mp4;base64,')
    expect(r.html).toContain('data:audio/mpeg;base64,')
    expect(r.html).toContain('data:video/webm;base64,')
    expect(r.html).toContain('data:image/x-icon;base64,')
    expect(r.html).toContain(`href="${PNG_URL}"`)
    expect(r.html).toContain(`xlink:href="${PNG_URL}"`)
    expect(r.missing).toBe(0)
  })
  test('web images stay blocked: a placeholder each, counted once per address', async () => {
    const r = await run('<img src="https://cdn.example/a.png"><img src="https://cdn.example/a.png"><img src="//cdn.example/b.png"><div style="background:url(http://x.example/c.png)"></div>', 'p')
    expect(r.asked).toEqual([])
    expect(r.external).toBe(3)
    expect(r.html).not.toContain('cdn.example')
    expect(r.html).not.toContain('x.example')
    expect(srcs(r.html)).toEqual([PLACEHOLDER, PLACEHOLDER, PLACEHOLDER])
  })
  test('other schemes become the placeholder without counting as web images', async () => {
    const r = await run('<img src="javascript:alert(1)"><img src="file:///etc/x.png">', 'p')
    expect(r).toMatchObject({ external: 0, missing: 2 })
    expect(srcs(r.html)).toEqual([PLACEHOLDER, PLACEHOLDER])
  })
  test('a file that is missing or not allowed (the fetch fails) is a placeholder', async () => {
    const r = await run('<img src="here.png"><img src="gone.png">', 'p', { 'p/here.png': PNG })
    expect(srcs(r.html)).toEqual([PNG_URL, PLACEHOLDER])
    expect(r.missing).toBe(1)
  })
  test('a team file that is not an image or clip is never fetched', async () => {
    const r = await run('<img src="notes.md"><img src="page.html"><video src="secret.pdf"></video>', 'p', { 'p/notes.md': PNG, 'p/page.html': PNG, 'p/secret.pdf': PNG })
    expect(r.asked).toEqual([])
    expect(srcs(r.html)).toEqual([PLACEHOLDER, PLACEHOLDER, PLACEHOLDER])
    expect(r.missing).toBe(3)
  })
  test(`limits: ${FRAME_FILES_MAX} files, 10 MB each, 30 MB together`, async () => {
    const many = Array.from({ length: FRAME_FILES_MAX + 3 }, (_, i) => `i${i}.png`)
    const r = await run(many.map((f) => `<img src="${f}">`).join(''), 'p', Object.fromEntries(many.map((f) => [`p/${f}`, PNG])))
    expect(r.asked.length).toBe(FRAME_FILES_MAX)
    expect(r.missing).toBe(3)
    expect(srcs(r.html).filter((s) => s === PLACEHOLDER).length).toBe(3)
    const big = await run('<img src="big.png"><img src="ok.png">', 'p', { 'p/big.png': FRAME_FILE_BYTES + 1, 'p/ok.png': PNG })
    expect(srcs(big.html)).toEqual([PLACEHOLDER, PNG_URL])
    const nine = 9 * 1024 * 1024
    const sum = await run('<img src="a.png"><img src="b.png"><img src="c.png"><img src="d.png">', 'p', { 'p/a.png': nine, 'p/b.png': nine, 'p/c.png': nine, 'p/d.png': nine }, {})
    expect(srcs(sum.html).filter((s) => s === PLACEHOLDER).length).toBe(1)
    expect(sum.missing).toBe(1)
  }, 30_000)
  test('a page with nothing to change is returned exactly as it was (no re-serializing)', async () => {
    const html = `<!DOCTYPE html>\n<p class=x>Hi &amp; <b>there</p><img src="${PNG_URL}"><svg><use href="#a"/></svg><script>if (a < b) x()</script>`
    const r = await run(html, 'p')
    expect(r.html).toBe(html)
    expect(r).toMatchObject({ external: 0, missing: 0, asked: [] })
  })
  test('a page that is not a team file: relative images are placeholders, nothing is fetched', async () => {
    const r = await run('<img src="images/hero.png">', null, { 'images/hero.png': PNG })
    expect(r.asked).toEqual([])
    expect(srcs(r.html)).toEqual([PLACEHOLDER])
  })
  test('the result survives the static view\'s cleaning (cleanStatic keeps data: src / poster and style)', async () => {
    const r = await run('<img srcset="a.png 1x"><img src="b.png"><video poster="p.jpg"></video><div style="background:url(c.png)"></div><img src="https://x.example/e.png">', 'p',
      { 'p/a.png': PNG, 'p/b.png': PNG, 'p/p.jpg': PNG, 'p/c.png': PNG })
    const doc = cleanStatic(parseMini(r.html) as unknown as Document) as unknown as ReturnType<typeof parseMini>
    const imgs = doc.querySelectorAll('img')
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([PNG_URL, PNG_URL, PLACEHOLDER])
    expect(imgs[0]!.getAttribute('srcset')).toBeNull() // dropped by cleanStatic; the src stays
    expect(doc.querySelectorAll('video')[0]!.getAttribute('poster')).toStartWith('data:image/jpeg;base64,')
    expect(doc.querySelectorAll('div')[0]!.getAttribute('style')).toContain(`url("${PNG_URL}")`)
  })
  test('stopping (the panel closed) ends the work', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(run('<img src="a.png">', 'p', { 'p/a.png': PNG }, { signal: ac.signal })).rejects.toBeDefined()
  })
})

test('pageKey: short, stable, different for different pages', () => {
  const a = '<p>a</p>'.repeat(1000)
  expect(pageKey(a)).toBe(pageKey(a))
  expect(pageKey(a)).not.toBe(pageKey(a + ' '))
  expect(pageKey(a).length).toBeLessThan(20)
})
