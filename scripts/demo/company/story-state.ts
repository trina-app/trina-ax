// The state a story ends in (the free-roam demo; scripts/demo/company/README.md "The state a story ends in"): after
// seedDemo made the team, its people, folders and files, this seeds what the people did before the visitor came, from
// a content folder's optional company.json sections:
//
//   rooms        past messages in #everyone, team rooms, DMs and group chats, with files, reactions and mentions, and an
//                answer a person sent from their AI chat ("Send to room")
//   chats        past AI chats (in a project they are shared with its members, beside a room they are its side chat),
//                as plain finished messages: no AI runs
//   connections  a person's Gmail or Google Drive, the team's Higgsfield, with made-up secrets (the demo's fakes answer)
//   welcome      who invited a person (their welcome card on Home)
//   people       each person's job title and e-mail on their profile (set by them)
//   projects     a project with `channel` gets its own chat room, opened by the project's maker (the channel stays as it is)
//   threads      replies under a shared chat's last answer, with @mentions (the answer's asker gets the notice)
//   fileTimes    when the files were changed in the story (on disk and in Files › Recent); recentHidden: the seed's
//                own changes kept out of Recent (team skills, company profile)
//
// Everything a person can do goes through the public REST API as that person. What nobody can do in the product
// (a message sent yesterday, an inviter, a connection without signing in, a finished answer without the AI) goes
// through the snapshot builder's routes (/api/demo/builder/*, server/src/routes/demo-builder.ts): the owner only, and only on a
// server whose demo file says `builder: true`.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { API, ApiClient, ApiError, COMPANY_PROFILE_PATH, type Room } from '../../../shared/src/api'
import type { Fakes } from './fakes'
import { DEMO_PASSWORD } from '../seed'
import type { ContentCompany, DemoContent } from './content'

const nfc = (s: string) => s.normalize('NFC')
const PLACEHOLDER = /\{(project|file):([^}]+)\}/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** the people of the content: the owner first */
function accountsOf(c: ContentCompany) {
  return [{ username: c.owner.username, name: c.owner.name, group: c.owner.group ?? null, title: c.owner.title, email: c.owner.email },
    ...c.people.map((p) => ({ username: p.username, name: p.name, group: p.group, title: p.title, email: p.email }))]
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Who is in a room of the content (usernames). */
export function roomMembers(c: ContentCompany, room: ContentCompany['rooms'][number]): string[] {
  const all = accountsOf(c)
  if (room.kind === 'all') return all.map((a) => a.username)
  if (room.kind === 'team') return all.filter((a) => a.group !== null && nfc(a.group) === nfc(room.group ?? '')).map((a) => a.username)
  return room.people ?? []
}
/** Who is in a project of the content (usernames): its maker, and its members by group or by name. */
export function projectMembers(c: ContentCompany, p: ContentCompany['projects'][number]): string[] {
  const all = accountsOf(c)
  const out = new Set<string>([p.by ?? c.owner.username])
  for (const m of p.members) {
    if ('user' in m) out.add(m.user)
    else for (const a of all) if (a.group && nfc(a.group) === nfc(m.group)) out.add(a.username)
  }
  return [...out]
}

/** Every problem of the story sections (content.ts lists them with the others). */
export function storyProblems(c: ContentCompany, files: string[], fakes: Fakes): string[] {
  const problems: string[] = []
  const all = accountsOf(c)
  const account = (u: string) => all.some((a) => same(a.username, u))
  const person = (u: string) => c.people.some((p) => same(p.username, u))
  const groups = c.groups.map((g) => nfc(g.name))
  const hasFile = (p: string) => files.includes(nfc(p))
  const placeholders = (where: string, text: string) => {
    for (const [, kind, v] of text.matchAll(PLACEHOLDER)) {
      if (kind === 'project' && !c.projects.some((p) => nfc(p.name) === nfc(v!))) problems.push(`${where}: no project "${v}"`)
      if (kind === 'file' && !hasFile(v!)) problems.push(`${where}: no file ${v} in files/`)
    }
  }
  const unique = (what: string, names: string[]) => { for (const [i, n] of names.entries()) if (names.indexOf(n) !== i) problems.push(`${what} "${n}" is there twice`) }
  const oldestFirst = (where: string, times: number[]) => { if (times.some((t, i) => i > 0 && t > times[i - 1]!)) problems.push(`${where}: oldest first (minutesAgo may only go down)`) }
  // what the new hire has not read: someone else's, and only at the end (everything after it is unread too)
  const hire = c.demo.personas.find((p) => p.key === 'newHire')?.username
  const unreadAtEnd = (where: string, list: { from: string; unread?: true }[]) => {
    const first = list.findIndex((x) => x.unread)
    if (first < 0) return
    if (list.slice(first).some((x) => !x.unread)) problems.push(`${where}: "unread" only at the end (everything after an unread message is unread too)`)
    if (hire && list.some((x) => x.unread && same(x.from, hire))) problems.push(`${where}: ${hire}'s own message is never unread for them`)
  }

  unique('project', c.projects.map((p) => nfc(p.name)))
  for (const p of c.projects) {
    if (p.by && !account(p.by)) problems.push(`project ${p.name}: no account "${p.by}"`)
    for (const m of p.members) {
      if ('group' in m && !groups.includes(nfc(m.group))) problems.push(`project ${p.name}: no group "${m.group}"`)
      if ('user' in m && !account(m.user)) problems.push(`project ${p.name}: no account "${m.user}"`)
    }
  }

  for (const p of c.projects.filter((x) => x.channel)) {
    const r = c.rooms.find((y) => y.slug === p.channel)
    // only a private channel links to a project (rooms/project-link.ts isPrivateChannelRow); its maker must be in it
    if (!r) problems.push(`project ${p.name}: no room "${p.channel}"`)
    else if (r.kind !== 'group' || !r.name) problems.push(`project ${p.name}: its channel ${r.slug} is not a private channel (a group chat with a name)`)
    else if (!roomMembers(c, r).some((u) => same(u, p.by ?? c.owner.username))) problems.push(`project ${p.name}: ${p.by ?? c.owner.username} is not in its channel ${r.slug}`)
  }
  for (const [i, path] of (c.fileTimes ?? []).entries()) if (!hasFile(path.path) && !files.some((f) => f.startsWith(nfc(path.path) + '/'))) problems.push(`fileTimes ${i + 1}: no file or folder ${path.path} in files/`)

  unique('room', c.rooms.map((r) => r.slug))
  if (c.rooms.filter((r) => r.kind === 'all').length > 1) problems.push('rooms: one everyone room (kind "all") at most')
  for (const r of c.rooms) {
    const where = `room ${r.slug}`
    if (r.kind === 'team' && (!r.group || !groups.includes(nfc(r.group)))) problems.push(`${where}: a team room needs one of the groups ("group")`)
    if ((r.kind === 'all' || r.kind === 'team') && (r.people || r.name)) problems.push(`${where}: its people are its group's (no "people" or "name")`)
    if (r.kind === 'dm' && (r.people?.length !== 2 || same(r.people[0]!, r.people[1]!))) problems.push(`${where}: a DM is two people`)
    if (r.kind === 'group' && (r.people?.length ?? 0) < 2) problems.push(`${where}: a group chat needs people (the first one makes it)`)
    if ((r.kind === 'dm' || r.kind === 'group') && r.group) problems.push(`${where}: only a team room has a group`)
    for (const u of r.people ?? []) if (!account(u)) problems.push(`${where}: no account "${u}"`)
    const members = roomMembers(c, r)
    const inRoom = (u: string) => members.some((m) => same(m, u))
    oldestFirst(where, r.messages.map((m) => m.minutesAgo))
    for (const [i, m] of r.messages.entries()) {
      const at = `${where} message ${i + 1}`
      if (!inRoom(m.from)) problems.push(`${at}: "${m.from}" is not in the room`)
      for (const x of m.reactions) if (!inRoom(x.from)) problems.push(`${at}: "${x.from}" reacts but is not in the room`)
      for (const f of m.files) if (!hasFile(f)) problems.push(`${at}: no file ${f} in files/`)
      if (!m.text.trim() && !m.files.length && !m.shareChat) problems.push(`${at}: no text, file or shared answer`)
      if (m.shareChat) {
        const chat = c.chats.find((x) => x.slug === m.shareChat)
        if (!chat) problems.push(`${at}: no chat "${m.shareChat}"`)
        else if (!same(chat.username, m.from)) problems.push(`${at}: only ${chat.username} sends the answers of chat ${chat.slug}`)
        else if (chat.turns.at(-1)!.minutesAgo < m.minutesAgo) problems.push(`${at}: sent before chat ${chat.slug} was answered`)
      }
      placeholders(at, m.text)
      // a thread: replies of the room's people, oldest first, after the message they answer
      const thread = m.thread ?? []
      if (thread.length && m.shareChat) problems.push(`${at}: a shared answer has no thread here`)
      oldestFirst(`${at} thread`, thread.map((r) => r.minutesAgo))
      if (thread[0] && thread[0].minutesAgo > m.minutesAgo) problems.push(`${at}: its thread starts before it`)
      for (const [j, r] of thread.entries()) {
        if (!inRoom(r.from)) problems.push(`${at} thread reply ${j + 1}: "${r.from}" is not in the room`)
        for (const x of r.reactions) if (!inRoom(x.from)) problems.push(`${at} thread reply ${j + 1}: "${x.from}" reacts but is not in the room`)
        placeholders(`${at} thread reply ${j + 1}`, r.text)
      }
      unreadAtEnd(`${at} thread`, thread)
    }
    unreadAtEnd(where, r.messages)
    if (r.messages.some((m) => m.unread || m.thread?.some((x) => x.unread)) && !hire) problems.push(`${where}: "unread" needs a new hire (demo persona newHire)`)
    else if (hire && !inRoom(hire) && r.messages.some((m) => m.unread || m.thread?.some((x) => x.unread))) problems.push(`${where}: unread for ${hire}, who is not in the room`)
  }

  unique('chat', c.chats.map((x) => x.slug))
  for (const x of c.chats) {
    const where = `chat ${x.slug}`
    if (!account(x.username)) problems.push(`${where}: no account "${x.username}"`)
    if (x.project && x.sideRoom) problems.push(`${where}: in a project or beside a room, not both`)
    if (x.project) {
      const p = c.projects.find((y) => nfc(y.name) === nfc(x.project!))
      if (!p) problems.push(`${where}: no project "${x.project}"`)
      else if (!projectMembers(c, p).some((u) => same(u, x.username))) problems.push(`${where}: ${x.username} is not in project ${p.name}`)
    }
    if (x.sideRoom) {
      const r = c.rooms.find((y) => y.slug === x.sideRoom)
      if (!r) problems.push(`${where}: no room "${x.sideRoom}"`)
      else if (!roomMembers(c, r).some((u) => same(u, x.username))) problems.push(`${where}: ${x.username} is not in room ${r.slug}`)
    }
    oldestFirst(where, x.turns.map((t) => t.minutesAgo))
    for (const [i, t] of x.turns.entries()) placeholders(`${where} turn ${i + 1}`, t.answer)
    const thread = x.thread ?? []
    if (thread.length) {
      // a thread is under an answer of a shared chat: a project's (chat/threads.ts), seen by its members
      const p = x.project && !x.private ? c.projects.find((y) => nfc(y.name) === nfc(x.project!)) : undefined
      if (!p) problems.push(`${where}: a thread needs a shared project chat`)
      else for (const [i, r] of thread.entries()) if (!projectMembers(c, p).some((u) => same(u, r.from))) problems.push(`${where} thread reply ${i + 1}: ${r.from} is not in project ${p.name}`)
      oldestFirst(`${where} thread`, thread.map((r) => r.minutesAgo))
      if (thread[0]!.minutesAgo > x.turns.at(-1)!.minutesAgo) problems.push(`${where}: the thread starts before the answer`)
    }
  }

  const conn = new Set<string>()
  for (const k of c.connections) {
    const where = `connection ${k.service}`
    if (k.service === 'higgsfield' && k.username) problems.push(`${where}: the team's (no "username")`)
    if (k.service !== 'higgsfield' && (!k.username || !account(k.username))) problems.push(`${where}: a person's own ("username" of one of the people)`)
    const key = `${k.service}:${k.username?.toLowerCase() ?? ''}`
    if (conn.has(key)) problems.push(`${where}${k.username ? ` of ${k.username}` : ''} is there twice`)
    conn.add(key)
  }
  for (const w of c.welcome) {
    if (!person(w.username)) problems.push(`welcome: "${w.username}" is not one of the people (the owner made the team)`)
    if (!account(w.inviter)) problems.push(`welcome ${w.username}: no account "${w.inviter}"`)
  }

  // the fakes: one mailbox and one Drive, the account of a connection of that service
  const accountOf = (service: string, email: string) => c.connections.some((k) => k.service === service && k.account.email.toLowerCase() === email.toLowerCase())
  if (fakes.gmail && !accountOf('gmail', fakes.gmail.me.email)) problems.push(`fakes/gmail.json: me (${fakes.gmail.me.email}) is no gmail connection's account in company.json`)
  if (fakes.drive && !accountOf('google-drive', fakes.drive.me.email)) problems.push(`fakes/drive.json: me (${fakes.drive.me.email}) is no google-drive connection's account in company.json`)
  for (const f of fakes.drive?.files ?? []) if (f.parent && !fakes.drive!.files.some((x) => x.id === f.parent)) problems.push(`fakes/drive.json ${f.id}: no folder "${f.parent}"`)
  const names = new Set(files.map((f) => f.split('/').at(-1)!))
  for (const m of fakes.gmail?.messages ?? []) for (const a of m.attachments ?? []) if (!names.has(nfc(a))) problems.push(`fakes/gmail.json ${m.id ?? m.subject}: the attachment ${a} is no file of files/`)
  // every address is a reserved one: nothing seeded may name a real mailbox
  for (const e of new Set([...JSON.stringify(c).matchAll(EMAIL), ...JSON.stringify(fakes).matchAll(EMAIL)].map((m) => m[0]))) {
    if (!/\.example$/i.test(e)) problems.push(`the address ${e} is not a reserved .example one`)
  }
  return problems
}

export interface StoryResult {
  rooms: Record<string, { id: string; messages: number; replies: number }>
  chats: Record<string, { id: string; answers: string[] }>
  connections: { service: string; username: string | null; id: string }[]
  welcome: number
}

/** a call again after the server's "too fast" (room sends: a burst, then one a second per person) */
async function retrying<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f() } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 429 || i >= 30) throw e
      await Bun.sleep(1100)
    }
  }
}

export async function seedStoryState(o: { baseUrl: string; content: DemoContent; ownerPassword: string; fetch?: typeof fetch; now?: number; log?: (s: string) => void }): Promise<StoryResult> {
  const log = o.log ?? (() => {})
  const c = o.content.company
  const now = o.now ?? Date.now()
  const atOf = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
  const anon = new ApiClient({ baseUrl: o.baseUrl, fetch: o.fetch })
  const clients = new Map<string, ApiClient>()
  const as = async (username: string) => {
    const key = username.toLowerCase()
    let api = clients.get(key)
    if (!api) {
      const password = same(username, c.owner.username) ? o.ownerPassword : DEMO_PASSWORD
      const r = await anon.call(API.login, { body: { username, password, client: 'web', tokenMode: 'bearer' } })
      api = new ApiClient({ baseUrl: o.baseUrl, fetch: o.fetch, token: r.token! })
      clients.set(key, api)
    }
    return api
  }
  const owner = await as(c.owner.username)
  const result: StoryResult = { rooms: {}, chats: {}, connections: [], welcome: 0 }
  try {
    const users = (await owner.call(API.listUsers)).items
    const idOf = (username: string) => {
      const u = users.find((x) => same(x.username, username))
      if (!u) throw new Error(`no account ${username} on the server (seed the team first)`)
      return u.id
    }
    const projects = new Map((await owner.call(API.listProjects, { query: { manage: '1' } })).items.map((p) => [nfc(p.name), p.id]))
    const groups = new Map((await owner.call(API.listGroups)).items.map((g) => [nfc(g.name), g.id]))
    const resolve = (text: string) => text.replace(PLACEHOLDER, (_m, kind: string, v: string) => {
      if (kind === 'file') return `/api/files/download?path=${encodeURIComponent(v)}`
      const id = projects.get(nfc(v))
      if (!id) throw new Error(`no project "${v}" on the server`)
      return `[${v}](/projects/${id})`
    })
    const mentionsIn = (text: string, members: string[]) =>
      users.filter((u) => members.some((m) => same(m, u.username)) && text.includes(`@${u.name}`)).map((u) => u.id)

    // 0. profile photos, each set by its person
    for (const a of o.content.avatars) {
      await (await as(a.username)).call(API.putMyAvatar, { query: { type: a.type }, body: new Uint8Array(fs.readFileSync(a.file)) })
    }

    // 0b. job titles and e-mails, each set by its person (the free-roam audit, QA TC-5619)
    for (const a of accountsOf(c)) {
      if (a.title) await (await as(a.username)).call(API.updateMyProfile, { body: { title: a.title } })
      if (a.email) await (await as(a.username)).call(API.updateMe, { body: { email: a.email } })
    }

    // 1. who invited whom, and the connections (the fakes answer them)
    for (const w of c.welcome) {
      await owner.call(API.demoBuilderWelcome, { body: { userId: idOf(w.username), inviterId: idOf(w.inviter) } })
      result.welcome++
    }
    for (const k of c.connections) {
      const r = await owner.call(API.demoBuilderConnection, { body: { service: k.service, ...(k.username ? { userId: idOf(k.username) } : {}), account: k.account } })
      result.connections.push({ service: k.service, username: k.username ?? null, id: r.id })
      log(`connection ${k.service}${k.username ? ` of ${k.username}` : ' (team)'}`)
    }

    // 2. the rooms: the everyone room and the team rooms are there; DMs and group chats are made by their first person
    const rooms = new Map<string, Room>()
    for (const r of c.rooms) {
      const members = roomMembers(c, r)
      const first = await as(r.kind === 'dm' || r.kind === 'group' ? r.people![0]! : members.find((m) => same(m, c.owner.username)) ?? members[0]!)
      let room: Room | undefined
      if (r.kind === 'dm') room = await retrying(() => first.call(API.createRoom, { body: { kind: 'dm', userId: idOf(r.people![1]!) } }))
      else if (r.kind === 'group') room = await retrying(() => first.call(API.createRoom, { body: { kind: 'group', userIds: r.people!.slice(1).map(idOf), name: r.name ?? null } }))
      else {
        const mine = (await first.call(API.listRooms)).items
        room = r.kind === 'all' ? mine.find((x) => x.kind === 'all') : mine.find((x) => x.kind === 'team' && x.groupId === groups.get(nfc(r.group!)))
      }
      if (!room) throw new Error(`room ${r.slug}: not on the server`)
      rooms.set(r.slug, room)
    }
    // a project with a channel: its own chat room, opened by the project's maker (docs/decisions/20261120-project-is-room.md;
    // the 0.5.21 link of a channel to a project is retired). The channel itself stays the group chat it was
    for (const p of c.projects.filter((x) => x.channel)) {
      await (await as(p.by ?? c.owner.username)).call(API.openProjectRoom, { params: { id: projects.get(nfc(p.name))! } })
      log(`project ${p.name}: its chat room`)
    }

    // 3. the past AI chats: made by their person, answered by the builder (plain finished messages, at their times)
    for (const x of c.chats) {
      const api = await as(x.username)
      const chat = await api.call(API.createChat, {
        body: { title: x.title, ...(x.project ? { projectId: projects.get(nfc(x.project)) } : {}), ...(x.sideRoom ? { sideRoomId: rooms.get(x.sideRoom)!.id } : {}), ...(x.private ? { private: true } : {}) },
      })
      const r = await owner.call(API.demoBuilderChatTurns, { body: { chatId: chat.id, turns: x.turns.map((t) => ({ ask: t.ask, answer: resolve(t.answer), at: atOf(t.minutesAgo) })) } })
      result.chats[x.slug] = { id: chat.id, answers: r.turns.map((t) => t.answerId) }
      log(`chat "${x.title}" of ${x.username}`)
      if (x.thread?.length) {
        const p = c.projects.find((y) => nfc(y.name) === nfc(x.project!))!
        const root = r.turns.at(-1)!.answerId
        const times: { replyId: string; at: string }[] = []
        for (const t of x.thread) {
          const reply = await (await as(t.from)).call(API.sendChatThreadReply, { params: { id: chat.id, messageId: root }, body: { text: t.text, clientId: crypto.randomUUID(), mentions: mentionsIn(t.text, projectMembers(c, p)) } })
          times.push({ replyId: reply.id, at: atOf(t.minutesAgo) })
        }
        await owner.call(API.demoBuilderThreadTimes, { body: { chatId: chat.id, times } })
        log(`chat "${x.title}": ${times.length} thread replies`)
      }
    }

    // 4. the messages and their thread replies, oldest first in each room, as their people; then their times and the
    // reactions. Sent in time order, so the room's positions (seq) follow the story's times and "read up to" means it
    type Item = { m: { from: string; text: string; minutesAgo: number; files: string[]; reactions: { from: string; emoji: string }[]; shareChat?: string; unread?: true }; root: number | null; index: number }
    const unreadPlan = new Map<string, { firstUnreadSeq: number | null; threads: { rootId: string; seqs: number[]; firstUnreadSeq: number | null }[] }>()
    for (const r of c.rooms) {
      const room = rooms.get(r.slug)!
      const members = roomMembers(c, r)
      const sent: { id: string; at: string; seq: number; unread: boolean; root: number | null }[] = []
      const items: Item[] = []
      for (const [i, m] of r.messages.entries()) {
        items.push({ m, root: null, index: i })
        for (const t of m.thread ?? []) items.push({ m: { ...t, files: [] }, root: i, index: i })
      }
      // oldest first; a root before its replies at the same time
      items.sort((p, q) => q.m.minutesAgo - p.m.minutesAgo || (p.root === null ? -1 : 0) - (q.root === null ? -1 : 0))
      const rootIds = new Map<number, string>()
      for (const { m, root, index } of items) {
        const api = await as(m.from)
        const text = resolve(m.text)
        let id: string, seq: number
        if (m.shareChat) {
          const chat = result.chats[m.shareChat]!
          const answer = chat.answers.at(-1)!
          const body = { roomId: room.id, clientMessageId: crypto.randomUUID(), ...(text.trim() ? { note: text } : {}) }
          let out = await retrying(() => api.call(API.shareAnswerToRoom, { params: { id: chat.id, messageId: answer }, body }))
          if (out.status === 'confirm') {
            const confirm = out
            out = await retrying(() => api.call(API.shareAnswerToRoom, { params: { id: chat.id, messageId: answer }, body: { ...body, confirmKey: confirm.confirmKey, attach: confirm.files.filter((f) => f.attach === 'yes' && f.path).map((f) => f.path!) } }))
          }
          if (out.status !== 'sent') throw new Error(`room ${r.slug}: the answer of chat ${m.shareChat} was not sent`)
          id = out.message.id; seq = out.message.seq
        } else {
          const fileIds: string[] = []
          for (const f of m.files) fileIds.push((await retrying(() => api.call(API.attachRoomTeamFile, { params: { id: room.id }, body: { path: f } }))).file.id)
          const mentions = mentionsIn(m.text, members)
          const threadRootId = root === null ? null : rootIds.get(root)!
          const sentMsg = await retrying(() => api.call(API.sendRoomMessage, { params: { id: room.id }, body: { body: text, mentions, fileIds, clientMessageId: crypto.randomUUID(), ...(threadRootId ? { threadRootId } : {}) } }))
          id = sentMsg.id; seq = sentMsg.seq
        }
        if (root === null) rootIds.set(index, id)
        for (const x of m.reactions) await retrying(async () => (await as(x.from)).call(API.reactRoomMessage, { params: { id: room.id, messageId: id }, body: { emoji: x.emoji, on: true } }))
        sent.push({ id, at: atOf(m.minutesAgo), seq, unread: !!m.unread, root: root === null ? null : root })
      }
      // every line of the room gets a time: a sent message its own (thread replies too), the room's own lines ("… made
      // this group") the time of the message after them (or before, at the end)
      const timeline = await roomTimeline(await as(members.find((m) => same(m, c.owner.username)) ?? members[0]!), room.id)
      const known = new Map(sent.map((s) => [s.id, s.at]))
      const times: { messageId: string; at: string }[] = []
      let next: string | null = null
      for (const m of [...timeline].reverse()) {
        const at: string | null = known.get(m.id) ?? (next ? new Date(Date.parse(next) - 60_000).toISOString() : null)
        if (at) { times.push({ messageId: m.id, at }); next = at }
      }
      for (const m of timeline) if (!times.some((t) => t.messageId === m.id) && sent.length) times.push({ messageId: m.id, at: sent.at(-1)!.at })
      for (const x of sent) if (!times.some((t) => t.messageId === x.id)) times.push({ messageId: x.id, at: x.at })
      // the seed's "joined" lines are today's, not the story's: gone from the everyone room and the team rooms
      const dated = await owner.call(API.demoBuilderRoomTimes, { body: { roomId: room.id, times, dropJoinLines: r.kind === 'all' || r.kind === 'team' } })
      result.rooms[r.slug] = { id: room.id, messages: sent.filter((x) => x.root === null).length, replies: sent.filter((x) => x.root !== null).length }
      // what step 5 leaves unread for the new hire: from the first unread message of the timeline, and of each thread
      const firstSeq = (list: typeof sent) => list.find((x) => x.unread)?.seq ?? null
      unreadPlan.set(r.slug, {
        firstUnreadSeq: firstSeq(sent.filter((x) => x.root === null)),
        threads: [...rootIds.entries()].map(([i, rootId]) => {
          const replies = sent.filter((x) => x.root === i)
          return { rootId, seqs: replies.map((x) => x.seq), firstUnreadSeq: firstSeq(replies) }
        }).filter((t) => t.seqs.length),
      })
      log(`room ${r.slug}: ${result.rooms[r.slug]!.messages} messages, ${result.rooms[r.slug]!.replies} thread replies (${dated.updated} dated${dated.dropped ? `, ${dated.dropped} join lines dropped` : ''})`)
    }

    // 4b. the files' times in the story, and the seed's own changes out of Files › Recent (the free-roam audit, QA TC-5618)
    const memoryTimes = c.memories.filter((m) => m.minutesAgo !== undefined).map((m) => ({ userId: idOf(m.username), text: m.text, at: atOf(m.minutesAgo!) }))
    if (c.fileTimes?.length || c.recentHidden?.length || memoryTimes.length) {
      // the company profile the seed saved is dated with the team skills' folder too (QA TC-5935)
      const files = [...o.content.files, ...(c.profile ? [COMPANY_PROFILE_PATH] : [])]
      const times: { path: string; at: string }[] = []
      for (const f of files) {
        const hit = (c.fileTimes ?? []).find((t) => nfc(f) === nfc(t.path) || nfc(f).startsWith(nfc(t.path) + '/'))
        // a person's own file is at users/<their id>/ on the server (seed.ts)
        const own = /^users\/([^/]+)\//.exec(f)?.[1]
        if (hit) times.push({ path: own ? `users/${idOf(own)}${f.slice(`users/${own}`.length)}` : f, at: atOf(hit.minutesAgo) })
      }
      const r = await owner.call(API.demoBuilderFileTimes, { body: { times, hideFromRecent: c.recentHidden ?? [], memories: memoryTimes } })
      log(`files: ${r.updated} dated, ${r.hidden} seed changes out of Recent`)
    }

    // 5. everyone has read what was there when the visitor arrives, the threads they follow too (the room's read
    // position never covers them); for the new hire, all but what the content marks unread (the end of a room or of a
    // thread). The welcome rows asked for are done
    const hire = c.demo.personas.find((p) => p.key === 'newHire')?.username
    for (const a of accountsOf(c)) {
      const api = await as(a.username)
      const isHire = !!hire && same(a.username, hire)
      const slugOf = new Map([...rooms.entries()].map(([slug, room]) => [room.id, slug]))
      for (const room of (await api.call(API.listRooms)).items) {
        const plan = unreadPlan.get(slugOf.get(room.id) ?? '')
        const upTo = isHire && plan?.firstUnreadSeq ? plan.firstUnreadSeq - 1 : room.lastSeq
        if (upTo > 0) await api.call(API.markRoomRead, { params: { id: room.id }, body: { seq: upTo } })
        for (const t of plan?.threads ?? []) {
          const to = isHire && t.firstUnreadSeq ? t.firstUnreadSeq - 1 : Math.max(...t.seqs)
          // only a thread they follow has a read position (wrote the root, replied, or were mentioned)
          await api.call(API.markRoomThreadRead, { params: { id: room.id, messageId: t.rootId }, body: { seq: to } }).catch((e) => { if (!(e instanceof ApiError) || e.status !== 404) throw e })
        }
      }
    }
    for (const w of c.welcome.filter((x) => x.asked)) await (await as(w.username)).call(API.updateMemberWelcome, { body: { asked: true } }).catch(() => {})
    // the people were in their projects long before the visitor came: "<who> added you to '<project>'" (#335, QA
    // TC-r2u-03), which the seed's own member changes raise, is read
    for (const a of accountsOf(c)) {
      const api = await as(a.username)
      const items = (await api.call(API.listNotifications, { query: { limit: 100 } })).items
      for (const n of items.filter((x) => x.eventType === 'project.joined' && !x.readAt)) await api.call(API.markNotificationRead, { params: { id: n.id } })
    }
    return result
  } finally {
    for (const api of clients.values()) await api.call(API.logout).catch(() => {})
  }
}

/** Every line of a room, oldest first, as `viewer` (a member) sees it. */
async function roomTimeline(viewer: ApiClient, roomId: string): Promise<{ id: string }[]> {
  const out: { id: string; seq: number }[] = []
  let cursor: string | undefined
  for (let i = 0; i < 50; i++) {
    const page = await viewer.call(API.listRoomMessages, { params: { id: roomId }, query: { limit: 200, ...(cursor ? { cursor } : {}) } })
    out.push(...page.items.map((m) => ({ id: m.id, seq: m.seq })))
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  return out.sort((a, b) => a.seq - b.seq)
}
