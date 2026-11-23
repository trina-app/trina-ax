import { CSRF_HEADER } from '@mycel/shared/api'
import { makePng } from '../../lib/images'
import type { Spec } from './cases'
import type { Client, Resp } from './instance'
import type { Who, World } from './world'

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

// An Other app's own icon (docs/decisions/20261116-other-app-icon.md): one plain Other app in the everyone room with an
// image, made once per world by the admin (allApp is GitHub, which keeps its logo; the owner's 10 adds an hour are all
// spent by the cases below), and an image on the DM's app.
const PNG = makePng(96, 96)
const putPng = (c: Client, path: string) => c.req('PUT', `${path}?type=image%2Fpng`, undefined, { raw: PNG, headers: { 'content-type': 'application/octet-stream', [CSRF_HEADER]: '1' } })
const iconApps = new WeakMap<World, Promise<{ app: string; image: string; dmImage: string }>>()
const iconApp = (w: World) => {
  let p = iconApps.get(w)
  if (!p) {
    p = (async () => {
      const app = (await w.as.admin.ok('POST', all(w), { kind: 'other', name: `Icon ${crypto.randomUUID().slice(0, 8)}` })).app.id as string
      const set = await putPng(w.as.admin, `${all(w)}/${app}/icon`)
      if (set.status !== 200) throw new Error(`the admin could not set an icon: ${set.status}`)
      const dm = await putPng(w.as.memberIn, `/api/rooms/${w.ids.dmRoom}/apps/${w.ids.dmApp}/icon`)
      if (dm.status !== 200) throw new Error(`alice could not set the DM app's icon: ${dm.status}`)
      return { app, image: set.json.icon.image as string, dmImage: dm.json.icon.image as string }
    })()
    iconApps.set(w, p)
  }
  return p
}
const iconPath = async (w: World) => `${all(w)}/${(await iconApp(w)).app}/icon`
/** the owner and an admin are not in the DM: its app's icon is not theirs to change (404) */
const dmIconDenied = (method: 'PUT' | 'PUT-emoji' | 'DELETE') => async (_r: Resp, w: World, who: Who) => {
  if (who !== 'owner' && who !== 'admin') return
  const p = `/api/rooms/${w.ids.dmRoom}/apps/${w.ids.dmApp}/icon`
  const r = method === 'PUT' ? await putPng(w.as[who], p) : method === 'PUT-emoji' ? await w.as[who].req('PUT', `${p}/emoji`, { emoji: '🔥' }) : await w.as[who].req('DELETE', p)
  if (r.status !== 404) throw new Error(`${who} changed the DM app's icon (${method}): ${r.status}`)
}
/** only a plain Other app takes an icon: 400 not_other on all three writes. GitHub is the world's app in the everyone
 * room (its owners and admins); a preset, Sentry and Google Forms are added once in the DM by alice, who manages its
 * apps (adding them in the everyone room would spend the owner's and the admin's 10 adds an hour that the cases above
 * need). */
const refusesIcon = async (c: Client, path: string, what: string) => {
  for (const r of [await putPng(c, path), await c.req('PUT', `${path}/emoji`, { emoji: '🔥' }), await c.req('DELETE', path)]) {
    if (r.status !== 400 || r.json?.error?.params?.reason !== 'not_other') throw new Error(`${what} took an icon change: ${r.status}`)
  }
}
const dmNotOther = new WeakMap<World, Promise<void>>()
const notOther = async (w: World, who: Who) => {
  if (who === 'owner' || who === 'admin') await refusesIcon(w.as[who], `${one(w)}/icon`, 'GitHub')
  if (who !== 'memberIn') return
  let p = dmNotOther.get(w)
  if (!p) {
    p = (async () => {
      const dm = `/api/rooms/${w.ids.dmRoom}/apps`
      for (const body of [{ kind: 'other', preset: 'notion' }, { kind: 'sentry' }, { kind: 'google_forms' }]) {
        const app = (await w.as.memberIn.ok('POST', dm, { ...body, name: `NotOther ${crypto.randomUUID().slice(0, 8)}` })).app.id as string
        try { await refusesIcon(w.as.memberIn, `${dm}/${app}/icon`, JSON.stringify(body)) } finally { await w.as.memberIn.req('DELETE', `${dm}/${app}`) }
      }
    })()
    dmNotOther.set(w, p)
  }
  await p
}

export const ROOM_APP_SPECS: Record<string, Spec> = {
  putRoomAppIcon: {
    build: async (c, w) => putPng(c, await iconPath(w)), scope: 'room-all-admins',
    check: async (r, w, who) => {
      noToken(r)
      await dmIconDenied('PUT')(r, w, who)
      await notOther(w, who)
    },
  },
  setRoomAppEmoji: {
    build: async (c, w) => c.req('PUT', `${await iconPath(w)}/emoji`, { emoji: '🚨' }), scope: 'room-all-admins',
    check: async (r, w, who) => {
      noToken(r)
      await dmIconDenied('PUT-emoji')(r, w, who)
      // a body naming more than the emoji (a URL for the picture, a name) is refused
      if (r.status === 200) {
        const extra = await w.as[who].req('PUT', `${await iconPath(w)}/emoji`, { emoji: '🚨', image: 'https://evil.example/x.png' })
        if (extra.status !== 400) throw new Error(`an emoji body with an extra field was taken: ${extra.status}`)
      }
    },
  },
  deleteRoomAppIcon: {
    build: async (c, w) => c.del(await iconPath(w)), scope: 'room-all-admins',
    check: async (r, w, who) => { noToken(r); await dmIconDenied('DELETE')(r, w, who) },
  },
  // the image: anyone in the room (the everyone room has everybody; a guest in a room: tests/unit/b-room-apps-icon.test.ts),
  // nobody outside it, and never under another room's id
  roomAppIcon: {
    build: async (c, w) => c.get((await iconApp(w)).image), scope: 'shared',
    check: async (r, w, who) => {
      if (who === 'pwchange' || who === 'anon') return
      if (r.status === 200 && r.headers.get('x-content-type-options') !== 'nosniff') throw new Error('the icon went out without nosniff')
      const { dmImage } = await iconApp(w)
      const inDm = who === 'memberIn' || who === 'other'
      const dm = await w.as[who].req('GET', dmImage)
      if (dm.status !== (inDm ? 200 : 404)) throw new Error(`${who} read the DM app's icon: ${dm.status}`)
      // the DM's app under the everyone room's id (which everyone is in): not there
      const moved = await w.as[who].req('GET', `${all(w)}/${w.ids.dmApp}/icon`)
      if (moved.status !== 404) throw new Error(`${who} read an app's icon under another room: ${moved.status}`)
    },
  },

  listRoomApps: {
    build: (c, w) => c.get(all(w)), scope: 'room-all-admins',
    check: async (r, w, who) => {
      noToken(r)
      // the DM's apps: its two people, nobody else (admins included)
      const dm = await w.as[who].req('GET', `/api/rooms/${w.ids.dmRoom}/apps`)
      const inDm = who === 'memberIn' || who === 'other'
      if (who !== 'pwchange' && who !== 'anon' && dm.status !== (inDm ? 200 : 404)) throw new Error(`${who} listed the DM's apps: ${dm.status}`)
      if (dm.status === 200) noToken(dm)
      // the group chat of alice, erin and frank: its members alice and erin (frank still has to change his password)
      const g = await w.as[who].req('GET', `/api/rooms/${w.ids.groupRoom}/apps`)
      if (who !== 'pwchange' && who !== 'anon' && g.status !== (inDm ? 200 : 404)) throw new Error(`${who} listed the group chat's apps: ${g.status}`)
      // someone taken out of a group chat: nothing of its apps any more, and the others are told the address is known
      if (who === 'memberIn') {
        const room = (await w.as.memberIn.ok('POST', '/api/rooms', { kind: 'group', userIds: ['erin', 'bob'] })).id
        const app = (await w.as.memberOut.ok('POST', `/api/rooms/${room}/apps`, { kind: 'other', name: `Leaver ${crypto.randomUUID().slice(0, 8)}` })).app.id
        await w.as.memberIn.ok('DELETE', `/api/rooms/${room}/members/bob`)
        for (const p of [`/api/rooms/${room}/apps`, `/api/rooms/${room}/apps/${app}/address`]) {
          const r2 = await w.as.memberOut.req('GET', p)
          if (r2.status !== 404) throw new Error(`a removed member reached ${p}: ${r2.status}`)
        }
        const after = await w.as.memberIn.ok('GET', `/api/rooms/${room}/apps`)
        if (!after.items[0]?.leaverKnows) throw new Error('the address a removed member knows is not marked')
      }
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
      // email into rooms is off by default (and this server has no mail service): an Email app is refused, 409
      const email = await w.as[who].req('POST', all(w), { kind: 'other', preset: 'email' })
      if (email.status !== 409 || !['room_email_off', 'mail_not_connected'].includes(email.json?.error?.params?.reason)) throw new Error(`an Email app was added while email is off: ${email.status}`)
      // remove the probe again (the room holds at most 10)
      await w.as[who].req('DELETE', `${all(w)}/${r.json.app.id}`)
    },
  },
  getRoomAppAddress: { build: (c, w) => c.get(`${one(w)}/address`), scope: 'room-all-admins' },
  updateRoomApp: { build: (c, w) => c.patch(one(w), { quiet: false }), scope: 'room-all-admins', check: (r) => noToken(r) },
  setRoomAppSecret: {
    build: (c, w) => c.req('PUT', `${one(w)}/secret`, { secret: null }), scope: 'room-all-admins',
    check: async (r, w, who) => {
      noToken(r)
      if (r.status !== 200) return
      // a preset whose service cannot sign (Notion; phase 4 Jira and HubSpot) takes no secret: 400 no_signing for
      // whoever may manage it (plan 20261114-1522 "Permission matrix additions"); a member gets 403 and an outsider 404
      // through the scope above
      for (const preset of ['notion', 'jira', 'hubspot']) {
        const app = (await w.as[who].ok('POST', all(w), { kind: 'other', preset, name: `${preset} ${crypto.randomUUID().slice(0, 8)}` })).app.id as string
        try {
          const s = await w.as[who].req('PUT', `${all(w)}/${app}/secret`, { generate: true })
          if (s.status !== 400 || s.json?.error?.params?.reason !== 'no_signing') throw new Error(`a no-signing preset (${preset}) took a secret: ${s.status}`)
          // the preset is fixed: a PATCH naming one is refused
          const p = await w.as[who].req('PATCH', `${all(w)}/${app}`, { preset: 'stripe' })
          if (p.status !== 400) throw new Error(`a preset was changed: ${p.status}`)
        } finally { await w.as[who].req('DELETE', `${all(w)}/${app}`) }
      }
      // the services that make their own secret (phase 4: Toss Payments, Channel Talk, PortOne) refuse one Trina makes
      for (const preset of ['toss_payments', 'channel_talk', 'portone']) {
        const app = (await w.as[who].ok('POST', all(w), { kind: 'other', preset, name: `${preset} ${crypto.randomUUID().slice(0, 8)}` })).app.id as string
        try {
          const s = await w.as[who].req('PUT', `${all(w)}/${app}/secret`, { generate: true })
          if (s.status !== 400) throw new Error(`a paste-only preset (${preset}) took a secret Trina made: ${s.status}`)
        } finally { await w.as[who].req('DELETE', `${all(w)}/${app}`) }
      }
    },
  },
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
