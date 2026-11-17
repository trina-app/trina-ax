// Who can open what, between cases. A case that grants access, changes a project's or a group's people, moves a skill
// or says "Always allow" changes the team for every case after it. On 2026-11-17 three such changes leaked: a project
// member added by PRJ-03 made PRJ-01.outsider a member, a folder view given by ADM-02.admin let ORG-05.no-write see the
// sales folder, and the skill CTX-01 moved made every SKL-01 variant miss it. So the runner reads this state from the
// server's database (read-only) when the run starts, compares after every case, records what changed on the case's
// result and puts it back through the public API (as the owner, or as the person for their own allowances).
//
// Put back: folder rules (project members are rules on the project folder too) and Limit access, group members, team
// skills moved out of their seeded folder, "Always allow" choices, the members of the rooms that were there at the start
// (invite / remove through the room's own API, as a member of it) and the people and groups a file is shared with (the
// file's owner removes or re-adds them; a link that was made stays, it opens for nobody without a grant).
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { API, type ApiClient, type FolderRuleInput } from '../../../shared/src/api'

export type State = Record<'rules' | 'groups' | 'skills' | 'always' | 'rooms' | 'links', string[]>
const KEYS: (keyof State)[] = ['rules', 'groups', 'skills', 'always', 'rooms', 'links']

const q = (db: Database, sql: string) => (db.query(sql).all() as Record<string, unknown>[]).map((r) => Object.values(r).map((v) => v ?? '').join('|')).sort()

/** the team skills on disk: every <...>/skills/<name>/SKILL.md (never inside users/, the trash or system folders) */
function skillDirs(teamRoot: string): string[] {
  const out: string[] = []
  const walk = (rel: string, depth: number) => {
    if (depth > 6) return
    let names: fs.Dirent[]
    try { names = fs.readdirSync(path.join(teamRoot, rel), { withFileTypes: true }) } catch { return }
    for (const d of names) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      const r = rel ? `${rel}/${d.name}` : d.name
      if (!rel && d.name === 'users') continue
      if (path.posix.basename(rel) === 'skills' && fs.existsSync(path.join(teamRoot, r, 'SKILL.md'))) out.push(r.normalize('NFC'))
      else walk(r, depth + 1)
    }
  }
  walk('', 0)
  return out.sort()
}

export function stateOf(dataDir: string, teamRoot: string): State {
  const db = new Database(path.join(dataDir, 'app.db'), { readonly: true })
  try {
    return {
      rules: [
        ...q(db, 'SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id'),
        ...q(db, "SELECT path, 'limited' FROM folders WHERE limited = 1"),
      ].map((s) => s.normalize('NFC')).sort(),
      groups: q(db, 'SELECT group_id, user_id FROM group_members'),
      skills: skillDirs(teamRoot),
      always: q(db, 'SELECT user_id, kind FROM card_always_allow'),
      rooms: q(db, 'SELECT room_id, user_id FROM room_members'),
      // one line per grant: path | owner | who it is shared with
      links: q(db, "SELECT s.path, COALESCE(s.owner_id, ''), g.subject_type, g.subject_id FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.state = 'live'").map((s) => s.normalize('NFC')),
    }
  } finally { db.close() }
}

/** what differs from `base`: "+ rules: x" / "- skills: y" */
export function driftOf(base: State, now: State): string[] {
  const out: string[] = []
  for (const k of KEYS) {
    const a = new Set(base[k]), b = new Set(now[k])
    for (const x of now[k]) if (!a.has(x)) out.push(`+ ${k}: ${x}`)
    for (const x of base[k]) if (!b.has(x)) out.push(`- ${k}: ${x}`)
  }
  return out
}

export interface ResetDeps {
  owner: ApiClient
  as: (username: string) => Promise<ApiClient>
  /** user id -> username (ids in the database are user ids) */
  username: (id: string) => string | null
  /** the fixture copy of a team path (to put a moved skill back) */
  fixtureDir: (rel: string) => string | null
  log: (s: string) => void
}

/** Make a team folder and the folders above it when they are missing (an upload into a folder that is gone is refused:
 * after a skill moved, its old folder is not there to put the fixture copy back into) */
export async function ensureFolder(api: ApiClient, rel: string) {
  const parts = rel.split('/').filter(Boolean)
  for (let i = 1; i <= parts.length; i++) {
    try { await api.call(API.mkdir, { body: { path: parts.slice(0, i).join('/') } }) } catch { /* there already */ }
  }
}

const byPath = (lines: string[]) => {
  const m = new Map<string, { rules: FolderRuleInput[]; limited: boolean }>()
  for (const l of lines) {
    const [p, a, b, c] = l.split('|') as [string, string, string, string | undefined]
    const e = m.get(p) ?? { rules: [], limited: false }
    if (a === 'limited' && c === undefined) e.limited = true
    else e.rules.push({ subjectType: a, subjectId: b || null, access: c } as FolderRuleInput)
    m.set(p, e)
  }
  return m
}
const key = (e: { rules: FolderRuleInput[]; limited: boolean } | undefined) => e ? JSON.stringify([e.limited, e.rules.map((r) => `${r.subjectType}|${r.subjectId}|${r.access}`).sort()]) : ''

/** Put what can be put back as it was in `base`; returns what is still different afterwards (for the record). */
export async function resetTo(base: State, now: State, d: ResetDeps, again: () => State): Promise<string[]> {
  // folder rules (project members included)
  const was = byPath(base.rules), is = byPath(now.rules)
  const changed = [...new Set([...was.keys(), ...is.keys()])].filter((p) => key(was.get(p)) !== key(is.get(p)))
  if (changed.length) {
    const folders = new Map((await d.owner.call(API.listFolders)).items.map((f) => [f.path.normalize('NFC'), f]))
    for (const p of changed) {
      const f = folders.get(p)
      try {
        const want = was.get(p)
        // a team project's folder: its people change only through the project (the folder rules API refuses it)
        const project = want && p.startsWith('projects/') ? (await d.owner.call(API.listProjects, { query: { manage: '1' } })).items.find((x) => x.folderPath.normalize('NFC') === p) : undefined
        if (want && project) {
          const access = await d.owner.call(API.getProjectAccess, { params: { id: project.id } })
          const participants = want.rules.filter((r) => r.access === 'write' && (r.subjectType === 'user' || r.subjectType === 'group') && r.subjectId).map((r) => ({ subjectType: r.subjectType as 'user' | 'group', subjectId: r.subjectId! }))
          await d.owner.call(API.putProjectParticipants, { params: { id: project.id }, body: { participants, expectedHash: access.rulesHash } })
        } else if (want && f) await d.owner.call(API.putFolderRules, { params: { id: f.id }, body: { rules: want.rules, limited: want.limited, ...(f.rulesHash ? { expectedHash: f.rulesHash } : {}) } })
        else if (want) await d.owner.call(API.createFolder, { body: { path: p, rules: want.rules, ...(want.limited ? { limited: true } : {}) } })
        else if (f && !f.keep) await d.owner.call(API.deleteFolder, { params: { id: f.id } })
      } catch (e) { d.log(`reset rules ${p}: ${e instanceof Error ? e.message : e}`) }
    }
  }
  // group members
  const members = (lines: string[]) => { const m = new Map<string, string[]>(); for (const l of lines) { const [g, u] = l.split('|') as [string, string]; m.set(g, [...(m.get(g) ?? []), u].sort()) } return m }
  const gWas = members(base.groups), gIs = members(now.groups)
  for (const g of new Set([...gWas.keys(), ...gIs.keys()])) {
    if (JSON.stringify(gWas.get(g) ?? []) === JSON.stringify(gIs.get(g) ?? [])) continue
    try { await d.owner.call(API.updateGroup, { params: { id: g }, body: { memberIds: gWas.get(g) ?? [] } }) } catch (e) { d.log(`reset group ${g}: ${e instanceof Error ? e.message : e}`) }
  }
  // a seeded skill that moved: its files come back from the fixture, the moved copy goes to the trash
  const sWas = new Set(base.skills), sIs = new Set(now.skills)
  const gone = base.skills.filter((s) => !sIs.has(s))
  for (const s of gone) {
    const src = d.fixtureDir(s)
    if (!src) { d.log(`reset skill ${s}: no fixture copy`); continue }
    for (const file of fs.readdirSync(src, { recursive: true, withFileTypes: true }).filter((x) => x.isFile())) {
      const abs = path.join(file.parentPath, file.name)
      const rel = path.posix.join(s, path.relative(src, abs).split(path.sep).join('/'))
      try { await ensureFolder(d.owner, path.posix.dirname(rel)); await d.owner.call(API.upload, { body: { fields: { folder: path.posix.dirname(rel), name: file.name, onExists: 'replace' }, file: new Blob([fs.readFileSync(abs)]), filename: file.name } }) } catch (e) { d.log(`reset skill ${rel}: ${e instanceof Error ? e.message : e}`) }
    }
    for (const moved of now.skills.filter((x) => !sWas.has(x) && path.posix.basename(x) === path.posix.basename(s))) {
      try { await d.owner.call(API.remove, { query: { path: moved } }) } catch (e) { d.log(`reset skill ${moved}: ${e instanceof Error ? e.message : e}`) }
    }
  }
  // "Always allow" given during the case: taken back as that person
  const aWas = new Set(base.always)
  for (const l of now.always.filter((x) => !aWas.has(x))) {
    const [uid, kind] = l.split('|') as [string, string]
    const u = d.username(uid)
    if (!u) continue
    try {
      const api = await d.as(u)
      for (const a of (await api.call(API.listAiAllowances)).items) if (a.kind === 'card' && a.card === kind) await api.call(API.deleteAiAllowance, { params: { id: a.id } })
    } catch (e) { d.log(`reset always ${u} ${kind}: ${e instanceof Error ? e.message : e}`) }
  }
  // room members: of the rooms that existed at the start, as a member of that room (its manager, or an owner or admin in it)
  const roomIds = new Set(base.rooms.map((l) => l.split('|')[0]!))
  const rWas = new Map<string, string[]>(), rIs = new Map<string, string[]>()
  for (const [src, dst] of [[base.rooms, rWas], [now.rooms, rIs]] as const) for (const l of src) { const [r, u] = l.split('|') as [string, string]; dst.set(r, [...(dst.get(r) ?? []), u]) }
  for (const room of roomIds) {
    const was = rWas.get(room) ?? [], is = rIs.get(room) ?? []
    const add = was.filter((u) => !is.includes(u)), drop = is.filter((u) => !was.includes(u))
    if (!add.length && !drop.length) continue
    const stay = was.filter((u) => is.includes(u)).map((u) => d.username(u)).filter((u): u is string => !!u)
    for (const who of [...stay, 'jiwoo']) {
      try {
        const api = await d.as(who)
        if (add.length) await api.call(API.inviteRoomMembers, { params: { id: room }, body: { userIds: add } })
        for (const u of drop) await api.call(API.removeRoomMember, { params: { id: room, userId: u } })
        break
      } catch (e) { d.log(`reset room ${room} as ${who}: ${e instanceof Error ? e.message : e}`) }
    }
  }
  // file shares: grants given during the case are taken back, grants that were removed come back, by the file's owner
  // (a team file: the team owner)
  const grants = (lines: string[]) => { const m = new Map<string, Set<string>>(); for (const l of lines) { const [path, owner, type, id] = l.split('|') as [string, string, string, string]; const k = `${path}|${owner}`; (m.get(k) ?? m.set(k, new Set()).get(k)!).add(`${type}|${id}`) } return m }
  const lWas = grants(base.links), lIs = grants(now.links)
  for (const k of new Set([...lWas.keys(), ...lIs.keys()])) {
    const w = lWas.get(k) ?? new Set<string>(), i = lIs.get(k) ?? new Set<string>()
    const subj = (x: string) => { const [subjectType, subjectId] = x.split('|') as ['user' | 'group', string]; return { subjectType, subjectId } }
    const add = [...w].filter((x) => !i.has(x)).map(subj), remove = [...i].filter((x) => !w.has(x)).map(subj)
    if (!add.length && !remove.length) continue
    const [path, ownerId] = k.split('|') as [string, string]
    try { await (await d.as((ownerId && d.username(ownerId)) || 'jiwoo')).call(API.putFileShares, { body: { path, add, remove } }) } catch (e) {
      try { await d.owner.call(API.putFileShares, { body: { path, add, remove } }) } catch { d.log(`reset file share ${path}: ${e instanceof Error ? e.message : e}`) }
    }
  }
  return driftOf(base, again())
}
