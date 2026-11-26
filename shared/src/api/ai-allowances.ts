// What the signed-in person allowed the AI in advance (Settings › 트리나에게 허용한 것). Owner: B
// (server/src/routes/ai-allowances.ts, server/src/rooms/ai-grants.ts). Only the person sees and deletes their own: another
// person's id answers 404, like one that is not there. One kind today, a room's folder for new files ("이 방에서는 항상
// 허용", docs/DECISIONS.md "대화방에서 새 파일은 미리 허용"); the list is a union by `kind` so other kinds (sites allowed
// for a conversation) can join it.
import { z } from 'zod'
import { UserRef } from './entities'
import { endpoint, empty } from './endpoint'
import { RoomKind } from './rooms'

/** "이 방에서는 항상 허용": in this room, when the person calls @트리나, it may make new files in `folder` (and its
 * subfolders) without asking, until `expiresAt`. The room as the person sees it (the fields its title is made of). */
export const RoomFilesAllowance = z.object({
  kind: z.literal('room_files'),
  id: z.string(),
  room: z.object({ id: z.string(), kind: RoomKind, name: z.string().nullable(), peers: z.array(UserRef), memberCount: z.number().int().nonnegative() }),
  /** the team folder, as the file layer names it */
  folder: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
})
export type RoomFilesAllowance = z.infer<typeof RoomFilesAllowance>

/** The kinds of the AI's cards a person can answer with "Always allow" (docs/DECISIONS.md "Always allow on every card",
 * server/src/chat/always-allow.ts). After that answer the card of that kind is not raised for them again in the chats
 * they watch, until they take it back here. */
export const CARD_ALWAYS_KINDS = ['room_change', 'remember', 'save_wider', 'post_to_room', 'shared_read', 'shared_save', 'move_files', 'skill_files', 'skill_save', 'delete_files', 'project_members', 'video', 'big_download', 'share_files', 'post_files', 'share_folder', 'folder_access', 'bulk_files', 'dev_login'] as const
export const CardAlwaysKind = z.enum(CARD_ALWAYS_KINDS)
export type CardAlwaysKind = z.infer<typeof CardAlwaysKind>

/** Auto mode (docs/decisions/20261125-auto-mode.md): what it does with each kind of card. `auto`: no card, the call is
 * free of the floor by its kind; `auto-if`: no card only when the call's own floor check passes (the tool passes it) and
 * the chat read nothing of other people or from outside; `ask`: the card always shows. The `auto` column of the "Kinds"
 * table in docs/ASKS.md must say the same (tests/unit/ask-registry.test.ts). */
export type AutoRule = 'auto' | 'auto-if' | 'ask'
export const AUTO_KINDS: Readonly<Record<CardAlwaysKind, AutoRule>> = {
  big_download: 'auto', bulk_files: 'auto',
  save_wider: 'auto-if', move_files: 'auto-if', skill_files: 'auto-if',
  // the floor (plan section 3): rooms and other people's words, memory after outside content, everything that sends,
  // shares, costs, deletes, signs in or changes other people's AI
  room_change: 'ask', remember: 'ask', post_to_room: 'ask', shared_read: 'ask', shared_save: 'ask', skill_save: 'ask',
  delete_files: 'ask', project_members: 'ask', video: 'ask', share_files: 'ask', post_files: 'ask', share_folder: 'ask',
  folder_access: 'ask', dev_login: 'ask',
}

/** The team's auto mode (Admin › Team AI settings): `off` nobody can turn it on; `allowed` each person can, it starts
 * off; `default` it starts on for each person who did not choose. */
export const AUTO_MODE_TEAM = ['off', 'allowed', 'default'] as const
export const AutoModeTeam = z.enum(AUTO_MODE_TEAM)
export type AutoModeTeam = z.infer<typeof AutoModeTeam>

/** One card auto mode approved (audit action `ai.auto_allow`), for Settings › 트리나에게 허용한 것 "최근 자동 승인". */
export const AutoApproval = z.object({
  kind: CardAlwaysKind,
  chatId: z.string().nullable(),
  /** the chat's title as the person sees it now; null when it has none or is gone */
  chatTitle: z.string().nullable(),
  at: z.string(),
})
export type AutoApproval = z.infer<typeof AutoApproval>

/** GET /api/ai-allowances/auto-mode: my auto mode as it works now. `available`: the team lets me use it (not `off`, the
 * team's "Always allow" on, not a guest). `on`: it is on for me now. */
export const MyAutoMode = z.object({ available: z.boolean(), on: z.boolean(), team: AutoModeTeam, recent: z.array(AutoApproval) })
export type MyAutoMode = z.infer<typeof MyAutoMode>
export const MyAutoModeBody = z.strictObject({ on: z.boolean(), via: z.enum(['pill', 'settings']) })

/** "Always allow" on one kind of card (id `card:<kind>`). */
export const CardAllowance = z.object({
  kind: z.literal('card'),
  id: z.string(),
  card: CardAlwaysKind,
  createdAt: z.string(),
})
export type CardAllowance = z.infer<typeof CardAllowance>

/** "항상 허용" on a connector tool's read card (docs/decisions/20261122-connector-always-allow.md): that tool of that
 * connection reads without the card in every chat. `connection` is the connection's name, `tool` the tool as the card
 * named it. */
export const ConnectorToolAllowance = z.object({
  kind: z.literal('connector_tool'),
  id: z.string(),
  connection: z.string(),
  tool: z.string(),
  /** the shared chat card's Always: what this connection returns shows to the people in a shared chat (no tool) */
  shared: z.literal(true).optional(),
  /** "<connector> 전체 항상 허용" (docs/decisions/20261123-one-always-allow.md): every tool of this connection, one entry
   * per connection (`tool` then reads "All tools" for an app that does not know the field) */
  all: z.literal(true).optional(),
  /** the one notice of a shared project or shared chat (docs/decisions/20261123-shared-connector-warning-once.md): the
   * person went on from it there; this is the project's name or the chat's title ('' when it has none). Removing it shows
   * the notice again (with `shared`, so an app that does not know the field still names it) */
  warned: z.string().max(500).optional(),
  createdAt: z.string(),
})
export type ConnectorToolAllowance = z.infer<typeof ConnectorToolAllowance>

/** A site allowed for good (docs/decisions/20261122-always-allow-holds-everywhere.md B3): `web`, "이 사이트 항상 허용"
 * on the AI's address card (its plain addresses open without the card in every chat); `office`, "항상 허용" on the
 * in-app browser's office-network card. `site` as the card named it (Unicode for an IDN). */
export const SiteAllowance = z.object({
  kind: z.literal('site'),
  id: z.string(),
  site: z.string(),
  place: z.enum(['web', 'office']),
  createdAt: z.string(),
})
export type SiteAllowance = z.infer<typeof SiteAllowance>

/** "Always allow" on a connection's send card (server/src/integrations/connections/tools.ts keepAlwaysAllow): the
 * person's changes at that service go without the card. On their own connection it is its write rule ("allow"); on a
 * team connection, their own row (never the admin's rule). Id `send:<connection id>`; taking it back sets their own
 * connection to asking, or deletes their row (docs/decisions/20261123-ask-registry-findings.md). */
export const ConnectorSendAllowance = z.object({
  kind: z.literal('connector_send'),
  id: z.string(),
  /** the connection's name */
  connection: z.string(),
  /** whose connection: the person's own, or the team's */
  scope: z.enum(['personal', 'team']),
  createdAt: z.string(),
})
export type ConnectorSendAllowance = z.infer<typeof ConnectorSendAllowance>

/** A name the person calls a teammate by ("팀장님" = QA Owner; docs/decisions/20261123-do-then-undo.md): kept when they
 * answered once who a title meant, so the AI does not ask again. `ref` the title as matched ("팀장"), `person` the
 * teammate. Deleting it means being asked again. */
export const PersonAliasAllowance = z.object({
  kind: z.literal('person_alias'),
  id: z.string(),
  ref: z.string(),
  person: z.object({ id: z.string(), name: z.string() }),
  createdAt: z.string(),
})
export type PersonAliasAllowance = z.infer<typeof PersonAliasAllowance>

/** "Always allow" on the card for a picture the person did not upload (tools/own-picture.ts): this one picture goes into
 * documents without the card, never a different one (docs/decisions/20261123-picture-always-allow.md). Kept in
 * card_always_allow under a key of its own: `picture:t:<team path>` or `picture:c:<chat file id>`. `picture` is the
 * team path or the chat file's name. */
export const PictureAllowance = z.object({
  kind: z.literal('picture'),
  id: z.string(),
  picture: z.string(),
  createdAt: z.string(),
})
export type PictureAllowance = z.infer<typeof PictureAllowance>
/** The stored key of one approved picture. */
export type PictureAlwaysKey = `picture:${'t' | 'c'}:${string}`

export const AiAllowance = z.discriminatedUnion('kind', [RoomFilesAllowance, CardAllowance, ConnectorToolAllowance, SiteAllowance, ConnectorSendAllowance, PersonAliasAllowance, PictureAllowance])
export type AiAllowance = z.infer<typeof AiAllowance>

export const AI_ALLOWANCES = {
  listAiAllowances: endpoint({ method: 'GET', path: '/api/ai-allowances', auth: 'user', owner: 'B', response: z.object({ items: z.array(AiAllowance) }), summary: 'What I allowed the AI in advance ("Always allow" on a kind of card, a connector tool or a site, room folders for new files), newest first.' }),
  getAutoMode: endpoint({ method: 'GET', path: '/api/ai-allowances/auto-mode', auth: 'user', owner: 'B', response: MyAutoMode, summary: 'My auto mode: if the team lets me use it, if it is on, and the last 50 cards it approved for me.' }),
  setAutoMode: endpoint({ method: 'PUT', path: '/api/ai-allowances/auto-mode', auth: 'user', owner: 'B', body: MyAutoModeBody, response: MyAutoMode, summary: 'Turn my auto mode on or off (409 when the team does not allow it).' }),
  deleteAiAllowance: endpoint({ method: 'DELETE', path: '/api/ai-allowances/:id', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Take one of my allowances back (404: not mine or not there).' }),
} as const
