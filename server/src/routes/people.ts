// Route module "people" — owner: component A. The people directory, own profile and own photo
// (docs/DECISIONS.md "프로필과 사람 목록"). Contract: shared/src/api/people.ts
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { audit } from '../admin/audit'
import { fail } from '../http/errors'
import { listPeople, profileChangedFor, profileOf, readAvatar, removeAvatar, saveAvatar, updateProfile } from '../auth/profiles'

// the photo is an image only, never a document that runs anything (the same headers as the team logo)
const IMAGE_HEADERS = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline' }

export const peopleRoutes: RouteModule = {
  name: 'people',
  owner: 'A',
  register(kit, ctx) {
    // the signed-in person comes from the session, never from the request: nobody can change another person's profile
    kit.handle(API.listPeople, () => ({ people: listPeople(ctx.db) }))

    kit.handle(API.personAvatar, ({ c, params, query }) => {
      const a = readAvatar(ctx.db, params.id) ?? fail('not_found')
      const etag = `"${a.version}"`
      // the current version in the address: cached for good; anything else only briefly (it would show an old photo)
      const cache = query.v === String(a.version) ? 'private, max-age=31536000, immutable' : 'private, max-age=0, must-revalidate'
      const headers = { ...IMAGE_HEADERS, 'content-type': a.type, 'cache-control': cache, etag }
      if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers })
      return new Response(a.bytes as Uint8Array<ArrayBuffer>, { headers })
    })

    kit.handle(API.updateMyProfile, ({ body, auth }) => {
      const changes = updateProfile(ctx.db, auth.user.id, body)
      if (Object.keys(changes).length) {
        audit(ctx.db, { actor: auth.user.id, action: 'profile.update', target: auth.user.id, detail: { fields: Object.keys(changes), ...(changes.name ? { name: changes.name } : {}) } })
        ctx.services.realtime.publishEach(profileChangedFor(auth.user.id))
      }
      const name = (ctx.db.query('SELECT name FROM users WHERE id = ?').get(auth.user.id) as { name: string }).name
      return { id: auth.user.id, name, ...profileOf(ctx.db, auth.user.id) }
    })

    kit.handle(API.putMyAvatar, async ({ c, query, body, auth }) => {
      const r = await saveAvatar(ctx.db, auth.user.id, body, query.type, c.get('locale'))
      audit(ctx.db, { actor: auth.user.id, action: 'profile.avatar_set', target: auth.user.id, detail: { size: r.size, before: r.before } })
      ctx.services.realtime.publishEach(profileChangedFor(auth.user.id))
      return { avatarVersion: r.version }
    })

    kit.handle(API.deleteMyAvatar, ({ auth }) => {
      const before = removeAvatar(ctx.db, auth.user.id)
      if (before === null) return
      audit(ctx.db, { actor: auth.user.id, action: 'profile.avatar_remove', target: auth.user.id, detail: { before } })
      ctx.services.realtime.publishEach(profileChangedFor(auth.user.id))
    })
  },
}
