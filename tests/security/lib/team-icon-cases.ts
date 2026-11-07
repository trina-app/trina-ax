import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { CSRF_HEADER } from '@mycel/shared/api'
import { WEB_DIST_DEFAULT } from '../../../server/src/routes/web'
import { makePng } from '../../lib/images'
import type { Spec } from './cases'
import { leaks } from './matrix'

// The team logo (Admin › Team settings; docs/DECISIONS.md "Team logo as the tab icon", changed 2026-11-07). Setting and
// removing it is for admins; what an upload must be (type, first bytes, size, pixels) is tested in
// tests/unit/a-team-icon.test.ts. Reading it is public (the sidebar header's image): GET /team-icon is served by the web
// catch-all (RAW GET '*'), so an allowed upload also checks here that a signed-out visitor gets exactly the image, with
// the image-only headers, and nothing else; and that the addresses browsers take the tab and app icons from never
// serve it or link to it (they stay the product's). That part needs a web build (`bun run build:web`): without one the
// dev-mode instance answers every address with the same placeholder page, which would pass it for nothing, so it is
// skipped with a warning (no CI job runs this suite; tests/unit/a-team-icon.test.ts checks the same on a build of its own).
const LOGO = makePng(64, 64)
/** the web build the instance serves (routes/web.ts: MYCEL_WEB_DIST, else web/dist) */
const webBuilt = () => fs.existsSync(path.join(process.env[PRODUCT.envPrefix + 'WEB_DIST'] ?? WEB_DIST_DEFAULT, 'index.html'))
let warned = false
export const TEAM_ICON_SPECS: Record<string, Spec> = {
  putTeamIcon: {
    build: c => c.req('PUT', '/api/admin/team-icon?type=image%2Fpng', undefined, { raw: LOGO, headers: { 'content-type': 'application/octet-stream', [CSRF_HEADER]: '1' } }),
    scope: 'byLevel',
    check: async (r, w) => {
      if (r.status !== 200) return
      const pub = await w.as.anon.req('GET', `/team-icon?v=${r.json.version}`)
      if (pub.status !== 200 || pub.headers.get('content-type') !== 'image/png') throw new Error(`the logo is not public as an image: ${pub.status} ${pub.headers.get('content-type')}`)
      if (pub.headers.get('content-security-policy') !== "default-src 'none'; sandbox" || pub.headers.get('x-content-type-options') !== 'nosniff') throw new Error('the logo is served without its image-only headers')
      if (leaks('anon', pub.text).length || pub.headers.get('set-cookie')) throw new Error('the public logo carries something a visitor may not see')
      if (!webBuilt()) {
        if (!warned) console.warn('team-icon-cases: SKIPPED the tab and app icon checks (no web build; run `bun run build:web` first)')
        warned = true
        return
      }
      for (const [p, page] of [['/', true], ['/login', true], ['/favicon.ico', false], ['/apple-touch-icon.png', false], ['/manifest.webmanifest', false]] as const) {
        const other = await w.as.anon.req('GET', p)
        const html = other.headers.get('content-type')?.startsWith('text/html') ?? false
        if (other.status !== 200 || html !== page) throw new Error(`${p}: ${other.status} ${other.headers.get('content-type')}, expected the build's ${page ? 'page' : 'file'}`)
        if (other.text === pub.text || other.text.includes('/team-icon')) throw new Error(`${p} serves or links the team logo: the tab and app icons stay the product's`)
      }
    },
  },
  deleteTeamIcon: { build: c => c.del('/api/admin/team-icon'), scope: 'byLevel' },
}
