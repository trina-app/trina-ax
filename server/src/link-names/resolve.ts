// Named app links (docs/decisions/20261118-named-app-links.md; the contract: shared/src/api/link-names.ts). A link to
// something in this app pasted into a message shows that thing's name, decided here for the caller on every ask, with
// the check the thing's own page makes, never a weaker one:
//   - chat (/c/<id>):          chatFor(…, 'view') as GET /api/chats/:id, without deleted chats; the title as that page
//                              shows it (a stored connection secret hidden, as chatView does)
//   - project (/projects/<id>): canSeeProject as GET /api/projects/:id without ?manage (members of its folder only;
//                              an admin who only manages it gets no name)
//   - room (/rooms/<id>):      a member row of a room that is not archived, a DM still open to its two (dmPairOk), as
//                              GET /api/rooms/:id; named as the rooms list names it to them (roomNaming)
//   - share (/f/<token>):      the file link's own open() as its page (GET /api/files/shared/:id): a name only when it
//                              opens for the caller today (a live link, its file in place, by the folder rules or a grant
//                              while its owner still edits it; never for a guest; a dead, trashed or stale link: none).
//                              open() changes nothing (the page's markRead is not called here)
//   - folder / file (/files?path=, /files/view?path=): authorize() as the Files screen ('list' for a folder as the
//                              tree, 'read' for a regular file as the preview), and never a hidden name
// Everything else (no access, not there, a malformed id, a check that throws) is `name: null`: the same answer, so a link
// tells nothing about what the caller cannot open. Only a name is returned, cut to LINK_NAME_MAX, control characters
// out; never a path. Nothing here is logged with a name or a path.
import { LINK_NAME_MAX, type LinkName, type LinkNameRef, type RoomKind, type UserRef } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { chatFor } from '../chat/shared'
import { canSeeProject } from '../chat/projects'
import { getChatRuntime, type ChatRuntime } from '../chat/runtime'
import { fileSharesOf } from '../files/shares'
import { redactorFor } from '../integrations/connections/redact'
import { authorize } from '../policy/authorize'
import { loadPrincipal, type Principal } from '../policy/access'
import { badSegment, hiddenEntry } from '../policy/names'
import { dmPairOk } from '../rooms/guest-reach'
import { memberRow, roomNaming, roomRow } from '../rooms/store'
import { componentC } from '../team-files/component'

/** A name as plain text: one line, no control or bidi-override characters, at most LINK_NAME_MAX characters (never half
 * an emoji at the cut). An empty name stays empty (an untitled chat: the client says "chat"). */
export function cleanName(s: string): string {
  // eslint-disable-next-line no-control-regex
  const one = s.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (one.length <= LINK_NAME_MAX) return one
  return one.slice(0, LINK_NAME_MAX).replace(/[\ud800-\udbff]$/, '') + '…'
}

/** What one viewer's batch shares: their account, the chat runtime and the folder rules, each read once when needed. */
interface Viewer {
  id: string
  me: Principal | null
  rt: () => ChatRuntime | null
}

type Named = Pick<LinkName, 'name' | 'folder' | 'room'>
const NONE: Named = { name: null }

function chatName(v: Viewer, id: string): Named {
  const rt = v.rt()
  if (!rt) return NONE
  // the chat page's own check ('view', deleted chats left out: a link to one in the trash is not a link to open)
  const a = chatFor(rt, v.id, id, 'view')
  return { name: cleanName(redactorFor(rt.ctx, a.row.user_id).hide(a.row.title ?? '')) }
}

function projectName(ctx: AppContext, v: Viewer, id: string): Named {
  const rt = v.rt()
  if (!rt || !v.me) return NONE
  const r = rt.store.projectRow(id)
  if (!r || !canSeeProject(ctx.files, v.me, r)) return NONE
  return { name: cleanName(r.name) }
}

function roomName(ctx: AppContext, v: Viewer, id: string): Named {
  const room = roomRow(ctx.db, id)
  if (!room || room.archived_at) return NONE
  if (!memberRow(ctx.db, id, v.id)) return NONE
  if (!dmPairOk(ctx.db, room.kind, room.dm_key)) return NONE
  const n = roomNaming(ctx.db, room, v.id)
  const name = n.name === null ? null : cleanName(n.name)
  const peers: UserRef[] = n.peers.map((p) => ({ id: p.id, name: cleanName(p.name) }))
  return { name: name ?? '', room: { kind: room.kind as RoomKind, name, peers, memberCount: n.memberCount } }
}

function shareName(ctx: AppContext, v: Viewer, token: string): Named {
  // a file link's id (files/shares.ts): 22 URL-safe characters; anything else is not one
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) return NONE
  const o = fileSharesOf(ctx).open(v.id, token)
  if (o.kind === 'open') return { name: cleanName(o.name) }
  if (o.kind === 'folder') return { name: cleanName(o.name), folder: true }
  return NONE
}

function filesName(ctx: AppContext, v: Viewer, rel: string, folder: boolean): Named {
  if (!v.me) return NONE
  const segs = rel.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  // the team folder itself has no name of its own; a hidden or impossible name is never shown
  if (!segs.length || segs.some((s, i) => badSegment(s) || hiddenEntry(s, i))) return NONE
  const tf = componentC(ctx).files
  const r = authorize(tf.fx, tf.rules(), v.me, segs.join('/'), folder ? 'list' : 'read')
  const st = r.st
  if (!st || (folder ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) return NONE
  const name = r.segs[r.segs.length - 1]
  return name ? { name: cleanName(name) } : NONE
}

/** The names of `links` for `userId`: one answer per distinct link, in the order first asked. */
export function linkNames(ctx: AppContext, userId: string, links: readonly LinkNameRef[]): LinkName[] {
  let rt: ChatRuntime | null | undefined
  const v: Viewer = {
    id: userId,
    me: loadPrincipal(ctx.db, userId),
    rt: () => {
      if (rt === undefined) { try { rt = getChatRuntime(ctx) } catch { rt = null } }
      return rt
    },
  }
  const seen = new Set<string>()
  const out: LinkName[] = []
  for (const l of links) {
    const key = `${l.kind}\u0000${l.id}`
    if (seen.has(key)) continue
    seen.add(key)
    let named: Named = NONE
    // an inactive account names nothing; every check that refuses (or throws: not found, no access, a bad id) is none
    if (v.me) {
      try {
        switch (l.kind) {
          case 'chat': named = chatName(v, l.id); break
          case 'project': named = projectName(ctx, v, l.id); break
          case 'room': named = roomName(ctx, v, l.id); break
          case 'share': named = shareName(ctx, v, l.id); break
          case 'folder': named = filesName(ctx, v, l.id, true); break
          case 'file': named = filesName(ctx, v, l.id, false); break
        }
      } catch { named = NONE }
    }
    out.push({ kind: l.kind, id: l.id, name: named.name, ...(named.folder ? { folder: true as const } : {}), ...(named.room ? { room: named.room } : {}) })
  }
  return out
}
