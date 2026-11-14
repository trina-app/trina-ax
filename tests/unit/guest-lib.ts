// Real guest accounts for the guest tests (docs/DECISIONS.md "Guests: only what they were invited to"): a guest invite
// made through the API by someone allowed to, accepted on the public invite page, signed in.
import type { Client, Harness } from './a-lib'

export type GuestPlace = { kind: 'room' | 'project'; id: string }
export type GuestAi = { mode: 'none' } | { mode: 'own' } | { mode: 'team'; credentialId: string; limitUsd: number }

/** `by` makes the invite (POST /api/guest-invites), a fresh browser accepts it; returns the guest's signed-in client. */
export async function addGuest(h: Harness, by: Client, o: { username: string; place: GuestPlace; ai?: GuestAi; ip?: string }): Promise<{ client: Client; id: string; password: string; token: string }> {
  const inv = await by.call('POST', '/api/guest-invites', { place: o.place, ...(o.ai ? { ai: o.ai } : {}) })
  const token = String(inv.url).split('/invite/')[1]!
  const c = h.client({ ip: o.ip ?? '10.0.0.9' })
  const password = 'guest river lamp 77'
  const r = await c.call('POST', `/api/invites/${token}/accept`, { username: o.username, name: o.username.toUpperCase(), password })
  return { client: c, id: r.me.user.id as string, password, token }
}

/** A group chat made by `by` with `others` (POST /api/rooms kind group). */
export async function groupChat(by: Client, others: string[], name = 'with a client'): Promise<string> {
  return (await by.call('POST', '/api/rooms', { kind: 'group', userIds: others, name })).id
}

/** A team project made by `by` (POST /api/projects), with `memberIds` added as people. */
export async function teamProject(by: Client, name: string): Promise<{ id: string; folder: string }> {
  const p = await by.call('POST', '/api/projects', { name, scope: 'team' })
  return { id: p.id, folder: p.folderPath ?? p.folder_path ?? p.folder }
}
