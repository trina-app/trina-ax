// Team files inside an HTML file's preview (web/src/lib/frame-files.ts, server/src/team-files/embed.ts): the preview
// asks for each image with `embedIn=<the page>`, and the server gives it only when everyone who can read the page can
// read the image too. A script in a shared page must never get the pixels of a restricted image that only the person
// looking at the page may open (a frame that runs scripts can still leak through host names: lib/artifacts.ts).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp, type Person } from '../lib/c-app'

setDefaultTimeout(30_000)

let A: CApp
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JS = Buffer.from('window.THREE = { REVISION: "181" } // ü\n')
const put = (rel: string, b: Buffer | string) => { const p = path.join(A.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b) }
const get = (as: Person, p: string, embedIn?: string) =>
  A.req(`/api/files/download?${new URLSearchParams({ path: p, disposition: 'attachment', preview: 'true', ...(embedIn !== undefined ? { embedIn } : {}) })}`, { as })

beforeAll(async () => {
  A = await makeCApp('frame-embed')
  put('groups/marketing/landing/index.html', '<img src="images/hero.png">')
  put('groups/marketing/landing/images/hero.png', PNG)
  put('groups/marketing/salaries/chart.png', PNG)
  put('projects/falcon/public/page.html', '<img src="../logo.png">')
  put('projects/falcon/logo.png', PNG)
  put('projects/falcon/page.html', '<img src="public/badge.png">')
  put('projects/falcon/public/badge.png', PNG)
  put('shared/page.html', '<img src="/users/alice/me.png">')
  put('users/alice/me.png', PNG)
  put('users/alice/page.html', '<img src="me.png">')
  // script files of a page (web/src/lib/frame-scripts.ts): the same rule as images
  put('groups/marketing/warehouse/index.html', '<script src="lib/three.min.js"></script>')
  put('groups/marketing/warehouse/lib/three.min.js', JS)
  put('groups/marketing/salaries/keys.js', JS)
  put('projects/falcon/public/app.html', '<script type="module" src="../lib/main.js"></script>')
  put('projects/falcon/lib/main.js', JS)
})
afterAll(() => A?.close())

describe('download with embedIn', () => {
  test('an image next to the page (same audience) is given, byte for byte', async () => {
    const r = await get('alice', 'groups/marketing/landing/images/hero.png', 'groups/marketing/landing/index.html')
    expect(r.status).toBe(200)
    expect(Buffer.from(await r.arrayBuffer()).equals(PNG)).toBe(true)
  })
  test('a file that more people can read than the page is fine (wider audience)', async () => {
    expect((await get('alice', 'projects/falcon/public/badge.png', 'projects/falcon/page.html')).status).toBe(200)
    // a personal page with its own image
    expect((await get('alice', 'users/alice/me.png', 'users/alice/page.html')).status).toBe(200)
  })
  test('a file some readers of the page cannot read is refused, even for a viewer who can read both', async () => {
    // carol (admin) reads everything outside users/, but marketing members cannot read salaries/
    for (const [as, file, page] of [
      ['carol', 'groups/marketing/salaries/chart.png', 'groups/marketing/landing/index.html'],
      // a page everyone reads, an image only falcon's people read
      ['alice', 'projects/falcon/logo.png', 'projects/falcon/public/page.html'],
      // a shared page, a personal image (only alice reads it)
      ['alice', 'users/alice/me.png', 'shared/page.html'],
    ] as const) {
      const r = await get(as, file, page)
      expect(r.status).toBe(403)
      const body = await r.json() as { error: { code: string; params?: { reason?: string } } }
      expect(body.error.code).toBe('forbidden')
      expect(body.error.params?.reason).toBe('embed_narrower')
    }
  })
  test('a file the viewer cannot read is not found, whatever the page; so is a page the viewer cannot read', async () => {
    expect((await get('alice', 'groups/marketing/salaries/chart.png', 'groups/marketing/landing/index.html')).status).toBe(404)
    expect((await get('bob', 'groups/marketing/landing/images/hero.png', 'groups/marketing/landing/index.html')).status).toBe(404)
    // erin reads the image (marketing) but names a page she cannot read
    expect((await get('erin', 'groups/marketing/landing/images/hero.png', 'projects/falcon/page.html')).status).toBe(404)
  })
  test('without embedIn nothing changes: the viewer\'s own access decides', async () => {
    expect((await get('carol', 'groups/marketing/salaries/chart.png')).status).toBe(200)
    expect((await get('alice', 'users/alice/me.png')).status).toBe(200)
    expect((await get('alice', 'groups/marketing/salaries/chart.png')).status).toBe(404)
  })
})

describe('download with embedIn: script files (AP-080)', () => {
  test('a library next to the page is given, byte for byte', async () => {
    const r = await get('alice', 'groups/marketing/warehouse/lib/three.min.js', 'groups/marketing/warehouse/index.html')
    expect(r.status).toBe(200)
    expect(Buffer.from(await r.arrayBuffer()).equals(JS)).toBe(true)
  })
  test('a script some readers of the page cannot read is refused (403 embed_narrower), even for a viewer who reads both', async () => {
    for (const [as, file, page] of [
      ['carol', 'groups/marketing/salaries/keys.js', 'groups/marketing/warehouse/index.html'],
      ['alice', 'projects/falcon/lib/main.js', 'projects/falcon/public/app.html'],
    ] as const) {
      const r = await get(as, file, page)
      expect(r.status).toBe(403)
      const body = await r.json() as { error: { code: string; params?: { reason?: string } } }
      expect(body.error.params?.reason).toBe('embed_narrower')
    }
  })
  test('a script the viewer cannot read is not given (404), whatever the page', async () => {
    expect((await get('alice', 'groups/marketing/salaries/keys.js', 'groups/marketing/warehouse/index.html')).status).toBe(404)
    expect((await get('bob', 'groups/marketing/warehouse/lib/three.min.js', 'groups/marketing/warehouse/index.html')).status).toBe(404)
  })
  test('a path above the team root is refused, for the file and for the page', async () => {
    for (const [file, page] of [
      ['../outside.js', 'groups/marketing/warehouse/index.html'],
      ['groups/../../outside.js', 'groups/marketing/warehouse/index.html'],
      ['/etc/hosts', 'groups/marketing/warehouse/index.html'],
      ['groups/marketing/warehouse/lib/three.min.js', '../index.html'],
    ]) {
      const r = await get('carol', file!, page)
      expect(r.status === 400 || r.status === 404).toBe(true)
    }
  })
})
