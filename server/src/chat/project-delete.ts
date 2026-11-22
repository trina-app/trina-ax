// A team project deleted for good (docs/DECISIONS.md "Shared project chats: the trash and live lists", "A team project in
// the trash: its members keep its card"): DELETE /api/projects/:id of a project not in place, and Files › Trash's Delete
// for good on a project's own folder (routes/files.ts purgeTrash) take this one path, so the two never differ: its folder's
// trash item goes for good, its shared chats go to their creators' trash (or for good when the creator would not see it),
// its private chats stay without project, the row and its folder marker go, audited as project.delete.
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ChatRuntime } from './runtime'
import type { ProjectRow } from './store'
import { Audiences, accountSeesProject, rulesInPlace } from './shared'
import { componentC } from '../team-files/component'
import { mapErrors } from '../team-files/errors'
import { dropProjectMarker } from '../admin/folders'
import { audit } from '../admin/audit'
import { forgetPurgedChats } from './forget'
import { dropChatPins } from './pins'
import { dropChatFolderItems } from './nav-folders'
import { dropLinksInTx } from '../rooms/project-link'
import { archiveRoomsOf } from '../rooms/project-room'
import { roomsOf } from '../rooms/service'

const isPersonalPath = (folder: string) => folder === 'users' || folder.startsWith('users/')

/** Delete the project `r` for good, as `actorId` (who may: the caller checked it). */
export function deleteProjectForGood(ctx: AppContext, rt: ChatRuntime, r: ProjectRow, actorId: string, locale: Locale): void {
  const trashFolder = false
  // the private chats stay, without project. Its shared chats (those in the trash too) go to their creators' trash,
  // as a single delete does (docs/DECISIONS.md "Shared project chats: the trash and live lists"): each stops being
  // shared and, restored, is its creator's chat without project, keeping the several-authors rules (chat/turn.ts
  // othersWrote, chat/shared.ts messageView). One whose creator would not see the project now (they lost its folder,
  // or the account was deleted; a folder in the trash is judged by its own rules, as if it were back) goes for good,
  // as before: nobody could restore it, and giving it back would show its creator what was said after they lost it.
  // Their turns stop; everyone else who saw one hears it is gone.
  const shared = ctx.db.query('SELECT id, user_id, deleted_at FROM chats WHERE project_id = ? AND shared_at IS NOT NULL').all(r.id) as { id: string; user_id: string; deleted_at: string | null }[]
  const audience = new Audiences(ctx.db, ctx.files).of(r)
  const rules = rulesInPlace(ctx.db, ctx.files, r)
  const kept = shared.filter((x) => accountSeesProject(ctx.db, rules, r, x.user_id))
  const purged = shared.filter((x) => !kept.includes(x))
  // the folder first: when it cannot go (a folder inside it the caller cannot write or may not trash), the project
  // and its chats stay as they are
  // for good: its folder's item in the trash goes for good too (only the project's own folder, as it went there)
  const item = r.trashed_with ? ctx.db.query("SELECT id FROM trash_items WHERE id = ? AND restored_at IS NULL AND kind = 'folder' AND original_path = ?").get(r.trashed_with, r.folder_path) as { id: string } | null : null
  if (item) mapErrors(locale, () => componentC(ctx).files.purgeTrash(item.id, actorId, { manager: true }), 'params.id')
  for (const x of shared) rt.stopChat(x.id)
  // its own chat room (rooms/project-room.ts) is archived in its own write before the project row goes: the link cascades
  // with the project, which would leave a plain channel that keeps everyone. Its members lose it now. If the write below
  // then fails, the project stays without that room (archived, its link gone): nothing leaks, and Chat room makes a new one
  const archived = archiveRoomsOf(ctx.db, r.id)
  for (const a of archived) for (const uid of a.members) {
    ctx.services.realtime.forgetReplay(uid)
    ctx.services.realtime.publish(uid, { type: 'room.updated', data: { roomId: a.roomId, change: 'removed', room: null } })
  }
  const now = new Date().toISOString()
  let unlinked: string[] = []
  ctx.db.transaction(() => {
    // a link row left (a 0.5.21 linked channel not settled yet, rooms/project-link.ts) goes here, explicitly (the cascade
    // would take it too), audited by the project only; that channel stays a plain private channel
    unlinked = dropLinksInTx(ctx.db, { projectId: r.id })
    for (const x of purged) rt.purgeChat(x.id)
    // one already in the trash keeps its time there (and who put it there)
    for (const x of kept) ctx.db.query('UPDATE chats SET shared_at = NULL, project_id = NULL, deleted_at = COALESCE(deleted_at, ?), deleted_by = CASE WHEN deleted_at IS NULL THEN ? ELSE deleted_by END WHERE id = ?').run(now, actorId, x.id)
    // in the trash: nobody's pin of them stays (chat/pins.ts), nor anyone's history-section row (chat/nav-folders.ts;
    // the project's other chats, now without a project, stay in their sections)
    dropChatPins(ctx.db, kept.map((x) => x.id))
    dropChatFolderItems(ctx.db, kept.map((x) => x.id))
    ctx.db.query('UPDATE chats SET project_id = NULL WHERE project_id = ?').run(r.id)
    ctx.db.query('DELETE FROM projects WHERE id = ?').run(r.id)
    // a rule-less folders row that only marked this project's folder goes with it (security review r2: it kept the
    // folder, and every folder above it, admin-only to move, rename or trash for good). Not when its folder is in the
    // trash: the marker is there with it, and the old path may be another folder's now.
    if (r.trashed_with === null && !trashFolder) dropProjectMarker(ctx.db, r.folder_path)
    audit(ctx.db, { actor: actorId, action: 'project.delete', target: r.id, detail: isPersonalPath(r.folder_path) ? null : { name: r.name, folderPath: r.folder_path, ...(trashFolder ? { folderTrashed: true } : {}), ...(shared.length ? { sharedChats: shared.length } : {}), ...(purged.length ? { sharedChatsPurged: purged.length } : {}) } })
  })()
  const gone = (id: string, uid: string) => rt.hub.publish(uid, { type: 'chat.updated', data: { chatId: id, change: 'purged', chat: null } })
  for (const x of kept) {
    // its creator: now in their trash (a chat of theirs); one already there was out of their lists
    if (!x.deleted_at) rt.publishChat(x.user_id, x.id, 'deleted')
    for (const uid of audience) if (uid !== x.user_id) gone(x.id, uid)
  }
  for (const x of purged) for (const uid of audience) gone(x.id, uid)
  // such a channel's members get the room as they see it now
  if (unlinked.length) roomsOf(ctx).projectsChanged([], unlinked)
  if (purged.length) void forgetPurgedChats(ctx, purged.map((x) => x.id))
}
