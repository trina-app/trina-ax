// Route module "web" (component D): serving the built web app with the right headers, SPA fallback, /vendor/ for
// artifact frames, the service worker, desktop downloads, and no way out of the dist folder.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { Hono } from 'hono'
import { buildApp } from '../../server/src/app'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import type { AppEnv } from '../../server/src/http/env'
import { silentLogger } from '../../server/src/log'
import { ROUTE_MODULES } from '../../server/src/routes'
import { appCsp, safeFile, serveWeb } from '../../server/src/routes/web-static'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'd-web')
const DIST = path.join(BASE, 'dist')
const DATA = path.join(BASE, 'data')
const OUTSIDE = path.join(BASE, 'outside')

function write(p: string, s: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, s)
}

let ctx: AppContext
let app: Hono<AppEnv>
const saved = { dist: process.env.MYCEL_WEB_DIST, dl: process.env.MYCEL_DOWNLOADS_DIR }

beforeAll(async () => {
  fs.rmSync(BASE, { recursive: true, force: true })
  write(path.join(DIST, 'index.html'), '<!doctype html><title>Team AX</title><div id="root"></div>')
  write(path.join(DIST, 'assets', 'index-abc123.js'), 'console.log(1)')
  write(path.join(DIST, 'vendor', 'react.js'), 'export default {}')
  write(path.join(DIST, 'vendor', 'chunk-a1b2c3.js'), 'export const x = 1')
  write(path.join(DIST, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  write(path.join(DIST, 'manifest.webmanifest'), '{"name":"Team AX"}')
  write(path.join(DIST, '.hidden'), 'secret')
  write(path.join(OUTSIDE, 'secret.txt'), 'top secret')
  fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(DIST, 'link.txt'))
  write(path.join(DATA, 'downloads', 'index.json'), JSON.stringify({ items: [{ platform: 'mac', file: 'TeamAX.dmg', version: '0.1.0' }] }))
  write(path.join(DATA, 'downloads', 'TeamAX.dmg'), 'dmg bytes')
  process.env.MYCEL_WEB_DIST = DIST
  delete process.env.MYCEL_DOWNLOADS_DIR
  const cfg: AppConfig = {
    mode: 'prod', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [], teamRoot: path.join(BASE, 'team'), dataDir: DATA, logDir: null, logLevel: 'error',
    engine: { authMode: 'local-login' }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null }, validateResponses: true, setupToken: null,
  }
  fs.mkdirSync(cfg.teamRoot, { recursive: true })
  ctx = createContext({ config: cfg, db: openDb(path.join(DATA, 'app.db')), log: silentLogger })
  app = await buildApp(ctx, ROUTE_MODULES)
})
afterAll(async () => {
  await ctx.close()
  if (saved.dist === undefined) delete process.env.MYCEL_WEB_DIST
  else process.env.MYCEL_WEB_DIST = saved.dist
  if (saved.dl !== undefined) process.env.MYCEL_DOWNLOADS_DIR = saved.dl
})

const get = (p: string) => app.fetch(new Request('http://acme.localhost' + p), { ip: '127.0.0.1', via: 'test' })

describe('web app serving', () => {
  test('the app shell for any page, with the CSP and no-cache', async () => {
    for (const p of ['/', '/c/0192f0a0-0000-7000-8000-000000000000', '/files?path=a', '/admin/members']) {
      const r = await get(p)
      expect(r.status).toBe(200)
      expect(await r.text()).toContain('<div id="root">')
      expect(r.headers.get('cache-control')).toBe('no-cache')
      const csp = r.headers.get('content-security-policy')!
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("img-src 'self' data: blob:")
      expect(csp).toContain("connect-src 'self' blob: wss://acme.localhost ws://acme.localhost")
      expect(csp).toContain("frame-src 'self' blob:")
      expect(csp).not.toContain("'unsafe-eval'")
      expect(r.headers.get('x-frame-options')).toBe('DENY')
    }
  })
  test('hashed assets are immutable; vendor files answer CORS for opaque-origin frames', async () => {
    const a = await get('/assets/index-abc123.js')
    expect(a.headers.get('cache-control')).toContain('immutable')
    const v = await get('/vendor/react.js')
    expect(v.headers.get('access-control-allow-origin')).toBe('*')
    expect(v.headers.get('cache-control')).toBe('no-cache')
    expect(v.headers.get('content-type')).toContain('javascript')
    expect((await get('/vendor/chunk-a1b2c3.js')).headers.get('cache-control')).toContain('immutable')
  })
  test('service worker and manifest', async () => {
    const sw = await get('/sw.js')
    expect(sw.headers.get('service-worker-allowed')).toBe('/')
    expect(sw.headers.get('cache-control')).toBe('no-cache')
    expect((await get('/manifest.webmanifest')).headers.get('content-type')).toBe('application/manifest+json')
  })
  test('a missing asset is a 404, not the app shell', async () => {
    expect((await get('/assets/gone-123.js')).status).toBe(404)
    expect((await get('/vendor/nope.js')).status).toBe(404)
  })
  test('no way out of dist: dotfiles, traversal, encoded slashes, symlinks', async () => {
    for (const p of ['/.hidden', '/%2e%2e/outside/secret.txt', '/assets/..%2f..%2foutside%2fsecret.txt', '/link.txt', '/%E0%A4%A']) {
      const r = await get(p)
      expect(await r.text()).not.toContain('secret')
    }
    expect(safeFile(DIST, '/link.txt')).toBeNull()
    expect(safeFile(DIST, '/..%2Foutside/secret.txt')).toBeNull()
    expect(safeFile(DIST, '/assets/index-abc123.js')).toBe(fs.realpathSync(path.join(DIST, 'assets', 'index-abc123.js')))
  })
  test('/api stays with the API (JSON 404, not the shell)', async () => {
    const r = await get('/api/nope')
    expect(r.status).toBe(404)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })
  test('desktop downloads from <data>/downloads', async () => {
    const idx = await get('/downloads/index.json')
    expect(((await idx.json()) as { items: unknown[] }).items).toHaveLength(1)
    const dmg = await get('/downloads/TeamAX.dmg')
    expect(dmg.headers.get('content-disposition')).toBe('attachment; filename="TeamAX.dmg"')
    // the URL parser folds ".." away: this is just the app shell, never the database
    expect(await (await get('/downloads/../app.db')).text()).toContain('<div id="root">')
    expect(await (await get('/downloads/%2e%2e/app.db')).text()).not.toContain('SQLite')
    expect((await get('/downloads/..%2fapp.db')).status).toBe(404)
    expect((await get('/downloads/missing.exe')).status).toBe(404)
  })
  test('without a build: dev explains how to start the web app, prod says what is missing', () => {
    const empty = path.join(BASE, 'empty')
    fs.mkdirSync(empty, { recursive: true })
    const dev = serveWeb(new Request('http://x/'), { dist: empty, downloads: null, dev: true, devPort: 19100 })!
    expect(dev.status).toBe(200)
    const prod = serveWeb(new Request('http://x/'), { dist: empty, downloads: null, dev: false, devPort: 0 })!
    expect(prod.status).toBe(500)
    expect(serveWeb(new Request('http://x/api/me'), { dist: DIST, downloads: null, dev: false, devPort: 0 })).toBeNull()
  })
  test('the CSP never puts a hostile Host header into the policy', () => {
    expect(appCsp('evil.example; script-src *')).not.toContain('evil')
    expect(appCsp(null)).toContain("connect-src 'self' blob:;")
  })
})
