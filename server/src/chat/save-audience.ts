// Who can open a file the AI just saved, said by the server (docs/decisions/20261117-ai-save-my-files-default.md,
// QA TC-4792, MAN-026/MAN-027). In a 3-person room's side chat the AI saved notes to Company-wide (10 people) and its
// answer said "everyone in the room can open it": the answer guessed the audience from the room, not from the folder.
// Now each new file's save result ends with one line, worked out from the real folder (its rules and folder shares,
// files/share-readers.ts readersAt): only the person, the whole team, or a count; in a ✦ side chat also how many of the
// room's people can open it and how many outside the room. The AI says who can open it from this line or not at all.
import type { Database } from 'bun:sqlite'
import type { RuleSet } from '../policy/access'
import { pathAudience } from './read-scope'

/** new files a turn's notes name (a batch of saves names the first ones) */
export const AUDIENCE_FILES_MAX = 5

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`

/** The audience of one saved file, as the line says it (no names: a count, and whether it is the user alone or the
 * whole team). `room`: the side chat's room members (active ids), to say how many of them can open it. */
export function audienceWords(db: Database, rules: RuleSet, rel: string, me: string, room?: readonly string[] | null): string {
  const segs = rel.split('/').filter(Boolean)
  const a = pathAudience(db, rules, segs)
  const n = a.ids.size
  let who = n === 1 && a.ids.has(me) ? 'only the user' : a.wholeTeam ? `everyone in the team (${people(n)})` : people(n)
  if (room?.length) {
    const inRoom = room.filter((id) => a.ids.has(id)).length
    const outside = [...a.ids].filter((id) => !room.includes(id)).length
    const of = inRoom === room.length ? `all ${room.length} of the room's people` : `${inRoom} of the room's ${room.length} people`
    who += `; ${of}${outside ? `, and ${people(outside)} outside the room` : ', nobody outside the room'}`
  }
  return who
}

/**
 * The line for the files a tool call just created (`paths`, team paths; at most AUDIENCE_FILES_MAX are named), or ''.
 * A file someone shares after this (share_with_person) reaches more people: that tool's result says so.
 */
export function saveAudienceNote(db: Database, rules: RuleSet, paths: readonly string[], me: string, room?: readonly string[] | null): string {
  const list = [...new Set(paths)].slice(0, AUDIENCE_FILES_MAX)
  if (!list.length) return ''
  const parts = list.map((p) => { try { return `${p}: ${audienceWords(db, rules, p, me, room)}` } catch { return null } }).filter(Boolean)
  if (!parts.length) return ''
  return `Who can open the new file now (the server's count from its folder): ${parts.join('; ')}. When you say who can open it, say exactly this; never say that the room's people, the whole team or only the user can open it unless this line says so.`
}
