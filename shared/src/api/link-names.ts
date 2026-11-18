// Named app links (docs/decisions/20261118-named-app-links.md, plan docs/AGENTS/plan/20261118-0811-named-app-links.md).
// Owner: B (server/src/link-names/resolve.ts, registered by server/src/routes/link-names.ts).
//
// A link to something in this app, pasted into a message (a chat, a file link, a project, a folder or a file in Files,
// a room), shows as a chip with the thing's name. The web app finds those links (web/src/lib/appLinks.ts) and asks
// here, in batches, what each one is called FOR THE CALLER: a name only when the caller could open that thing
// themselves right now, with the same check its own page uses. Anything else (no access, not there, a malformed id)
// answers the same way, with no name, so a link tells nothing about what the caller cannot open. Names are plain text,
// at most LINK_NAME_MAX characters; a path is never returned, only the last name in it.
import { z } from 'zod'
import { endpoint } from './endpoint'
import { UserRef } from './entities'
import { RoomKind } from './rooms'

/** Links per request (the web app sends one request per burst of chips, cut into pieces of this size). */
export const LINK_NAMES_MAX = 50
/** A returned name's length in characters (cut, never half an emoji). */
export const LINK_NAME_MAX = 120

/** What a link points at: a chat (/c/<id>), a project (/projects/<id>), a room (/rooms/<id>), a file link (/f/<token>),
 * a folder (/files?path=) or a file (/files/view?path=) in Files. */
export const LinkNameKind = z.enum(['chat', 'project', 'room', 'share', 'folder', 'file'])
export type LinkNameKind = z.infer<typeof LinkNameKind>

/** `id`: the chat, project or room id, the file link's token, or the folder's or file's path in the team folder. */
export const LinkNameRef = z.object({ kind: LinkNameKind, id: z.string().min(1).max(1024) })
export type LinkNameRef = z.infer<typeof LinkNameRef>

export const LinkNamesBody = z.object({ links: z.array(LinkNameRef).min(1).max(LINK_NAMES_MAX) }).strict()
export type LinkNamesBody = z.infer<typeof LinkNamesBody>

/**
 * One answer per distinct link asked, in the order asked. `name`: what the caller calls it (a chat's title, a project's
 * name, a file's or folder's own name, never its path); null when the caller could not open it now, or it is not
 * there (the same answer for both). `folder`: a file link that points at a folder. `room`: for a room, how it is named
 * to the caller (a team room or the everyone room by its name, a DM by the other person, a group chat by its name or
 * people), the client words it as the rooms list does; absent with `name` null.
 */
export const LinkName = z.object({
  kind: LinkNameKind,
  id: z.string(),
  name: z.string().nullable(),
  folder: z.literal(true).optional(),
  room: z.object({ kind: RoomKind, name: z.string().nullable(), peers: z.array(UserRef), memberCount: z.number().int().nonnegative() }).optional(),
})
export type LinkName = z.infer<typeof LinkName>
export const LinkNames = z.object({ items: z.array(LinkName) })
export type LinkNames = z.infer<typeof LinkNames>

export const LINK_NAMES = {
  linkNames: endpoint({ method: 'POST', path: '/api/link-names', auth: 'user', owner: 'B', body: LinkNamesBody, response: LinkNames,
    summary: 'Names for links to things in this app pasted into messages (chats, projects, rooms, file links, folders and files), as the caller: a name only when the caller could open it now with the page\'s own check; no access and not there both answer name null. At most 50 per request; names only, never paths.' }),
}
