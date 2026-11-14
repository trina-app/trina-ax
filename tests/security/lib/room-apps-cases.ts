import type { Spec } from './cases'
import type { Resp } from './instance'
import type { World } from './world'

// Apps posting in rooms (docs/DECISIONS.md "Apps posting in rooms"). The world has a GitHub app in the everyone room
// (w.ids.allApp) added by the owner, and an Other app in the DM of alice and erin (w.ids.dmApp). In a team room or the
// everyone room only its owners and admins who are in it manage apps ('room-all-admins': the everyone room has
// everybody; members get 403); in a 1:1 or a group chat any of its members do (checked on the side: the owner and an
// admin get 404 there, alice and erin 200). No response but the address and the secret ones carries a token or secret.
const all = (w: World) => `/api/rooms/${w.ids.allRoom}/apps`
const one = (w: World) => `${all(w)}/${w.ids.allApp}`
const noToken = (r: Resp) => { if (/tax_in_|tax_whs_/.test(r.text)) throw new Error('a response carries an app address or secret') }
/** a fresh app for a case that uses one up (remove), added by the owner */
const fresh = async (w: World, name: string) => (await w.as.owner.ok('POST', all(w), { kind: 'other', name: `${name} ${crypto.randomUUID().slice(0, 8)}` })).app.id as string

export const ROOM_APP_SPECS: Record<string, Spec> = {
  listRoomApps: {
    build: (c, w) => c.get(all(w)), scope: 'room-all-admins',
    check: async (r, w, who) => {
      noToken(r)
      // the DM's apps: its two people, nobody else (admins included)
      const dm = await w.as[who].req('GET', `/api/rooms/${w.ids.dmRoom}/apps`)
      const inDm = who === 'memberIn' || who === 'other'
      if (who !== 'pwchange' && who !== 'anon' && dm.status !== (inDm ? 200 : 404)) throw new Error(`${who} listed the DM's apps: ${dm.status}`)
      if (dm.status === 200) noToken(dm)
    },
  },
  createRoomApp: {
    build: (c, w) => c.post(all(w), { kind: 'other', name: `Probe ${crypto.randomUUID().slice(0, 8)}` }), scope: 'room-all-admins',
    check: async (r, w, who) => {
      if (r.status !== 201) return
      // a body naming more than it should, and a person's name, are refused
      const extra = await w.as[who].req('POST', all(w), { kind: 'other', roomId: w.ids.dmRoom })
      if (extra.status !== 400) throw new Error(`a body with an extra field was taken: ${extra.status}`)
      const person = await w.as[who].req('POST', all(w), { kind: 'other', name: 'ALICE' })
      if (person.status !== 400) throw new Error(`an app took a person's name: ${person.status}`)
      // remove the probe again (the room holds at most 10)
      await w.as[who].req('DELETE', `${all(w)}/${r.json.app.id}`)
    },
  },
  getRoomAppAddress: { build: (c, w) => c.get(`${one(w)}/address`), scope: 'room-all-admins' },
  updateRoomApp: { build: (c, w) => c.patch(one(w), { quiet: false }), scope: 'room-all-admins', check: (r) => noToken(r) },
  setRoomAppSecret: { build: (c, w) => c.req('PUT', `${one(w)}/secret`, { secret: null }), scope: 'room-all-admins', check: (r) => noToken(r) },
  rotateRoomApp: { build: (c, w) => c.post(`${one(w)}/rotate`), scope: 'room-all-admins' },
  // not paused: an allowed caller passes the checks and meets 409 not_paused
  resumeRoomApp: { build: (c, w) => c.post(`${one(w)}/resume`), scope: 'room-all-admins' },
  exampleRoomApp: { build: (c, w) => c.post(`${one(w)}/example`), scope: 'room-all-admins' },
  deleteRoomApp: {
    build: async (c, w) => c.del(`${all(w)}/${await fresh(w, 'Remove')}`), scope: 'room-all-admins',
    check: async (r, w, who) => {
      // the DM's app: alice and erin may remove it, the owner and an admin are not in it (404)
      if (who === 'owner' || who === 'admin') {
        const dm = await w.as[who].req('DELETE', `/api/rooms/${w.ids.dmRoom}/apps/${w.ids.dmApp}`)
        if (dm.status !== 404) throw new Error(`${who} removed the DM's app: ${dm.status}`)
      }
      if (r.status === 204) noToken(r)
    },
  },
}
/** The public address: tests/unit/b-room-apps-inbound.test.ts and b-room-apps-perms.test.ts (unknown, rotated, removed
 * addresses the same 404; any other method 404; a browser Origin 403; signatures; size; limits; the country exemption). */
export const ROOM_APPS_RAW_COVERED = ["RAW POST '/in/:token'", "RAW ALL '/in/*'", "RAW ALL '/in'"]
