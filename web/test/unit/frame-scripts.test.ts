// Team script files in HTML previews and artifacts (lib/frame-scripts.ts, through lib/frame-files.ts
// resolveFrameFiles): classic scripts and ES modules from the team folder are put into the page as data: URLs, paths
// above the team root and web scripts never are, nothing is fetched for a static view, and the 5 MB script cap holds.
// The server's permission rule (embedIn) is in tests/unit/frame-embed.test.ts; the real frame in
// web/test/e2e/frame-scripts.spec.ts.
import { describe, expect, test } from 'bun:test'
import { resolveFrameFiles, type FrameFilesOptions } from '../../src/lib/frame-files'
import { classifySpecifier, FRAME_SCRIPTS_BYTES, FRAME_SCRIPTS_MAX, mapBare, missingScript, moduleKey, rewriteImports, webScript } from '../../src/lib/frame-scripts'
import { parseMini, type MiniElement } from './mini-dom'

const enc = (s: string) => new TextEncoder().encode(s)
/** The team folder as the person sees it: path -> text or a size; anything else fails like a 404 / 403 would. */
function team(files: Record<string, string | number>) {
  const asked: { path: string; max: number }[] = []
  const fetchFile = async (p: string, max: number) => {
    asked.push({ path: p, max })
    const f = files[p]
    if (f === undefined) throw new Error('not_found')
    const blob = new Blob([typeof f === 'number' ? new Uint8Array(f) : enc(f)])
    if (blob.size > max) throw new Error('too large')
    return blob
  }
  return { asked, fetchFile }
}
const run = (html: string, folder: string | null, files: Record<string, string | number> = {}, o: Partial<FrameFilesOptions> = {}) => {
  const t = team(files)
  return resolveFrameFiles(html, { folder, scripts: true, fetchFile: t.fetchFile, parse: (s) => parseMini(s) as unknown as Document, ...o })
    .then((r) => ({ ...r, asked: t.asked.map((a) => a.path), maxes: t.asked.map((a) => a.max) }))
}
const scriptsOf = (html: string) => parseMini(html).querySelectorAll('script') as MiniElement[]
/** the text of a data:text/javascript;…;base64 URL */
const dataText = (url: string) => {
  const m = /^data:text\/javascript;charset=utf-8;base64,(.*)$/s.exec(url)
  if (!m) throw new Error(`not a script data URL: ${url.slice(0, 60)}`)
  return new TextDecoder().decode(Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)))
}
const importMap = (html: string) => {
  const el = scriptsOf(html).find((s) => s.getAttribute('type') === 'importmap')
  return el ? (JSON.parse(el.textContent) as { imports: Record<string, string> }).imports : null
}

describe('classic scripts', () => {
  test('a team script next to the page becomes a data: URL of its bytes; "/" is the team root', async () => {
    const r = await run('<script src="lib/three.min.js"></script><script src="/shared/util.js" defer></script><script>window.x = THREE</script>', 'warehouse', {
      'warehouse/lib/three.min.js': 'window.THREE = { ok: 1 } // ü',
      'shared/util.js': 'window.util = 1',
    })
    const [a, b, c] = scriptsOf(r.html)
    expect(dataText(a!.getAttribute('src')!)).toBe('window.THREE = { ok: 1 } // ü')
    expect(dataText(b!.getAttribute('src')!)).toBe('window.util = 1')
    expect(b!.hasAttribute('defer')).toBe(true)
    expect(c!.textContent).toBe('window.x = THREE')
    expect(r.asked.sort()).toEqual(['shared/util.js', 'warehouse/lib/three.min.js'])
    expect(r.missingScripts).toEqual([])
    expect(r.externalScripts).toBe(0)
  })
  test('a path above the team root is never fetched: a script that throws its name, counted', async () => {
    const r = await run('<script src="../../etc/passwd.js"></script><script src="/../x.js"></script>', 'warehouse', { 'etc/passwd.js': 'x' })
    expect(r.asked).toEqual([])
    const [a, b] = scriptsOf(r.html)
    expect(a!.getAttribute('src')).toBe(missingScript('../../etc/passwd.js'))
    expect(dataText(a!.getAttribute('src')!)).toContain('Team script not loaded: ../../etc/passwd.js')
    expect(b!.getAttribute('src')).toBe(missingScript('/../x.js'))
    expect(r.missingScripts.length).toBe(2)
  })
  test('a script the person may not read (the server refuses it) is not put in, and named in the note', async () => {
    const r = await run('<script src="secret/keys.js"></script>', '', {})
    expect(r.asked).toEqual(['secret/keys.js'])
    expect(scriptsOf(r.html)[0]!.getAttribute('src')).toBe(missingScript('secret/keys.js'))
    expect(r.missingScripts).toEqual(['secret/keys.js'])
  })
  test('only .js / .mjs / .cjs files: another file is never fetched', async () => {
    const r = await run('<script src="data/notes.txt"></script><script src="page.html"></script>', '', { 'data/notes.txt': 'x', 'page.html': 'x' })
    expect(r.asked).toEqual([])
    expect(r.missingScripts.sort()).toEqual(['data/notes.txt', 'page.html'])
  })
  test('a web script becomes a script that throws its address (the frame never asks for it), counted, never fetched', async () => {
    const page = '<script src="https://cdn.jsdelivr.net/npm/three/build/three.min.js"></script><script src="//cdn.test/a.js"></script>'
    const r = await run(page, 'warehouse', {})
    expect(r.asked).toEqual([])
    expect(scriptsOf(r.html).map((s) => s.getAttribute('src'))).toEqual([webScript('https://cdn.jsdelivr.net/npm/three/build/three.min.js'), webScript('//cdn.test/a.js')])
    expect(dataText(webScript('https://x.test/a.js'))).toContain('Web script blocked in the preview: https://x.test/a.js')
    expect(r.externalScripts).toBe(2)
  })
  test('other script types (JSON data, text/babel) are left alone', async () => {
    const r = await run('<script type="application/json" src="d.js"></script><script type="text/babel" src="app.js"></script>', '', { 'd.js': '1', 'app.js': '1' })
    expect(r.asked).toEqual([])
    expect(r.html).toBe('<script type="application/json" src="d.js"></script><script type="text/babel" src="app.js"></script>')
  })
})

describe('caps', () => {
  test(`at most ${FRAME_SCRIPTS_BYTES / 1024 / 1024} MB of scripts per page: each fetch may take only what is left`, async () => {
    const half = FRAME_SCRIPTS_BYTES / 2 + 1
    const r = await run('<script src="a.js"></script><script src="b.js"></script>', '', { 'a.js': half, 'b.js': half }, { })
    // files are fetched four at a time: each may take at most what was left when it started
    expect(r.maxes.every((m) => m <= FRAME_SCRIPTS_BYTES)).toBe(true)
    const [a, b] = scriptsOf(r.html)
    expect(a!.getAttribute('src')!.startsWith('data:text/javascript;charset=utf-8;base64,')).toBe(true)
    expect(b!.getAttribute('src')).toBe(missingScript('b.js'))
    expect(r.missingScripts).toEqual(['b.js'])
  })
  test('the script cap is separate from the image caps: a page with a large picture still gets its scripts', async () => {
    const r = await run('<img src="big.png"><script src="a.js"></script>', '', { 'big.png': 20 * 1024 * 1024, 'a.js': 'ok()' })
    expect(r.missing).toBe(1)
    expect(dataText(scriptsOf(r.html)[0]!.getAttribute('src')!)).toBe('ok()')
  })
  test(`at most ${FRAME_SCRIPTS_MAX} different script files`, async () => {
    const n = FRAME_SCRIPTS_MAX + 2
    const files = Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}.js`, `x${i}`]))
    const r = await run(Array.from({ length: n }, (_, i) => `<script src="s${i}.js"></script>`).join(''), '', files)
    expect(r.asked.length).toBe(FRAME_SCRIPTS_MAX)
    expect(r.missingScripts.length).toBe(2)
  })
})

describe('modules', () => {
  const PAGE = `<html><head><script type="importmap">{"imports":{"three":"./lib/three.module.js","three/addons/":"./lib/addons/","cdn":"https://cdn.test/x.js"}}</script></head><body>
<script type="module">import * as THREE from 'three'; import { OrbitControls } from "three/addons/OrbitControls.js"; import('./lib/late.js'); const s = \`import "./not-a-file.js"\`; document.title = s</script>
<script type="module" src="lib/main.js"></script></body></html>`
  const FILES = {
    'wh/lib/three.module.js': "export * from './three.core.js'; export const REVISION = '181'",
    'wh/lib/three.core.js': 'export const Scene = class {}',
    'wh/lib/addons/OrbitControls.js': "import { Scene } from 'three'; export class OrbitControls {}",
    'wh/lib/late.js': 'export default 1',
    'wh/lib/main.js': "import { REVISION } from './three.module.js'; import x from 'cdn'; console.log(REVISION, x)",
  }
  test('every team module is behind one import map key, first in <head>; imports are rewritten; the page\'s map is gone', async () => {
    const r = await run(PAGE, 'wh', FILES)
    expect(r.asked.sort()).toEqual(Object.keys(FILES).sort())
    const map = importMap(r.html)!
    expect(Object.keys(map).sort()).toEqual(Object.keys(FILES).map(moduleKey).sort())
    // one import map, and it is the first element of <head>
    expect(scriptsOf(r.html).filter((s) => s.getAttribute('type') === 'importmap').length).toBe(1)
    const head = parseMini(r.html).querySelectorAll('head')[0]!
    expect((head.children[0] as MiniElement).getAttribute('type')).toBe('importmap')
    // relative imports inside a module resolve against that module's folder; bare ones through the page's map
    expect(dataText(map[moduleKey('wh/lib/three.module.js')]!)).toBe(`export * from '${moduleKey('wh/lib/three.core.js')}'; export const REVISION = '181'`)
    expect(dataText(map[moduleKey('wh/lib/addons/OrbitControls.js')]!)).toBe(`import { Scene } from '${moduleKey('wh/lib/three.module.js')}'; export class OrbitControls {}`)
    // a web address through the import map becomes that address (the CSP blocks it and the page says so)
    expect(dataText(map[moduleKey('wh/lib/main.js')]!)).toBe(`import { REVISION } from '${moduleKey('wh/lib/three.module.js')}'; import x from 'https://cdn.test/x.js'; console.log(REVISION, x)`)
    expect(r.externalScripts).toBe(1)
    // the inline module: static and dynamic imports rewritten, template text untouched
    const inline = scriptsOf(r.html).find((s) => s.getAttribute('type') === 'module' && s.textContent.includes('THREE'))!
    expect(inline.textContent).toBe(`import * as THREE from '${moduleKey('wh/lib/three.module.js')}'; import { OrbitControls } from "${moduleKey('wh/lib/addons/OrbitControls.js')}"; import("${moduleKey('wh/lib/late.js')}"); const s = \`import "./not-a-file.js"\`; document.title = s`)
    // a module src becomes an inline module that imports its key (one copy of main.js)
    const main = scriptsOf(r.html).find((s) => s.getAttribute('type') === 'module' && s.textContent.includes('main.js'))!
    expect(main.hasAttribute('src')).toBe(false)
    expect(main.textContent).toBe(`import ${JSON.stringify(moduleKey('wh/lib/main.js'))};`)
    expect(r.missingScripts).toEqual([])
  })
  test('a module import that climbs above the root, an unknown bare name or a missing file is not fetched / not mapped', async () => {
    const r = await run(`<script type="module">import a from '../../../x.js'; import b from 'lodash'; import c from './gone.js'</script>`, 'wh', {})
    expect(r.asked).toEqual(['wh/gone.js'])
    expect(importMap(r.html)).toBeNull()
    expect(r.missingScripts.sort()).toEqual(['../../../x.js', 'lodash', 'wh/gone.js'])
    // the missing file's import names its key (the browser's error names it); the others stay as written
    expect(scriptsOf(r.html)[0]!.textContent).toBe(`import a from '../../../x.js'; import b from 'lodash'; import c from '${moduleKey('wh/gone.js')}'`)
  })
  test('a cycle of modules works: each key is mapped once', async () => {
    const r = await run('<script type="module" src="a.js"></script>', '', { 'a.js': "import './b.js'; export const a = 1", 'b.js': "import { a } from './a.js'; export const b = 2" })
    expect(r.asked.sort()).toEqual(['a.js', 'b.js'])
    const map = importMap(r.html)!
    expect(dataText(map[moduleKey('b.js')]!)).toBe(`import { a } from '${moduleKey('a.js')}'; export const b = 2`)
  })
  test('the module key escapes each path segment (no quote or backslash in a specifier)', () => {
    expect(moduleKey('my lib/it\'s "x".js')).toBe('mycel-file:/my%20lib/it%27s%20%22x%22.js')
    expect(moduleKey('a/b.js')).toBe('mycel-file:/a/b.js')
  })
})

describe('helpers', () => {
  test('import map lookups: an exact name, else the longest "/" prefix', () => {
    const m = { three: './three.js', 'three/': './t/', 'three/addons/': './addons/' }
    expect(mapBare('three', m)).toBe('./three.js')
    expect(mapBare('three/addons/x.js', m)).toBe('./addons/x.js')
    expect(mapBare('three/src/y.js', m)).toBe('./t/src/y.js')
    expect(mapBare('react', m)).toBeNull()
  })
  test('specifiers: relative to the importing module, "/" from the root, web, data and other schemes', () => {
    expect(classifySpecifier('./b.js', 'wh/lib', 'wh', {})).toEqual({ kind: 'team', path: 'wh/lib/b.js' })
    expect(classifySpecifier('/x/b.js', 'wh/lib', 'wh', {})).toEqual({ kind: 'team', path: 'x/b.js' })
    expect(classifySpecifier('three', 'wh/lib/deep', 'wh', { three: './lib/three.js' })).toEqual({ kind: 'team', path: 'wh/lib/three.js' })
    expect(classifySpecifier('https://cdn.test/a.js', '', '', {})).toEqual({ kind: 'external' })
    expect(classifySpecifier('data:text/javascript,1', '', '', {})).toEqual({ kind: 'keep' })
    expect(classifySpecifier('mycel-file:/secret.js', '', '', {})).toEqual({ kind: 'blocked' })
  })
  test('rewriteImports: only real import specifiers, never text in strings, comments or regexes', () => {
    const src = 'import a from "./a.js"; // import "./c.js"\nconst r = /import\\("x"\\)/; const t = "import \'./d.js\'"; export * from \'./b.js\'; import.meta.url'
    expect(rewriteImports(src, (s) => `K(${s})`)).toBe('import a from "K(./a.js)"; // import "./c.js"\nconst r = /import\\("x"\\)/; const t = "import \'./d.js\'"; export * from \'K(./b.js)\'; import.meta.url')
    // not a module the lexer can read: kept as it is
    expect(rewriteImports('import {', (s) => s)).toBe('import {')
  })
})

describe('when nothing is fetched', () => {
  test('an artifact of a shared chat (withholdScripts): no team script is fetched; each is counted for the note', async () => {
    const r = await run('<script src="lib/a.js"></script><script type="module">import "./lib/b.js"</script>', '', { 'lib/a.js': 'x', 'lib/b.js': 'y' }, { withholdScripts: true })
    expect(r.asked).toEqual([])
    expect(r.withheldScripts).toBe(2)
    expect(r.missingScripts).toEqual([])
    expect(scriptsOf(r.html)[0]!.getAttribute('src')).toBe(missingScript('lib/a.js'))
    expect(importMap(r.html)).toBeNull()
  })
  test('this server\'s /vendor/ libraries stay as written (the frame\'s CSP allows them, as before)', async () => {
    const page = '<script src="/vendor/tailwind.js"></script><script src="https://team.test/vendor/mermaid.js"></script><script type="module">import m from "/vendor/mermaid.js"</script>'
    const r = await run(page, 'wh', {}, { origin: 'https://team.test' })
    expect(r.asked).toEqual([])
    expect(r.html).toBe(page)
    expect(r.externalScripts + r.missingScripts.length).toBe(0)
  })
  test('a static view (no `scripts`): scripts are not fetched or changed', async () => {
    const r = await run('<script src="a.js"></script>', '', { 'a.js': 'x' }, { scripts: false })
    expect(r.asked).toEqual([])
    expect(r.html).toBe('<script src="a.js"></script>')
  })
  test('a page that is not a team file (folder null): no relative script is fetched', async () => {
    const r = await run('<script src="a.js"></script>', null, { 'a.js': 'x' })
    expect(r.asked).toEqual([])
    expect(scriptsOf(r.html)[0]!.getAttribute('src')).toBe(missingScript('a.js'))
  })
})
