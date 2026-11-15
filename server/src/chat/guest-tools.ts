import type { Database } from 'bun:sqlite'
import type { GuestPlace } from '@mycel/shared/api'
import { guestPlace, guestRow } from '../auth/guests'

// The tools a guest's AI turn may use besides the six file tools (docs/DECISIONS.md "Guests: only what they were
// invited to"). Deny by default: a tool not named here is never offered to a guest's turn (chat/tools.ts buildToolSet),
// so a new tool stays closed to guests until someone adds it on purpose. Left out on purpose: skills (find_skills,
// skill, move_skill: skills/ is the team's), room reading and posting (room tools, post_to_room), project members,
// connections and every connection provider (connect_service, Drive, Google apps, MCP: connectors stay off for guests),
// plugin tools (hwp_render), schedules, the web (web_fetch, save_url), paid services (generate_video), the dev
// environment and the browser pane. The file tools themselves follow the folder policy (their project only).
export const GUEST_TURN_TOOLS: ReadonlySet<string> = new Set([
  'edit_files', 'ask_user', 'set_title', 'remember', 'forget',
  'make_file', 'edit_hwp', 'move_files', 'copy_files', 'rename_file', 'share_file', 'artifact', 'delete_files',
])

/** A guest's places (a group chat, a project, or since the owner's 2026-11-15 rule one of each) and who invited them,
 * as a guest's turn tells the AI (chat/prompt.ts guestSection). A place's `name` null: a group chat without a name of
 * its own; `folder`: a project's folder; `inviter` null: that account is gone. */
export interface GuestPrompt { places: { kind: 'project' | 'room'; name: string | null; folder: string | null }[]; inviter: string | null }

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
      return { kind: 'project' as const, name: r?.name.trim() || null, folder: r?.folder_path || null }
    }
    const r = db.query("SELECT name FROM rooms WHERE id = ? AND archived_at IS NULL").get(p.id) as { name: string | null } | null
    return { kind: 'room' as const, name: r?.name?.trim() || null, folder: null }
  })
  const inviter = g.invited_by ? (db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(g.invited_by) as { name: string } | null)?.name ?? null : null
  return { places, inviter: inviter?.trim() || null }
}

/** Words in a tool's description that are about the team, not a guest's one place: Admin and plugins, team skills and
 * the skills/ folder, connecting apps, the desktop app and its browser, the team-wide folders, the web. */
const MEMBER_ONLY = /\badmin|plugin|\bskills?\b|skills\/|connect(ed|ion)? (a |an )?(service|app)|desktop app|browser|\bshared\/|\bgroups\/|team drive|web search/i

/**
 * A tool's description for a guest's turn: every sentence that talks about what only team members have (MEMBER_ONLY)
 * is left out, so the AI is never told "an admin can turn on the Hangul plugin (Admin > Plugins)" or "a template under
 * skills/" for a person who has neither (QA: a guest asked "can I connect apps?" and was sent to Admin > Plugins).
 * Fails closed: a sentence it cannot tell apart from its neighbours goes with them.
 */
export function guestToolDescription(description: string): string {
  // sentences end with ". " (or "? ", "! ") before a capital, a backtick or a quote; "e.g. " and ".docx" are not ends
  const parts = description.split(/(?<=[.!?])\s+(?=[A-Z`"'(])/)
  return parts.filter((s) => !MEMBER_ONLY.test(s)).join(' ').trim()
}
