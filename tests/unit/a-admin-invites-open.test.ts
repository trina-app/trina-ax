// Admin › Members & invites lists only the links that still work (docs/DECISIONS.md "Admin › Members & invites lists
// only working links"): GET /api/admin/invites marks a guest link whose project went to the trash as stopped
// (place_gone), the same reason the invite page gives, so the page can leave it out; an open one stays unmarked.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

const tokenOf = (inv: { url: string }) => inv.url.split('/invite/')[1]!

test('a guest link whose project is in the trash reads as stopped (place_gone); open links do not', async () => {
  h = await harness('a-admin-invites-open')
  const owner = await withOwner(h)
  const kept = await owner.call('POST', '/api/projects', { name: 'Kept', scope: 'team' })
  const trashed = await owner.call('POST', '/api/projects', { name: 'Trashed', scope: 'team' })
  const open = await owner.call('POST', '/api/guest-invites', { place: { kind: 'project', id: kept.id }, name: 'Open Ona' })
  const gone = await owner.call('POST', '/api/guest-invites', { place: { kind: 'project', id: trashed.id }, name: 'Gone Gil' })
  await owner.call('POST', '/api/admin/invites', { role: 'member' })
  await owner.call('DELETE', `/api/projects/${trashed.id}`)
  const rows = (await owner.call('GET', '/api/admin/invites')).items as Array<{ guestName?: string; role: string; stopped?: string }>
  expect(rows.find((i) => i.guestName === 'Gone Gil')?.stopped).toBe('place_gone')
  expect(rows.find((i) => i.guestName === 'Open Ona')?.stopped).toBeUndefined()
  expect(rows.filter((i) => i.role === 'member').every((i) => i.stopped === undefined)).toBe(true)
  // the invite page refuses it for the same reason
  expect(await h.client({ ip: '10.0.0.7' }).call('GET', `/api/invites/${tokenOf(gone)}`)).toMatchObject({ valid: false, reason: 'place_gone' })
  expect(tokenOf(open)).toBeTruthy()
})
