// Every place in server/src that counts who reads a path, and every users/ shortcut, reviewed for folder sharing
// (docs/decisions/20261116-folder-share-widening.md; the design: docs/AGENTS/plan/20261116-1147-folder-sharing.md
// "The guard test"). A folder in a person's own files can have other readers now (files/folder-shares.ts), so "who
// reads this path" must come through the hook (files/share-readers.ts: readersAt, readerCheck, shareReaders,
// privateToMe, or chat/read-scope.ts viewersOf / widening, which use it), or be a place a folder share never reaches.
//
// The scan counts, file by file: calls of the reader-counting functions; imports of them (also renamed: `readersOf as
// who`); every `.access(` (a rule check, whoever it is for); and every users/ shortcut (`[0] === 'users'`,
// `[0] !== 'users'`, `startsWith('users/')`, `` `users/${…}` ``). It compares them with the reviewed list below. A new
// call, a call gone, or a new file fails here: check that it goes through the hook (or why it need not), then update
// its line with the reason. (Second security review of PR 3, M-B: the first scan missed negated, template and
// renamed forms.)
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dir, '..', '..')
/** functions that count readers (or are the hook), called by name */
const CALLS = /\b(activePeople|readersOf|viewersOf|missingReaders|widening|roomWidening|audienceOf|viewersAdded|lostViewers|audienceChange|aiAudience|readersAmong|folderAudience|readersAt|readerCheck|shareReaders|privateToMe|embedNarrower)\(/g
/** the same functions imported (under any local name) */
const READER_FNS = new Set(['activePeople', 'readersOf', 'viewersOf', 'missingReaders', 'widening', 'roomWidening', 'audienceChange', 'folderAudience', 'readersAt', 'readerCheck', 'shareReaders', 'privateToMe', 'embedNarrower', 'viewersByHistory', 'roomViewers', 'chatViewers', 'cardSources'])
const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g
/** a rule check, for anyone */
const ACCESS = /\.access\(/g
/** a shortcut that treats users/<id>/ as one person's place */
const USERS = /\[0\] (?:===|!==) 'users'|startsWith\('users\/'\)|`users\/\$\{/g

type Counts = Record<string, number>
/** what one source text holds of each kind */
export function countsOf(text: string): Counts {
  const src = text.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  const c: Counts = {}
  const add = (k: string) => { c[k] = (c[k] ?? 0) + 1 }
  for (const m of src.matchAll(CALLS)) add(m[1]!)
  for (const _ of src.matchAll(ACCESS)) add('access')
  for (const _ of src.matchAll(USERS)) add('users/')
  for (const m of src.matchAll(IMPORT)) for (const part of m[1]!.split(',')) {
    const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim()
    if (READER_FNS.has(name)) add('import:' + name)
  }
  return c
}

/** file -> what it holds (counted), and why that is right with folder shares */
const REVIEWED: Record<string, { n: Counts; why: string }> = {
  "server/src/admin/access-edit.ts": { n: {"access": 7}, why: "team-folder rules preview (users/ carries no rules)" },
  "server/src/admin/access-explain.ts": { n: {"users/": 3}, why: "users/ carries no rules" },
  "server/src/admin/audit-sight.ts": { n: {"access": 1}, why: "whether the viewer may see an audit row's folder by path" },
  "server/src/admin/audit.ts": { n: {"users/": 1}, why: "audit wording" },
  "server/src/admin/folders.ts": { n: {"access": 10, "users/": 1}, why: "team-folder rules and their losses; group leavers reset while folders are shared" },
  "server/src/admin/users.ts": { n: {"users/": 5}, why: "the archive of a removed member (never shared, D3); their folder shares end with fresh sessions" },
  "server/src/auth/guest-invites.ts": { n: {"access": 1, "users/": 1}, why: "a guest place is never under users/" },
  "server/src/auth/guests.ts": { n: {"access": 2}, why: "a guest's one place (guests are never on a share)" },
  "server/src/chat/attach-copies.ts": { n: {"access": 1}, why: "whether everyone in a people-shared chat may read the sender's own attached file (a copy only when not); the copy reads through authorize as the sender" },
  "server/src/chat/people-share.ts": { n: {"access": 1}, why: "the Share warning names a file only when the sharer may read it now (no reader count, no share)" },
  "server/src/chat/chat-files-share.ts": { n: {"users/": 1}, why: "only the chat creator's own files are offered for copying into the chat; reads go through authorize as the creator (no reader count, no share)" },
  "server/src/chat/shared-run.ts": { n: {"users/": 1}, why: "only narrows where a steerable scheduled run may write (its maker's own folder or the save folder); every write still passes the wider-audience checks" },
  "server/src/chat/answer-share.ts": { n: {"missingReaders": 1, "access": 1, "import:missingReaders": 1, "import:viewersByHistory": 1}, why: "missingReaders -> viewersOf; its access line: who may open a linked file BY PATH (a share opens by link only, D5)" },
  "server/src/chat/delete-files.ts": { n: {"users/": 2}, why: "a guest's own folder" },
  "server/src/chat/file-placement.ts": { n: {"access": 1}, why: "where the caller may write" },
  "server/src/chat/often-asked.ts": { n: {"access": 1}, why: "team folders read by every member" },
  "server/src/chat/project-access.ts": { n: {"access": 9, "users/": 1}, why: "projects: never shared (D3)" },
  "server/src/chat/project-delete.ts": { n: {"users/": 1}, why: "a personal project's folder: path test" },
  "server/src/chat/project-joins.ts": { n: {"access": 1}, why: "team projects in projects/" },
  "server/src/chat/project-leave.ts": { n: {"access": 3}, why: "projects (never shared)" },
  "server/src/chat/projects.ts": { n: {"access": 1, "users/": 1}, why: "a project's folder: path test and the caller's own sight" },
  "server/src/chat/my-folders.ts": { n: {"access": 1, "users/": 3}, why: "my_folders: the caller's own sight of team folders by rule, as the prompt's folder lines (it counts nobody; folders shared one by one are shared_with_me's); users/ lines: their own folder, never another person's" },
  "server/src/chat/prompt.ts": { n: {"access": 3, "users/": 3}, why: "prompt wording and the person's own folders" },
  "server/src/chat/read-scope.ts": { n: {"activePeople": 7, "viewersOf": 5, "widening": 1, "readersAt": 2, "missingReaders": 1, "roomWidening": 1, "access": 2, "users/": 3, "import:readersAt": 1}, why: "widening target = readersAt; viewersOf counts a share source (W3); sourceOf tags share sources (W2); placeKey/sourceKey per share (W1); users/ lines: sourceOf and card labels; access #2: chatViewers of a team project's shared chat = who reads the project folder by rule, as Audiences.ofChat — a folder share opens files, never the project's chats, so share receivers are rightly not counted; sourceViewerCount = viewersOf (the card's per-source count, share-aware); pathAudience = readersAt (a saved file's audience line, folder shares counted)" },
  "server/src/chat/chat-file-tool.ts": { n: {"users/": 2}, why: "save_chat_file's default folder (asked by confirmWidening); chatFileCopyOf only narrows: a copy in users/<me>/ counts as the chat's only with this chat's save_chat_file create event and nothing since (a folder share cannot add a writer: shares are view only), anything else is read as before" },
  "server/src/chat/work-file-tool.ts": { n: {"users/": 1}, why: "save_work_file's default folder users/<me>/ and its \"name (2)\" rule there (only the name changes); who may read the target is asked by confirmWidening with the person as the source, and a folder share is view only, so it adds no writer" },
  "server/src/chat/room-tools.ts": { n: {"users/": 1}, why: "save_room_file's default folder (asked by confirmWidening)" },
  "server/src/chat/runtime.ts": { n: {"access": 1}, why: "live file events go to who reads the PATH (a receiver opens by link only)" },
  "server/src/chat/schedule-cover.ts": { n: {"readersOf": 1, "missingReaders": 1, "users/": 2, "import:readersOf": 1, "import:missingReaders": 1}, why: "readersOf from ai-grants; users/ lines: the own-folder provenance of a run's reads (shares are view only)" },
  "server/src/chat/schedule-scope.ts": { n: {"readersOf": 3, "missingReaders": 1, "access": 2, "users/": 4, "import:readersOf": 1, "import:missingReaders": 1}, why: "readersOf from ai-grants; a users/ save folder is never recorded (decided at the write, M3); access lines: the person's own write check; users/ lines: labels" },
  "server/src/chat/schedule-templates.ts": { n: {"privateToMe": 1, "users/": 1, "import:privateToMe": 1}, why: "a template's output folder must be privateToMe" },
  "server/src/chat/share-places.ts": { n: {"access": 1, "users/": 1}, why: "card labels" },
  "server/src/chat/shared-answers.ts": { n: {"viewersOf": 1, "import:viewersOf": 1}, why: "viewersOf" },
  "server/src/chat/shared.ts": { n: {"access": 5}, why: "who sees a project's shared chats: projects are never shared" },
  "server/src/rooms/project-link.ts": { n: {"access": 5}, why: "a project's chat room (docs/decisions/20261120-project-is-room.md): who may open or write the project's folder and its Chat attachments folder (projects/<name>, never folder-shared: shares are of folders in users/), for Room.project (canSave, attach) and the event line's name, for one viewer; the fifth: the event line's name of a project in the trash, for one of its people by the rules parked with its folder (as chat/shared.ts memberWhileTrashed); nothing is counted" },
  "server/src/rooms/file-moves.ts": { n: {"access": 1, "activePeople": 1, "readersOf": 2, "import:activePeople": 1, "import:readersOf": 1}, why: "a conversation made a project moves its files to projects/<name>/Chat attachments (structure polish A): each current room member's own read of that folder (narrowed: the file stays), and the folder's readers compared with the project's (readersOf of projects/<name> and of its Chat attachments: wider, the file stays); both are under projects/, never folder-shared (shares are of folders in users/)" },
  "server/src/rooms/make-project.ts": { n: {"activePeople": 1, "import:activePeople": 1}, why: "make-project settles the new project room (rooms/project-room.ts settleLinkedInTx): its members must equal the readers of projects/<name>, a folder that is never folder-shared (shares are of folders in users/)" },
  "server/src/rooms/project-room.ts": { n: {"activePeople": 2, "readersOf": 4, "access": 2}, why: "a project's chat room (docs/decisions/20261120-project-is-room.md): its members are the readers of projects/<name> (readersOf: active people with read there, as chat/shared.ts Audiences.of), a folder that is never folder-shared (shares are of folders in users/); access: the opener's own read of it" },
  "server/src/rooms/team-place.ts": { n: {"access": 1}, why: "a department room's upload place (docs/AGENTS/plan/20261121-0619-structure-polish.md B): whether every room member reads the group folder's Chat attachments (groups/<name>/…, never folder-shared: shares are of folders in users/); who else reads it is judged from the rule subjects on the walk up (widerThanRoom), so a reader the rules do not name is never missed; nothing is counted" },
  "server/src/rooms/file-refs.ts": { n: {"access": 1}, why: "a project room file kept in the team folder (docs/decisions/20261120-project-is-room.md D3): access is the viewer's own read of the place a trashed file was in, only to say \"File deleted\" rather than \"unavailable\"; nothing is counted, and a file that is there is checked with authorize + visiblePath (a share recipient who reads it only by a folder share sees it unavailable: fails closed)" },
  "server/src/rooms/service.ts": { n: {"activePeople": 1, "import:activePeople": 1}, why: "Rooms.sync loads the people once for rooms/project-room.ts plan (a project room's members: the readers of projects/<name>, never folder-shared)" },
  "server/src/chat/side-room.ts": { n: {"access": 3, "users/": 1}, why: "a side chat's default save folder (saves are asked by confirmWidening); saveInFor's two access checks look only at group folders and shared/, which are never folder-shared (shares are of folders in users/), and the fallback users/<id> is checked by nobody; a channel linked to a project saves in the project's folder (projects/<name>, never folder-shared) when the asker writes it (docs/decisions/20261119-channel-project-link.md)" },
  "server/src/chat/skill-list.ts": { n: {"users/": 1}, why: "a skill's name from its path" },
  "server/src/chat/skills.ts": { n: {"access": 6}, why: "skill roots: never shared (D3); the caller's own access" },
  "server/src/chat/tools.ts": { n: {"access": 4, "users/": 1}, why: "the caller's own sight; audit wording; the wording of a refusal already made: notMemberFor names a project only when the person reads its folder (projects are never shared, D3), readOnlySkillLine reads the person's write access to a skill (skill folders are never shared, D3)" },
  "server/src/chat/turn.ts": { n: {"audienceOf": 1, "folderAudience": 4, "privateToMe": 1, "missingReaders": 5, "widening": 1, "readersOf": 5, "viewersOf": 1, "access": 7, "users/": 21, "import:widening": 1, "import:folderAudience": 1, "import:readersOf": 1, "import:privateToMe": 1, "import:missingReaders": 1, "import:viewersOf": 1}, why: "seesSource -> viewersOf (the read scope's own reader test, share-aware) for a connection, a team Drive share, a room or Slack: whether the widening card may name it to the person; widenNeed -> widening; withoutTeamRoomsAdminsSee -> ai-grants readersOf; ownFolderTarget -> privateToMe; audienceOf is a project's (never shared, D3); access lines: the person's own sight (labels, listings, search scope, a skill folder); users/ lines: own-content provenance (noteOwnReads/noteOwnNames/folderNameLevel/the taint test: a shared folder is still written only by its owner, shares are view only), group/own folder tops, default save folders (asked by confirmWidening; save_connector_file's downloads folder on the room card too), people search skips users/; a save_wider approval's target holds folderAudience (share readers included), so a new share changes it and the card asks again; a new skill's held file in assets/ is covered by the skill card only when its folder has the same people (folderAudience, share readers included; skill folders are never shared, D3); widenNeed blind count = missingReaders(narrower, readersOf(target)) (the card's 'N of them cannot see where it came from': readersOf counts folder shares, viewersOf is share-aware); onlyMine (a file this chat made, changed without a card) -> ai-grants readersOf (rules + folder share people) plus share-readers sharedWithAnyoneAt (any live file or folder share row at or above with a grant, paused too); confirmSharedConnection: missingReaders on a connection's answer sources (a person's own connection or a team integration, never a team path: viewersOf is share-aware anyway); linkedProjectPlain compares a subfolder's readers with the project folder's own (readersOf counts folder shares' people too; projects/ is never folder-shared); linkedProjectPlain's write check on the linked project's folder; save_work_file's room-card target names the default folder users/<me>/ (the tool itself asks confirmWidening for any wider place); sharedSources' make_zip/copy_files folder sweep adds the person's own folder as a source when a named folder holds it (users/, the team root): the own-folder source ({type:'user'}), whose readers are counted by the read card as for any other source; shortPlace names the area of the wider-audience card's short place (words only: placeWords of users/<id>, never a reader count)" },
  "server/src/chat/widening.ts": { n: {"viewersOf": 1, "readersAmong": 2, "access": 1, "import:viewersOf": 1}, why: "readersAmong sends a share source to viewersOf; its access line is for folder and root sources" },
  "server/src/connectors/remote-mcp/guide.ts": { n: {"users/": 1}, why: "guide wording" },
  "server/src/connectors/remote-mcp/rooms.ts": { n: {"roomWidening": 1, "import:roomWidening": 1}, why: "roomWidening" },
  "server/src/connectors/remote-mcp/tools.ts": { n: {"access": 1}, why: "a connector read with versions: an old place that is gone joins the scope only when the person may read it by the folder rules (the caller's own sight; fails closed, a share never widens it)" },
  "server/src/connectors/remote-mcp/upload.ts": { n: {"widening": 1, "access": 1, "users/": 1, "import:widening": 1}, why: "write/edit/upload_file go through widening; the access line: where the caller may write; users/: a personal skills folder" },
  "server/src/demo/replay.ts": { n: {"users/": 3}, why: "demo replay path swap" },
  "server/src/devenv/srt/access.ts": { n: {"audienceOf": 2, "access": 4, "users/": 7}, why: "audienceOf counts share readers (W6); runMayWrite refuses shared folders (D11); users/ lines: a run sees only its own personal folder; sharedAccess (a shared chat's run, decisions/20261118-devenv-shared-chats.md) hides users/ as a whole, so the folder shares (all under users/) never widen it and ignoring their readers can only hide more; sharedHiddenFolders (decisions/20261118-shared-hide-subfolder-names.md) only hides project sub-folders someone in the chat cannot read, so ignoring share readers can only hide more" },
  "server/src/devenv/srt/runner.ts": { n: {"activePeople": 1, "shareReaders": 1, "import:activePeople": 1, "import:shareReaders": 1}, why: "passes the shared folders and share readers to folderView" },
  "server/src/file-list/service.ts": { n: {"access": 1}, why: "the caller's own sight" },
  "server/src/file-list/units.ts": { n: {"users/": 7}, why: "the file lists are rendered per person by path" },
  "server/src/files/folder-shares.ts": { n: {"users/": 5}, why: "the share's own owner tests" },
  // (the merge of AI sharing and folder sharing, integrate/sharing-all)
  "server/src/chat/share-with-person.ts": { n: {"users/": 1}, why: "a team folder vs one in the person's own files: a folder is refused here and sent to share_folder" },
  "server/src/chat/folder-access-tool.ts": { n: {"users/": 1}, why: "change_folder_access refuses a folder in someone's own files (team folders only)" },
  "server/src/chat/grant-reads.ts": { n: {"viewersOf": 1, "access": 1, "import:viewersOf": 1}, why: "readByGrant: viewersOf (the hook) per read source; the access line: whether a pending path is read by the folder rules" },
  "server/src/admin/folder-save.ts": { n: {"users/": 1}, why: "users/ carries no rules (moved from routes/admin.ts)" },
  "server/src/files/share-fixes.ts": { n: {"users/": 1}, why: "Ask an admin is for team folders only" },
  "server/src/files/access-routes.ts": { n: {"users/": 2}, why: "who_can_open: a personal path's folder lets in its person alone; a personal folder's own share and a file's shared folders are read in who-can-open.ts (the Share dialog's view, FolderShares.throughOf)" },
  "server/src/files/search.ts": { n: {"access": 1}, why: "the caller's own sight" },
  "server/src/files/service.ts": { n: {"shareReaders": 2, "access": 2, "users/": 1, "import:shareReaders": 1}, why: "the old restore path refuses a restore into a folder shared since; the access lines: the caller's own sight (mayReadNow: only whether a skill script copy refusal may name the file, by the folder rules alone; a folder share never adds to it, so it names less, never more); the users/ line only leaves the person's own folder OUT of a shared project chat's \"/\" search (skipOwnOf: narrows what a search returns, never grants or reads more)" },
  "server/src/files/share-places.ts": { n: {"users/": 3}, why: "where a folder share may live" },
  "server/src/files/share-readers.ts": { n: {"shareReaders": 5, "readersAt": 1, "readerCheck": 1, "privateToMe": 1, "access": 2, "users/": 6}, why: "the hook itself" },
  "server/src/files/share-undo.ts": { n: {"access": 1, "users/": 1}, why: "Undo needs edit access by the folder rules (PR 6, second review); audit wording" },
  "server/src/files/shares.ts": { n: {"access": 8, "users/": 11}, why: "file shares (their own model: who opens a FILE by link); audit wording; the owner rule; stillOpens: who still opens a file after a stop by its folder rules (the stop card's line)" },
  "server/src/integrations/connections/tools.ts": { n: {"missingReaders": 1, "import:missingReaders": 1}, why: "a shared chat's connection lines say whether the asker's card comes first: missingReaders on the connection's answer sources (a person's own connection or a team integration, never a team path); the call itself asks chat/turn.ts confirmSharedConnection" },
  "server/src/integrations/google-drive/oauth.ts": { n: {"access": 2}, why: "an OAuth access token (not folder access)" },
  "server/src/notifications/service.ts": { n: {"access": 2}, why: "a notice's folder source: team folders" },
  "server/src/onboarding/suggestions.ts": { n: {"access": 1}, why: "where the person may write" },
  "server/src/plugins/manager.ts": { n: {"access": 5}, why: "plugin access settings (not folder access)" },
  "server/src/policy/access.ts": { n: {"access": 9, "users/": 10}, why: "the folder rules: users/<id>/ is its person's only by PATH, unchanged (D1)" },
  "server/src/policy/authorize.ts": { n: {"access": 4, "users/": 1}, why: "the path walk" },
  "server/src/policy/convert-additive.ts": { n: {"access": 6, "users/": 1}, why: "rule conversion" },
  "server/src/policy/invariants.ts": { n: {"users/": 1}, why: "rule invariants" },
  "server/src/policy/legacy-deepest.ts": { n: {"access": 1, "users/": 2}, why: "the old rule model (conversion only)" },
  "server/src/promo-video/save.ts": { n: {"users/": 1}, why: "the default users/<id>/videos/ (never shared); a chosen place goes through confirmSources -> confirmWidening" },
  "server/src/realtime/hub.ts": { n: {"access": 1}, why: "replayed file events: by path" },
  "server/src/rooms/save-to-team.ts": { n: {"readerCheck": 1, "activePeople": 1, "access": 1, "import:activePeople": 1, "import:readerCheck": 1}, why: "outsideRoom counts with readerCheck (share readers included); access: the viewer's own read of a saved place" },
  "server/src/rooms/ai-grants.ts": { n: {"activePeople": 3, "folderAudience": 4, "shareReaders": 1, "readersOf": 1, "readersAt": 1, "access": 1, "import:readersAt": 1, "import:shareReaders": 1}, why: "readersOf = readersAt; folderAudience adds share readers" },
  "server/src/rooms/history.ts": { n: {"viewersOf": 1, "import:viewersOf": 1}, why: "viewersOf" },
  "server/src/routes/chats.ts": { n: {"users/": 6}, why: "a personal project's folder: path tests" },
  "server/src/routes/files.ts": { n: {"embedNarrower": 1, "import:embedNarrower": 1}, why: "embedNarrower (readerCheck)" },
  "server/src/routes/memories.ts": { n: {"users/": 1}, why: "personal skills left out of a list" },
  "server/src/routes/system.ts": { n: {"access": 1}, why: "the caller's own sight" },
  "server/src/safe-ops/publication.ts": { n: {"readerCheck": 1, "import:readerCheck": 1}, why: "audience through readerCheck" },
  "server/src/skills/changes.ts": { n: {"access": 2}, why: "project skills: projects are never shared (D3)" },
  "server/src/skills/examples.ts": { n: {"access": 1}, why: "the caller's own sight" },
  "server/src/skills/folder-actions.ts": { n: {"activePeople": 4, "readerCheck": 1, "access": 11, "import:activePeople": 1, "import:readerCheck": 1}, why: "readers() through readerCheck (a file out of a skill into a shared folder, H-A); followers/editors: skill roots are never shared (D3)" },
  "server/src/skills/managers.ts": { n: {"access": 4}, why: "skill folders: never shared (D3)" },
  "server/src/skills/move.ts": { n: {"activePeople": 3, "access": 7, "import:activePeople": 1}, why: "skill folders: never shared (D3)" },
  "server/src/skills/suggestions.ts": { n: {"users/": 1}, why: "a personal skill file: never shared (D3)" },
  "server/src/system/export.ts": { n: {"users/": 3}, why: "an export's own folders" },
  "server/src/team-files/changes.ts": { n: {"access": 1}, why: "file change events: by path" },
  "server/src/team-files/component.ts": { n: {"access": 2}, why: "conflict-copy notices: by path" },
  "server/src/team-files/embed.ts": { n: {"activePeople": 2, "embedNarrower": 1, "readerCheck": 1, "import:readerCheck": 1}, why: "readerCheck" },
  "server/src/team-files/html-pdf-save.ts": { n: {"embedNarrower": 1, "widening": 1, "import:widening": 1, "import:embedNarrower": 1}, why: "widening and embedNarrower" },
  "server/src/team-files/move-suggest.ts": { n: {"access": 2}, why: "where the caller may write" },
  "server/src/team-files/service.ts": { n: {"activePeople": 7, "readerCheck": 5, "lostViewers": 3, "readersOf": 3, "viewersAdded": 5, "audienceChange": 1, "aiAudience": 3, "shareReaders": 3, "access": 25, "users/": 22, "import:readerCheck": 1, "import:shareReaders": 1}, why: "audience, lostViewers, readersOf, viewersAdded, audienceChange through readerCheck; aiAudience adds shareReaders; copies, restores and moves into a shared folder ask; other access lines: the caller's own access; users/ lines: path rules; a trashed team folder's projects tell their linked channels (users/ projects are personal and never linked)" },
  "server/src/tools/file-moves.ts": { n: {"audienceChange": 3, "access": 1}, why: "audienceChange; the card's yes is passed to move()/copy(); the access line: the caller's own sight" },
  "server/src/tools/higgsfield.ts": { n: {"privateToMe": 1, "users/": 1, "import:privateToMe": 1}, why: "save_as: confirmWidening or privateToMe; the default users/<id>/videos/ is never shared" },
  "server/src/tools/make-file.ts": { n: {"widening": 1, "import:widening": 1}, why: "widening outside a turn" },
  "server/src/chat/places-copy.ts": { n: {"access": 2}, why: "the caller's own sight: which files and folders of a team folder copied into the chat's work folder go in, as list and read show them to that person (the writer opens each file again from its checked descriptor); who else sees the copy is the shared read card's and the wider-audience card's" },
  "server/src/tools/make-zip.ts": { n: {"access": 4}, why: "the caller's own sight: which files and folders go into the person's zip, as list and read show them to that person (the walk, and each file again by the current rules before it is read); who can read where the zip is saved is checked by confirmSources (the wider-audience card)" },
  "server/src/tools/unzip.ts": { n: {"readersOf": 2, "import:readersOf": 1}, why: "groups the folders a zip goes into by who can read there and who can read the zip (readersOf = readersAt: folder rules and folder shares), only to ask the wider-audience card once per audience and to notice a change after a card; every group is still checked by confirmSources" },
  "server/src/tools/save-url.ts": { n: {"privateToMe": 1, "users/": 2, "import:privateToMe": 1}, why: "own() is privateToMe" },
  "server/src/tools/save-connector-file.ts": { n: {"privateToMe": 1, "users/": 2, "import:privateToMe": 1}, why: "as save_url: the default folder is the person's own downloads (the wider-audience card still asks), and without a chat turn's check only a users/<me>/ place that privateToMe says nobody else reads" },
  "server/src/tools/demo-banner.ts": { n: {"users/": 1}, why: "the demo banner's fallback folder is the person's own (users/<me>), only a place to save; make_file's wider-audience check (confirmSources) still decides, and nothing counts readers by it" },
  "server/src/tools/schedules.ts": { n: {"import:cardSources": 1}, why: "cardSources (readersOf from ai-grants)" },
}

function scan(): Record<string, Counts> {
  const out: Record<string, Counts> = {}
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (p.endsWith('.ts')) {
        const c = countsOf(fs.readFileSync(p, 'utf8'))
        if (Object.keys(c).length) out[path.relative(ROOT, p).split(path.sep).join('/')] = c
      }
    }
  }
  walk(path.join(ROOT, 'server', 'src'))
  return out
}

describe('every function that counts readers and every users/ shortcut is reviewed for folder shares', () => {
  const found = scan()
  test('no file outside the reviewed list counts readers or treats users/<id>/ as one person\'s', () => {
    const unreviewed = Object.keys(found).filter((f) => !REVIEWED[f]).map((f) => `${f} ${JSON.stringify(found[f])}`)
    expect(unreviewed).toEqual([])
  })
  test('each reviewed file has exactly the calls that were reviewed (a new one must go through files/share-readers.ts)', () => {
    const changed: string[] = []
    for (const [f, r] of Object.entries(REVIEWED)) {
      const now = found[f] ?? {}
      const keys = new Set([...Object.keys(now), ...Object.keys(r.n)])
      for (const k of keys) if ((now[k] ?? 0) !== (r.n[k] ?? 0)) changed.push(`${f}: ${k} ${r.n[k] ?? 0} -> ${now[k] ?? 0}`)
    }
    expect(changed).toEqual([])
  })
  test('the scan sees the shapes the second review found missed: negated, template and renamed forms', () => {
    const hits = (s: string) => Object.values(countsOf(s)).reduce((a, b) => a + b, 0)
    expect(hits("if (segs.length < 3 || segs[0] !== 'users' || segs[1] !== this.spec.userId) return null")).toBe(1)
    expect(hits('const mine = `users/${me}/`; if (p.startsWith(mine)) return true')).toBe(1)
    expect(countsOf("import { readersOf as who } from '../rooms/ai-grants'; who(db, rules, segs)")).toEqual({ 'import:readersOf': 1 })
    expect(hits('const ok = me.rules.access(someone, segs)')).toBe(1)
  })
  test('the writers into a personal folder are wired to the hook', () => {
    const src = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
    expect(src('server/src/tools/higgsfield.ts')).toMatch(/confirmWidening\(asked/)
    expect(src('server/src/tools/save-url.ts')).toContain('privateToMe(')
    expect(src('server/src/chat/turn.ts')).toMatch(/if \(!privateToMe\(this\.rt\.db, this\.spec\.userId, segs\)\) return null/)
    expect(src('server/src/team-files/service.ts')).toMatch(/sharedSince\(r\.segs, v\.path_at_save/)
    expect(src('server/src/team-files/service.ts')).toMatch(/sharedSince\(r\.segs, samePlace \? t\.deleted_at : null\)/)
    expect(src('server/src/team-files/service.ts')).toMatch(/target\[0\] === 'users' && shareAbove\(/)
    expect(src('server/src/team-files/service.ts')).toMatch(/assertSharedConfirmed\(r\.segs, added, o\.confirm\)/)
    expect(src('server/src/team-files/service.ts')).toMatch(/assertSharedConfirmed\(tr\.segs, added, o\.confirm\)/)
    expect(src('server/src/devenv/srt/runner.ts')).toContain('ownSharedFolders(')
    expect(src('server/src/devenv/srt/runner.ts')).toContain('startingRun(row.user_id)')
    expect(src('server/src/files/folder-shares.ts')).toContain('folder_share_run_active')
    expect(src('server/src/files/share-undo.ts')).toContain('folder_share_run_active')
  })
})
