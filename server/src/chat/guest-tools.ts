import type { Database } from 'bun:sqlite'
import type { GuestPlace } from '@mycel/shared/api'
import { guestPlace, guestRow } from '../auth/guests'

// The tools a guest's AI turn may use besides the six file tools (docs/DECISIONS.md "Guests: only what they were
// invited to"). Deny by default: a tool not named here is never offered to a guest's turn (chat/tools.ts buildToolSet),
// so a new tool stays closed to guests until someone adds it on purpose. Reading rooms (room_read, room_file): only
// the group chat the guest was invited to, which they read in the app anyway (owner 2026-11-16: the ✦ side chat is no
// use without it); chat/room-tools.ts refuses every other room, their 1:1 chats included, by id and by name. Left out on purpose: skills (find_skills, skill, move_skill: skills/ is the team's), listing
// and searching rooms (rooms), saving a room file (save_room_file) and posting (post_to_room), project members,
// connections and every connection provider (connect_service, Drive, Google apps, MCP: connectors stay off for guests),
// plugin tools (hwp_render), schedules, the web (web_fetch, save_url), paid services (generate_video), the dev
// environment and the browser pane. The file tools themselves follow the folder policy (their project only).
export const GUEST_TURN_TOOLS: ReadonlySet<string> = new Set([
  'edit_files', 'ask_user', 'set_title', 'remember', 'forget', 'room_read', 'room_file',
  // the comments under answers in their own chat (chat/answer-comments.ts): a guest opens only their own chats
  'answer_comments',
  'make_file', 'edit_hwp', 'stamp_pdf', 'edit_pdf', 'merge_pdfs', 'split_pdf', 'resize_images', 'unzip_file', 'query_data', 'move_files', 'copy_files', 'rename_file', 'share_file', 'artifact', 'delete_files',
])

/** the room tools of GUEST_TURN_TOOLS: only for a guest whose place is a group chat (chat/tools.ts) */
export const GUEST_ROOM_TOOLS: ReadonlySet<string> = new Set(['room_read', 'room_file'])

/** A guest's places (a group chat, a project, or since the owner's 2026-11-15 rule one of each) and who invited them,
 * as a guest's turn tells the AI (chat/prompt.ts guestSection). A place's `name` null: a group chat without a name of
 * its own; `folder`: a project's folder; `inviter` null: that account is gone. */
export interface GuestPrompt { places: { kind: 'project' | 'room'; id: string; name: string | null; folder: string | null }[]; inviter: string | null }

/** The guest's places and inviter for the instructions of their turn, or null when `userId` is not a guest (no guests
 * row: no place named, and its turn still keeps to the guest tools). Reads the places from auth/guests.ts guestPlace,
 * one place or a list of them. */
export function guestPromptOf(db: Database, userId: string): GuestPrompt | null {
  const g = guestRow(db, userId)
  if (!g) return null
  const found: (GuestPlace | null)[] = [guestPlace(db, userId)].flat()
  const places = found.filter((p): p is GuestPlace => !!p).map((p) => {
    if (p.kind === 'project') {
      const r = db.query('SELECT name, folder_path FROM projects WHERE id = ? AND trashed_with IS NULL').get(p.id) as { name: string; folder_path: string } | null
      return { kind: 'project' as const, id: p.id, name: r?.name.trim() || null, folder: r?.folder_path || null }
    }
    const r = db.query("SELECT name FROM rooms WHERE id = ? AND archived_at IS NULL").get(p.id) as { name: string | null } | null
    return { kind: 'room' as const, id: p.id, name: r?.name?.trim() || null, folder: null }
  })
  const inviter = g.invited_by ? (db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(g.invited_by) as { name: string } | null)?.name ?? null : null
  return { places, inviter: inviter?.trim() || null }
}

/** Member-only parts of tool descriptions and what a guest's turn reads instead (exact pieces of the source texts in
 * tools/index.ts, chat/delete-files.ts, tools/file-moves.ts; tests/unit/b-guests-prompt.test.ts checks every guest
 * description). */
const GUEST_REWRITES: [RegExp, string][] = [
  // make_file with Hangul writing off: "an admin can turn on the Hangul plugin (Admin > Plugins, …) … ask an admin"
  [/Hangul \(\.hwp\/\.hwpx\) documents cannot be made or filled here: [^]*?offer a Word file meanwhile\. /, 'Hangul (.hwp/.hwpx) documents cannot be made or filled here: when the person asks for one, say so in one plain sentence and offer a Word file. '],
  // make_file's templates live under skills/, which a guest cannot open
  [/`template`: a [^ ]+ under skills\/ for styles\. /, ''],
  [/\bthe team drive\b/g, 'the team files'],
]
/** A sentence still about what only team members have after GUEST_REWRITES (fail closed: a new member-only sentence in
 * a description a guest gets is left out rather than read to them). */
const MEMBER_ONLY = /Admin\s*[>›]|\bplugin|connect_service|desktop app|save_url|save_room_file|team drive/i

/**
 * A tool's description for a guest's turn: the member-only parts rewritten (QA: a guest asked "can I connect apps?" and
 * was sent to Admin > Plugins), then any sentence still about Admin, plugins, connecting services, the desktop app or a
 * tool a guest does not have left out. Sentences split at ". " before a capital, a backtick or a quote.
 */
export function guestToolDescription(description: string): string {
  let d = description
  for (const [re, to] of GUEST_REWRITES) d = d.replace(re, to)
  if (!MEMBER_ONLY.test(d)) return d.trim()
  return d.split(/(?<=[.!?])\s+(?=[A-Z`"'(])/).filter((x) => !MEMBER_ONLY.test(x)).join(' ').trim()
}
