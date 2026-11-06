// Group management through the remote MCP connector (scope mcp:admin): the person's Claude lists people and groups
// and creates, changes and deletes groups as Admin › Groups does. Changes go through the server functions the admin
// routes call (admin/groups.ts), so validation, the group's own folder, the access-change handling (H7) and the audit
// lines are the web's; the audit lines also say via: 'connector'. Each change answers with who now opens or loses
// which folders (admin/folders.ts accessChanges: the permission function before and after the change). Everything
// here is synchronous: nothing awaits between the role check in tools.ts and the change.
import { z } from 'zod'
import { GroupBody, UpdateGroupBody, errorMessage, type Group } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import type { Principal } from '../../policy/access'
import { HttpError } from '../../http/errors'
import { accessChanges, captureState, type AccessChange, type AccessState } from '../../admin/folders'
import { createGroupAs, deleteGroupAs, getGroup, groupFolder, groupIdByName, listGroups, updateGroupAs } from '../../admin/groups'
import { isParkedRow } from '../../admin/folder-keep'
import { OAuthError } from './policy'
import type { RemoteOAuth } from './oauth'

export const GROUP_TOOLS: ReadonlySet<string> = new Set(['people_list', 'groups_list', 'group_create', 'group_update', 'group_delete'])
const CHANGES = new Set(['group_create', 'group_update', 'group_delete'])

/** Bounds of the inputs and of the answers (a team can have many people, groups and rule folders). Tests lower some. */
export const GROUP_LIMITS = {
  /** people named in one call (members, add, remove each) */ peoplePerCall: 200,
  /** group changes per person per minute (on top of the connector's 120 calls) */ changesPerMinute: 20,
  /** people_list rows */ listPeople: 300,
  /** groups_list groups, and the members and rule folders shown per group (one group asked for: more members) */
  listGroups: 100, groupMembers: 50, oneGroupMembers: 500, groupRules: 20,
  /** the access text of a change: people named, and folders per person */ textPeople: 30, textFolders: 6,
}

const Ref = z.string().trim().min(1).max(200)
const People = (what: string) => z.array(Ref).max(GROUP_LIMITS.peoplePerCall).describe(`${what}: usernames or ids (people_list shows them), at most ${GROUP_LIMITS.peoplePerCall}.`)
const GroupRef = Ref.describe('The group: its name (any case) or its id.')

export const PeopleListInput = z.object({
  query: z.string().trim().max(100).optional().describe('Only people whose name or username contains this text (any case).'),
}).strict()
export const GroupsListInput = z.object({
  group: GroupRef.optional().describe(`Only this group (name or id), with up to ${GROUP_LIMITS.oneGroupMembers} members.`),
}).strict()
export const GroupCreateInput = z.object({
  name: GroupBody.shape.name.describe('The new group\'s name, unique in the team (any case). Its folder becomes groups/<name>/.'),
  description: GroupBody.shape.description.describe('A short description (optional).'),
  members: People('The first members').optional(),
}).strict()
export const GroupUpdateInput = z.object({
  group: GroupRef,
  name: UpdateGroupBody.shape.name.describe('A new name (optional). The group\'s folder keeps its name.'),
  description: UpdateGroupBody.shape.description.describe('A new description (optional; null clears it).'),
  add: People('People to add').optional(),
  remove: People('People to take out').optional(),
}).strict()
export const GroupDeleteInput = z.object({ group: GroupRef }).strict()

function tool(name: string, description: string, input: z.ZodType, annotations: { readOnlyHint: boolean; destructiveHint?: boolean }) {
  const schema = z.toJSONSchema(input, { target: 'draft-7' }) as Record<string, unknown>
  delete schema.$schema
  return { name, description, inputSchema: schema, annotations: { ...annotations, openWorldHint: false } }
}
const ADMIN_NOTE = 'Admin tool: you act as the signed-in owner or admin, checked again on every call.'
export const groupTools = [
  tool('people_list', `List the team's active people: id, name, username, role and the names of their groups. Use a username or id to name someone in group_create and group_update. At most ${GROUP_LIMITS.listPeople} people per answer; query narrows it. ${ADMIN_NOTE}`, PeopleListInput, { readOnlyHint: true }),
  tool('groups_list', `List the team's groups: each with its folder, its members (name and username) and the folder rules that name it (path and access). Group membership decides which folders a member opens; owners and admins open every team folder anyway. ${ADMIN_NOTE}`, GroupsListInput, { readOnlyHint: true }),
  tool('group_create', `Create a group as Admin › Groups does: it also makes the folder groups/<name>/, which the group writes. The answer says who now opens which folders. ${ADMIN_NOTE}`, GroupCreateInput, { readOnlyHint: false, destructiveHint: false }),
  tool('group_update', `Rename a group, change its description, or add and take out members. Taking someone out can close folders to them; the answer says who now opens or loses which folders. Tell the person what will change before you call it. ${ADMIN_NOTE}`, GroupUpdateInput, { readOnlyHint: false, destructiveHint: true }),
  tool('group_delete', `Delete a group and every folder rule that names it, as Admin › Groups does. Its folder and files stay. Members can lose folders; the answer says who loses what. Ask the person before you call it. ${ADMIN_NOTE}`, GroupDeleteInput, { readOnlyHint: false, destructiveHint: true }),
]

export type GroupOutcome = { text: string; isError?: boolean; audit: Record<string, unknown> }
const fail = (text: string, audit: Record<string, unknown> = {}): GroupOutcome => ({ text, isError: true, audit })
const ok = (text: string, audit: Record<string, unknown> = {}): GroupOutcome => ({ text, audit })

type Person = { id: string; name: string; username: string; role: string; status: string }
const show = (p: { name: string; username: string }) => `${p.name} (${p.username})`
const quote = (s: string) => JSON.stringify(s.length > 100 ? s.slice(0, 100) + '…' : s)
const listOf = (items: string[], max = 10) => items.slice(0, max).join(', ') + (items.length > max ? ` and ${items.length - max} more` : '')

/** A person by id or username (any case), not deleted; disabled people too, as the web's member check allows. */
function findPerson(ctx: AppContext, ref: string): Person | null {
  return ctx.db.query('SELECT id, name, username, role, status FROM users WHERE deleted_at IS NULL AND (id = ? OR lower(username) = lower(?)) ORDER BY id = ? DESC LIMIT 1').get(ref, ref, ref) as Person | null
}
function findPeople(ctx: AppContext, refs: readonly string[]): { people: Person[]; unknown: string[] } {
  const people = new Map<string, Person>(), unknown: string[] = []
  for (const ref of refs) {
    const p = findPerson(ctx, ref) ?? findPerson(ctx, ref.normalize('NFC'))
    if (p) people.set(p.id, p); else unknown.push(ref)
  }
  return { people: [...people.values()], unknown }
}
function findGroup(ctx: AppContext, ref: string): Group | null {
  const id = getGroup(ctx, ref) ? ref : groupIdByName(ctx, ref) ?? groupIdByName(ctx, ref.normalize('NFC'))
  return id ? getGroup(ctx, id) : null
}
/** The group's folder, or null when it has none or it is in the trash (its row parked under .system/). */
function folderOf(ctx: AppContext, id: string): string | null {
  const p = groupFolder(ctx, id)
  return p && !isParkedRow(p) ? p : null
}
const unknownPeople = (unknown: string[]) => fail(`No such person: ${listOf(unknown.map(quote))}. people_list shows usernames and ids.`)
const unknownGroup = (ref: string) => fail(`No group ${quote(ref)}. groups_list shows the groups.`)

const where = (path: string) => (path === '' ? 'the team root' : path)
function changeWords(c: AccessChange): string {
  if (c.before === 'none') return `now opens ${where(c.path)} (${c.after})`
  if (c.after === 'none') return `loses ${where(c.path)} (had ${c.before})`
  return `${where(c.path)} is now ${c.after} (was ${c.before})`
}

/** Who now opens or loses which folders, in words, bounded. `touched`: the people the change named. */
function accessText(ctx: AppContext, before: AccessState, after: AccessState, touched: readonly Person[]): string {
  const changes = accessChanges(before, after)
  if (!changes.size) {
    const admins = touched.filter((p) => p.role === 'owner' || p.role === 'admin')
    return 'Folder access: nobody opens or loses a folder.' + (admins.length ? ` Owners and admins open every team folder whatever their groups (${listOf(admins.map(show), 5)}).` : '')
  }
  const byId = new Map(after.principals.map((p) => [p.id, p]))
  const rows = [...changes].map(([id, list]) => ({ p: byId.get(id)!, list })).sort((a, b) => a.p.name.localeCompare(b.p.name) || a.p.id.localeCompare(b.p.id))
  const shown = rows.slice(0, GROUP_LIMITS.textPeople)
  const names = new Map((ctx.db.query(`SELECT id, username FROM users WHERE id IN (${shown.map(() => '?').join(',')})`).all(...shown.map((r) => r.p.id)) as { id: string; username: string }[]).map((u) => [u.id, u.username]))
  const lines = [`Folder access changed for ${rows.length} ${rows.length === 1 ? 'person' : 'people'}:`]
  for (const { p, list } of shown) {
    const more = list.length - GROUP_LIMITS.textFolders
    lines.push(`- ${show({ name: p.name, username: names.get(p.id) ?? p.id })}: ${list.slice(0, GROUP_LIMITS.textFolders).map(changeWords).join('; ')}${more > 0 ? `; and ${more} more folders` : ''}`)
  }
  if (rows.length > shown.length) lines.push(`- and ${rows.length - shown.length} more people (Admin › Folder permissions › By person shows each one).`)
  return lines.join('\n')
}

function peopleList(ctx: AppContext, args: unknown): GroupOutcome {
  const input = PeopleListInput.safeParse(args ?? {})
  if (!input.success) return fail('Invalid tool input: send nothing, or query (text).')
  const q = (input.data.query ?? '').normalize('NFC').toLowerCase()
  const all = (ctx.db.query("SELECT id, name, username, role FROM users WHERE status = 'active' AND deleted_at IS NULL ORDER BY name, id").all() as Omit<Person, 'status'>[])
    .filter((p) => !q || p.name.normalize('NFC').toLowerCase().includes(q) || p.username.toLowerCase().includes(q))
  const shown = all.slice(0, GROUP_LIMITS.listPeople)
  const groups = new Map<string, string[]>()
  for (const m of ctx.db.query('SELECT m.user_id, g.name FROM group_members m JOIN groups g ON g.id = m.group_id ORDER BY g.name').all() as { user_id: string; name: string }[]) groups.set(m.user_id, [...(groups.get(m.user_id) ?? []), m.name])
  const people = shown.map((p) => ({ id: p.id, name: p.name, username: p.username, role: p.role, groups: groups.get(p.id) ?? [] }))
  return ok(JSON.stringify({ people, total: all.length, ...(all.length > shown.length ? { more: all.length - shown.length, note: 'Narrow with query.' } : {}) }), { count: people.length })
}

function groupsList(ctx: AppContext, args: unknown): GroupOutcome {
  const input = GroupsListInput.safeParse(args ?? {})
  if (!input.success) return fail('Invalid tool input: send nothing, or group (name or id).')
  let all: Group[]
  if (input.data.group !== undefined) {
    const g = findGroup(ctx, input.data.group)
    if (!g) return unknownGroup(input.data.group)
    all = [g]
  } else all = listGroups(ctx)
  const maxMembers = input.data.group !== undefined ? GROUP_LIMITS.oneGroupMembers : GROUP_LIMITS.groupMembers
  const shown = all.slice(0, GROUP_LIMITS.listGroups)
  const person = ctx.db.query('SELECT id, name, username, status FROM users WHERE id = ?')
  const rules = ctx.db.query("SELECT f.path, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE r.subject_type = 'group' AND r.subject_id = ? ORDER BY f.path")
  const groups = shown.map((g) => {
    const members = g.memberIds.slice(0, maxMembers).map((id) => {
      const u = person.get(id) as { id: string; name: string; username: string; status: string } | null
      return { id, name: u?.name ?? id, username: u?.username ?? id, ...(u && u.status !== 'active' ? { active: false } : {}) }
    })
    // a row parked with a trashed folder is not there, as in Admin › Folder permissions (listFolders)
    const rs = (rules.all(g.id) as { path: string; access: string }[]).filter((r) => !isParkedRow(r.path))
    return {
      id: g.id, name: g.name, description: g.description, folder: folderOf(ctx, g.id),
      members, memberCount: g.memberIds.length, rules: rs.slice(0, GROUP_LIMITS.groupRules), ruleCount: rs.length,
    }
  })
  return ok(JSON.stringify({ groups, total: all.length, ...(all.length > shown.length ? { more: all.length - shown.length, note: 'Ask for one group by name.' } : {}) }), { count: groups.length })
}

function groupCreate(ctx: AppContext, user: Principal, args: unknown): GroupOutcome {
  const input = GroupCreateInput.safeParse(args ?? {})
  if (!input.success) return fail('Invalid tool input: send name (1-100 characters), and optionally description and members (usernames or ids).')
  const found = findPeople(ctx, input.data.members ?? [])
  if (found.unknown.length) return unknownPeople(found.unknown)
  const before = captureState(ctx.db)
  const g = createGroupAs(ctx, user.id, { name: input.data.name, description: input.data.description, memberIds: found.people.map((p) => p.id) }, 'en', { via: 'connector' })
  const after = captureState(ctx.db), folder = folderOf(ctx, g.id)
  const who = found.people.length ? `: ${listOf(found.people.map(show))}` : ''
  return ok(`Created group ${quote(g.name)} (id ${g.id}) with ${g.memberIds.length} ${g.memberIds.length === 1 ? 'member' : 'members'}${who}.${folder ? ` Its folder is ${folder}; the group writes there.` : ''}\n${accessText(ctx, before, after, found.people)}`, { group: g.id, members: g.memberIds.length })
}

function groupUpdate(ctx: AppContext, user: Principal, args: unknown): GroupOutcome {
  const input = GroupUpdateInput.safeParse(args ?? {})
  if (!input.success) return fail('Invalid tool input: send group (name or id) and at least one of name, description, add, remove.')
  const g = findGroup(ctx, input.data.group)
  if (!g) return unknownGroup(input.data.group)
  const add = findPeople(ctx, input.data.add ?? []), remove = findPeople(ctx, input.data.remove ?? [])
  const unknown = [...add.unknown, ...remove.unknown]
  if (unknown.length) return unknownPeople(unknown)
  const both = add.people.filter((p) => remove.people.some((r) => r.id === p.id))
  if (both.length) return fail(`Both added and taken out: ${listOf(both.map(show))}. Name each person once.`)
  if (input.data.name === undefined && input.data.description === undefined && !add.people.length && !remove.people.length) return fail('Nothing to change: send name, description, add or remove.')
  const current = new Set(g.memberIds)
  const added = add.people.filter((p) => !current.has(p.id)), removed = remove.people.filter((p) => current.has(p.id))
  const already = add.people.filter((p) => current.has(p.id)), notIn = remove.people.filter((p) => !current.has(p.id))
  const out = removed.map((p) => p.id)
  const memberIds = add.people.length || remove.people.length ? [...g.memberIds.filter((id) => !out.includes(id)), ...added.map((p) => p.id)] : undefined
  const before = captureState(ctx.db)
  const next = updateGroupAs(ctx, user.id, g.id, { name: input.data.name, description: input.data.description, memberIds }, 'en', { via: 'connector' })
  const after = captureState(ctx.db)
  const said: string[] = []
  if (next.name !== g.name) said.push(`renamed from ${quote(g.name)}`)
  if (input.data.description !== undefined) said.push(input.data.description ? 'description changed' : 'description cleared')
  if (added.length) said.push(`added ${listOf(added.map(show))}`)
  if (removed.length) said.push(`took out ${listOf(removed.map(show))}`)
  if (already.length) said.push(`already in: ${listOf(already.map(show))}`)
  if (notIn.length) said.push(`not in the group: ${listOf(notIn.map(show))}`)
  return ok(`Updated group ${quote(next.name)} (id ${next.id}): ${said.join('; ') || 'no change'}. Members now: ${next.memberIds.length}.\n${accessText(ctx, before, after, [...added, ...removed])}`,
    { group: g.id, added: added.map((p) => p.id), removed: out, renamed: next.name !== g.name })
}

function groupDelete(ctx: AppContext, user: Principal, args: unknown): GroupOutcome {
  const input = GroupDeleteInput.safeParse(args ?? {})
  if (!input.success) return fail('Invalid tool input: send group (name or id).')
  const g = findGroup(ctx, input.data.group)
  if (!g) return unknownGroup(input.data.group)
  const folder = folderOf(ctx, g.id)
  const members = findPeople(ctx, g.memberIds).people
  const before = captureState(ctx.db)
  deleteGroupAs(ctx, user.id, g.id, { via: 'connector' })
  const after = captureState(ctx.db)
  return ok(`Deleted group ${quote(g.name)} (id ${g.id}) and the folder rules that named it.${folder ? ` Its folder ${folder} and its files stay.` : ''}\n${accessText(ctx, before, after, members)}`, { group: g.id, name: g.name })
}

/**
 * Run one group tool for `user`. The caller (RemoteTools.call) checked the grant's mcp:admin scope and that `user` is
 * an active owner or admin right now, and writes the remote_mcp.tool audit line from `audit`.
 */
export function groupTool(ctx: AppContext, oauth: RemoteOAuth, user: Principal, name: string, args: unknown): GroupOutcome {
  if (CHANGES.has(name)) {
    try { oauth.rate('group-change-user', user.id, GROUP_LIMITS.changesPerMinute) } catch (e) {
      if (e instanceof OAuthError) return fail('Too many group changes; retry in a minute.')
      throw e
    }
  }
  try {
    if (name === 'people_list') return peopleList(ctx, args)
    if (name === 'groups_list') return groupsList(ctx, args)
    if (name === 'group_create') return groupCreate(ctx, user, args)
    if (name === 'group_update') return groupUpdate(ctx, user, args)
    if (name === 'group_delete') return groupDelete(ctx, user, args)
    return fail('Unknown tool.')
  } catch (e) {
    // the web's own refusals (name taken, unknown people, a folder that cannot be made): fixed texts, no file contents
    if (e instanceof HttpError) return fail(e.userMessage ?? errorMessage(e.code, 'en'))
    throw e
  }
}
