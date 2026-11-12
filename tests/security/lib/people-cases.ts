import { CSRF_HEADER } from '@mycel/shared/api'
import { makePng } from '../../lib/images'
import type { Spec } from './cases'
import { leaks } from './matrix'

// The people directory and own profile (docs/DECISIONS.md "프로필과 사람 목록"). Every signed-in member reads the
// directory, but only names, titles, statuses and photo versions: no email, role or group. Every write acts on the
// person of the session (never one named in the request), so each persona may call it for themselves. What an upload
// must be is tested in tests/unit/a-profiles.test.ts.
const PHOTO = makePng(64, 64)
const J = (body: unknown) => ({ headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' } as Record<string, string>, raw: JSON.stringify(body) })
export const PEOPLE_SPECS: Record<string, Spec> = {
  listPeople: {
    build: c => c.get('/api/people'),
    scope: 'byLevel',
    check: (r) => {
      if (r.status !== 200) return
      if (/"(email|role|groups?|username)"/.test(r.text) || r.text.includes('@')) throw new Error('the people directory carries an email, role, group or username')
      if (leaks('anon', r.text).length) throw new Error('the people directory carries something a member may not see')
    },
  },
  // an id nobody has: members get 404, signed-out visitors 401 (a photo is for members only)
  personAvatar: { build: c => c.get('/api/people/nobody-here/avatar?v=1'), scope: 'nobody' },
  updateMyProfile: { build: c => c.req('PATCH', '/api/me/profile', undefined, J({ status: 'in a meeting' })), scope: 'self' },
  putMyAvatar: {
    build: c => c.req('PUT', '/api/me/avatar?type=image%2Fpng', undefined, { raw: PHOTO, headers: { 'content-type': 'application/octet-stream', [CSRF_HEADER]: '1' } }),
    scope: 'self',
  },
  deleteMyAvatar: { build: c => c.del('/api/me/avatar'), scope: 'self' },
  // a status message (docs/DECISIONS.md "상태 메시지"): only one's own; who sees it is the directory's audience
  // (tests/unit/b-status-message.test.ts)
  setMyStatus: { build: c => c.req('PUT', '/api/me/status', undefined, J({ emoji: '📅', text: 'In a meeting', clear: '1h' })), scope: 'self' },
  clearMyStatus: { build: c => c.del('/api/me/status'), scope: 'self' },
}
