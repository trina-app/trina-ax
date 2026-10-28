import { CSRF_HEADER } from '@mycel/shared/api'
import { makePng } from '../../lib/images'
import type { Spec } from './cases'
import { leaks } from './matrix'

// The team logo (Admin › Team settings; docs/DECISIONS.md "팀 로고"). Setting and removing it is for admins; what an
// upload must be (type, first bytes, size, pixels) is tested in tests/unit/a-team-icon.test.ts. Reading it is public
// (the sign-in page shows it): GET /team-icon is served by the web catch-all (RAW GET '*'), so an allowed upload also
// checks here that a signed-out visitor gets exactly the image, with the image-only headers, and nothing else.
const LOGO = makePng(64, 64)
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
    },
  },
  deleteTeamIcon: { build: c => c.del('/api/admin/team-icon'), scope: 'byLevel' },
}
