// The demo's backend: the e2e mock server (web/test/mock/server.ts, which answers the whole REST API and WebSocket
// protocol against the shared contract) running in the page, with three things replaced
// (docs/AGENTS/plan/20261114-0507-mina-demo.md):
// - the seed: the story's people, groups, rooms, projects, past chats and files instead of the e2e team;
// - the AI: the story's canned answers (steps, streamed text, files, cards) instead of the mock's keywords;
// - the rooms: the messages the mock does not keep (the visitor's own, the story's people's, their files).
// The visitor is always signed in (a member, so the admin pages and permission settings are not offered).
import { Room, RoomMessage, RoomTypingFrame, uuidv7, type Chat, type Message, type RoomFile, type ServerEventInput, type Step, type TurnRequest, type User } from '@mycel/shared/api'
import { MockServer } from '../test/mock/server'
import type { DemoAsk, DemoEvent, DemoFile, DemoReply, DemoScript, DemoStep } from './script'
import { StoryEngine, type Place } from './engine'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()
const enc = new TextEncoder()
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', pdf: 'application/pdf' }
const mimeOf = (p: string) => MIME[p.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream'
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
/** typing speed of a streamed answer: characters per piece and the pause between pieces */
const PIECE = 6
const PIECE_MS = 22

export class DemoServer extends MockServer {
  script!: DemoScript
  assets!: Record<string, Uint8Array>
  engine!: StoryEngine
  /** the story's ids → the app's ids (rooms, projects, past chats, groups) */
  ids = new Map<string, string>()
  /** a room file's bytes by its id (the story's attachments and what the visitor sends) */
  roomFiles = new Map<string, Uint8Array>()
  avatars = new Map<string, Uint8Array>()

  constructor(script: DemoScript, assets: Record<string, Uint8Array>) {
    // no e2e team first (setup: the mock's own seed is skipped), then the story's
    super({ setup: true })
    this.script = script
    this.assets = assets
    this.engine = new StoryEngine(script, (ev) => void this.postEvent(ev))
    this.installDemoHandlers()
    this.reset()
  }

  // ---------------- seed ----------------

  override seed() {
    // MockServer's constructor resets before this class has its script; the second reset (above) seeds
    if (!this.script) return
    const s = this.script
    this.cloud = true // a hosted team: no development banner, no server settings
    this.settings.teamName = s.company.name
    this.settings.defaultLocale = s.locale
    this.ids = new Map()
    this.roomFiles = new Map()
    this.avatars = new Map()
    for (const p of ['shared', 'groups', 'projects', 'skills', 'users']) this.folder(p)
    this.groups = s.groups.map((g) => ({ id: this.idOf('group', g.id), name: g.name, description: '', memberIds: g.members }))
    for (const p of s.people) {
      this.addUser({ id: p.id, username: p.id, name: p.name, role: 'member', groupIds: s.groups.filter((g) => g.members.includes(p.id)).map((g) => this.idOf('group', g.id)), localeChoice: null }, uuidv7())
      this.folder(`users/${p.id}`)
      const pic = p.avatar && this.assets[p.avatar]
      if (pic) this.avatars.set(p.id, pic)
    }
    for (const g of s.groups) this.folder(`groups/${g.name}`)
    for (const f of s.files) this.putDemoFile(f)
    for (const pr of s.projects) this.seedProject(pr)
    for (const r of s.rooms) this.seedRoom(r)
    const lead = s.events[0] ? s.events[0].from : null
    const inviter = lead ? this.users.find((u) => u.id === lead) : undefined
    this.memberWelcome = {
      team: s.company.name, inviter: inviter ? { id: inviter.id, name: inviter.name } : null, people: s.people.length,
      rooms: this.rooms.filter((r) => r.kind === 'all' || r.kind === 'team').map((r) => ({ id: r.id, kind: r.kind as 'all' | 'team', name: r.name })),
      owner: null, steps: { rooms: true, hi: true, photo: true, asked: false }, allSet: false,
    }
  }

  idOf(kind: string, id: string): string {
    const key = `${kind}:${id}`
    let v = this.ids.get(key)
    if (!v) { v = uuidv7(); this.ids.set(key, v) }
    return v
  }
  /** the story's id of an app id (a room's or a project's) */
  storyId(kind: string, appId: string): string | null {
    for (const [k, v] of this.ids) if (v === appId && k.startsWith(`${kind}:`)) return k.slice(kind.length + 1)
    return null
  }

  folder(p: string) {
    if (!this.files.has(p)) this.files.set(p, { type: 'folder', mtime: now() })
  }

  putDemoFile(f: DemoFile) {
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) this.folder(parts.slice(0, i).join('/'))
    const asset = f.asset ? this.engine.pickAsset(f) : undefined
    const data = asset ? this.assets[asset] : enc.encode(f.text ?? '')
    if (!data) throw new Error(`demo: no asset ${asset} for ${f.path}`)
    this.putFile(f.path, data)
  }

  seedProject(pr: DemoScript['projects'][number]) {
    const folderPath = `projects/${pr.name}`
    this.folder(folderPath)
    const creator = pr.members.find((m) => m !== this.script.visitor) ?? pr.members[0]!
    this.projectMembers.set(folderPath, { creator, participants: pr.members.map((m) => ({ subjectType: 'user' as const, subjectId: m })), version: 1 })
    const by = this.person(creator)
    this.projects.push({ id: this.idOf('project', pr.id), name: pr.name, folderPath, instructions: pr.description ?? '', createdBy: { id: by.id, name: by.name }, createdAt: now(), canEdit: true })
    const at = Date.now() - 3 * 3600_000
    for (const c of pr.chats ?? []) {
      const who = this.person(c.by)
      const id = this.idOf('chat', c.id)
      const chat: Chat = { id, projectId: this.idOf('project', pr.id), title: c.title, engine: 'claude-code', model: null, createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), deletedAt: null, runState: 'idle' }
      this.chats.push(chat)
      this.chatOwners.set(id, who.id)
      this.sharedChats.set(id, { by: { id: who.id, name: who.name }, projectId: chat.projectId!, runner: null, waiting: false })
      let parent: string | null = null
      for (const t of c.turns) {
        const q = this.message({ chatId: id, role: 'user', parentId: parent, content: t.ask, author: { id: who.id, name: who.name }, createdAt: chat.createdAt })
        const a = this.message({ chatId: id, role: 'assistant', parentId: q.id, content: this.resolve(t.answer), engine: 'claude-code', model: 'claude-sonnet', turnId: uuidv7(), createdAt: chat.createdAt,
          ...(t.files?.length ? { files: { saved: t.files.map((path) => ({ path, action: 'create' as const })), conflicts: [], rejected: [] } } : {}) })
        parent = a.id
      }
      if (parent) this.activeLeaf.set(id, parent)
    }
  }

  seedRoom(r: DemoScript['rooms'][number]) {
    const id = this.idOf('room', r.id)
    const me = this.script.visitor
    const others = r.members.filter((m) => m !== me).map((m) => this.ref(m))
    const group = r.group ? this.script.groups.find((g) => g.id === r.group) : undefined
    const msgs = r.messages ?? []
    const created = new Date(Date.now() - 24 * 3600_000).toISOString()
    const room = Room.parse({
      id, kind: r.kind, name: r.kind === 'team' ? group?.name ?? r.name ?? null : r.kind === 'group' ? r.name ?? null : null,
      canRename: false, managerId: null, groupId: group ? this.idOf('group', group.id) : null, memberCount: r.members.length,
      peers: others.slice(0, 4), lastSeq: 0, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0,
      lastMessage: null, muted: false, createdAt: created, activityAt: created,
    })
    this.rooms.push(room)
    this.roomMessages.set(id, [])
    msgs.forEach((m, i) => {
      const ago = m.minutesAgo ?? (msgs.length - i) * 5 + 5
      this.addRoomMessage(room, m.from, m.text, m.files ?? [], new Date(Date.now() - ago * 60_000).toISOString(), true)
    })
  }

  person(id: string): User {
    return this.users.find((u) => u.id === id) ?? (() => { throw new Error(`demo: no person ${id}`) })()
  }
  ref(id: string) {
    const u = this.person(id)
    return { id: u.id, name: u.name }
  }

  /** {{project:id}}, {{room:id}} as Markdown links, {{file:path}} as the file's address */
  resolve(text: string): string {
    return text.replace(/\{\{(project|room|file):([^}]+)\}\}/g, (_m, kind: string, id: string) => {
      if (kind === 'file') return `/api/files/download?path=${encodeURIComponent(id)}`
      if (kind === 'project') {
        const p = this.script.projects.find((x) => x.id === id)
        return p ? `[${p.name}](/projects/${this.idOf('project', id)})` : id
      }
      const r = this.script.rooms.find((x) => x.id === id)
      const g = r?.group ? this.script.groups.find((x) => x.id === r.group) : undefined
      return `[${g ? `#${g.name}` : r?.name ?? id}](/rooms/${this.idOf('room', id)})`
    })
  }

  // ---------------- rooms ----------------

  addRoomMessage(room: Room, from: string, text: string, paths: string[], at: string, read: boolean): RoomMessage {
    const list = this.roomMessages.get(room.id) ?? []
    const files: RoomFile[] = paths.map((p) => {
      const data = this.files.get(p)?.data
      if (!data) throw new Error(`demo: no file ${p} to attach`)
      const fid = uuidv7()
      this.roomFiles.set(fid, data)
      const mime = mimeOf(p)
      return { id: fid, name: baseName(p), size: data.byteLength, mime, kind: mime.startsWith('image/') ? 'image' : 'document', thumb: mime.startsWith('image/') }
    })
    const seq = Math.max(room.lastSeq, 0, ...list.map((x) => x.seq)) + 1
    const message = RoomMessage.parse({
      id: uuidv7(), roomId: room.id, seq, authorKind: 'user', author: this.ref(from), askedBy: null, visibility: 'room', body: this.resolve(text), replyTo: null,
      mentions: [], files, createdAt: at, editedAt: null, deletedAt: null,
    })
    list.push(message)
    this.roomMessages.set(room.id, list)
    const mine = from === this.script.visitor
    Object.assign(room, {
      lastSeq: seq, activityAt: at,
      lastMessage: { id: message.id, seq, author: message.author, excerpt: message.body.slice(0, 120), fileCount: files.length, deleted: false, createdAt: at },
      ...(read || mine ? { lastReadSeq: seq, unreadCount: 0 } : { unreadCount: room.unreadCount + 1 }),
    })
    return message
  }

  /** a story person's message, when its trigger happened: "typing…" for a moment, then the message */
  async postEvent(ev: DemoEvent) {
    const room = this.rooms.find((r) => r.id === this.idOf('room', ev.room ?? ''))
    // a script error, loud: every step chained on this message would wait for good
    if (!room) throw new Error(`demo: event ${ev.id} names no room ${ev.room}`)
    const gen = this.generation
    for (const f of ev.newFiles ?? []) this.putDemoFile(f)
    const typing = (on: boolean) => {
      const frame = JSON.stringify(RoomTypingFrame.parse({ type: 'room.typing', roomId: room.id, threadRootId: null, userId: ev.from, typing: on }))
      for (const ws of this.sockets) ws.send(frame)
    }
    typing(true)
    await sleep(1100)
    if (gen !== this.generation) return
    typing(false)
    const message = this.addRoomMessage(room, ev.from, ev.text ?? '', ev.files ?? [], now(), false)
    this.publish({ type: 'room.message', data: { roomId: room.id, message } })
    this.publish({ type: 'room.updated', data: { roomId: room.id, change: 'updated', room } })
    this.engine.fire({ event: ev.id })
  }

  private installDemoHandlers() {
    const h = this.handlers
    h.sendRoomMessage = (c) => {
      const room = this.rooms.find((r) => r.id === c.params.id) ?? this.notFound()
      const message = this.addRoomMessage(room, c.user.id, '', [], now(), true)
      // the visitor's words as written (never resolved like the story's)
      Object.assign(message, { body: c.body.body, mentions: c.body.mentions ?? [] })
      if (room.lastMessage) room.lastMessage.excerpt = message.body.slice(0, 120)
      this.publish({ type: 'room.message', data: { roomId: room.id, message } })
      this.publish({ type: 'room.updated', data: { roomId: room.id, change: 'updated', room } })
      return { status: 201, body: message }
    }
    // Stop while a card waits: the card closes and the answer ends stopped (the mock's stop only marks the turn)
    const stop = h.stop!
    h.stop = async (c) => {
      const out = (await stop(c)) as { turnId: string | null }
      const waiting = out.turnId ? this.pendingAsk.get(out.turnId) : undefined
      if (waiting) { this.pendingAsk.delete(out.turnId!); waiting(null) }
      return out
    }
    h.roomFile = (c) => {
      const data = this.roomFiles.get(c.params.fileId!) ?? this.notFound()
      const m = [...this.roomMessages.values()].flat().flatMap((x) => x.files).find((f) => f.id === c.params.fileId)
      return new Response(data.slice(), { headers: { 'content-type': m?.mime ?? 'application/octet-stream', 'cache-control': 'no-store' } })
    }
    h.personAvatar = (c) => {
      const data = this.avatars.get(c.params.id!) ?? this.notFound()
      return new Response(data.slice(), { headers: { 'content-type': mimeOf(this.script.people.find((p) => p.id === c.params.id)?.avatar ?? 'a.png') } })
    }
    h.listRoomThread = (c) => {
      const root = (this.roomMessages.get(c.params.id!) ?? []).find((m) => m.id === c.params.messageId) ?? this.notFound()
      return { root, items: [], nextCursor: null, lastReadSeq: 0 }
    }
    // a hosted team's notices in the mock (maintenance tonight…) are not part of the story
    h.managedNotices = () => ({ items: [] })
    const me = h.me!
    h.me = async (c) => {
      const out = (await me(c)) as { user: { id: string; title?: string } }
      const p = this.script.people.find((x) => x.id === out.user.id)
      return { ...out, user: { ...out.user, ...(this.avatars.has(out.user.id) ? { avatarVersion: 1 } : {}), ...(p?.title ? { title: p.title } : {}) } }
    }
    const people = h.listPeople!
    h.listPeople = async (c) => {
      const out = (await people(c)) as { people: { id: string }[] }
      return { people: out.people.map((p) => (this.avatars.has(p.id) ? { ...p, avatarVersion: 1 } : p)) }
    }
    // "대화방에 보내기" from an answer: the story goes on in that room
    const share = h.shareAnswerToRoom!
    h.shareAnswerToRoom = async (c) => {
      const out = (await share(c)) as { status: string }
      const room = this.storyId('room', c.body.roomId)
      if (out.status === 'sent' && room) this.engine.fire({ shared: room })
      return out
    }
  }

  notFound(): never {
    throw Object.assign(new Error('not found'), { demoNotFound: true })
  }

  /** the visitor is always signed in */
  override userOf(): User | null {
    return this.script ? this.users.find((u) => u.id === this.script.visitor) ?? null : null
  }

  override async handle(req: Request, dist: string): Promise<Response> {
    try {
      return await super.handle(req, dist)
    } catch (e) {
      if ((e as { demoNotFound?: boolean }).demoNotFound) return Response.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 })
      throw e
    }
  }

  // ---------------- the AI ----------------

  placeOf(chat: Chat): Place {
    if (chat.sideRoomId) return { side: this.storyId('room', chat.sideRoomId) ?? '' }
    if (chat.projectId) return { project: this.storyId('project', chat.projectId) ?? '' }
    return 'home'
  }

  override async runTurn(chatId: string, user: User, prompt: string, assistant: Message) {
    const chat = this.chats.find((c) => c.id === chatId)!
    await this.playTurn(chat, user, prompt, assistant)
    chat.unseen = true
    if (!chat.title) chat.title = prompt.slice(0, 30)
    this.finishTurn(chat, assistant)
  }

  override async runSharedTurn(chat: Chat, user: User, prompt: string, assistant: Message) {
    await this.playTurn(chat, user, prompt, assistant)
    const s = this.sharedChats.get(chat.id)
    if (s) s.runner = null
    this.finishTurn(chat, assistant)
  }

  finishTurn(chat: Chat, assistant: Message) {
    assistant.status = this.stopped.has(assistant.turnId!) ? 'stopped' : 'done'
    assistant.usage = { inputTokens: 100, outputTokens: 50, costUsd: 0 }
    assistant.model = 'claude-sonnet'
    assistant.engine = 'claude-code'
    chat.runState = 'idle'
    chat.updatedAt = now()
    this.queueRevision++
    this.publish({ type: 'message.done', data: { chatId: chat.id, messageId: assistant.id, status: assistant.status, message: this.view(assistant) } })
    this.publish({ type: 'chat.updated', data: { chatId: chat.id, change: 'updated', chat } })
  }

  async playTurn(chat: Chat, _user: User, prompt: string, assistant: Message) {
    const gen = this.generation
    const pub = (ev: ServerEventInput) => {
      if (gen !== this.generation) throw new Error('demo was reset')
      this.publish(ev)
    }
    await sleep(350)
    pub({ type: 'queue.position', data: { chatId: chat.id, messageId: assistant.id, turnId: assistant.turnId!, position: 0, epoch: this.epoch, revision: ++this.queueRevision } })
    const place = this.placeOf(chat)
    const answer = this.engine.answerFor(prompt, place)
    if (answer) {
      await this.playReply(chat, assistant, answer, pub)
      // a stopped answer does not move the story on
      if (!this.stopped.has(assistant.turnId!)) this.engine.answered(answer.id)
      return
    }
    // free typing: a short reply and the suggested questions as buttons; a pick goes on in the same answer
    await this.playReply(chat, assistant, { text: this.script.fallback.text }, pub)
    const offered = this.engine.suggestionsFor(place)
    if (!offered.length || this.stopped.has(assistant.turnId!)) return
    const i = await this.askCard(chat, assistant, { question: this.script.fallback.question ?? this.script.fallback.text, options: offered.map((a) => ({ label: a.label ?? a.prompt, reply: a })) }, pub)
    const picked = i === null ? undefined : offered[i]
    if (!picked) return
    await this.playReply(chat, assistant, picked, pub)
    if (!this.stopped.has(assistant.turnId!)) this.engine.answered(picked.id)
  }

  /** steps, the text, its files, then its card and the chosen option's reply */
  async playReply(chat: Chat, assistant: Message, reply: DemoReply, pub: (ev: ServerEventInput) => void): Promise<void> {
    const chatId = chat.id
    const turnId = assistant.turnId!
    for (const st of reply.steps ?? []) {
      if (this.stopped.has(turnId)) return
      await this.playStep(chatId, assistant, st, pub)
    }
    for (const f of reply.files ?? []) this.putDemoFile(f)
    if (reply.files?.length) {
      const saved = reply.files.map((f) => ({ path: f.path, action: 'create' as const }))
      assistant.files = { saved: [...(assistant.files?.saved ?? []), ...saved], conflicts: [], rejected: [] }
      pub({ type: 'files.changed', data: { changes: saved.map((x) => ({ ...x, by: null, turnId })) } })
    }
    const text = (assistant.content ? '\n\n' : '') + this.resolve(reply.text)
    for (let i = 0; i < text.length; i += PIECE) {
      if (this.stopped.has(turnId)) return
      const piece = text.slice(i, i + PIECE)
      const offset = assistant.content.length
      assistant.content += piece
      pub({ type: 'message.delta', data: { chatId, messageId: assistant.id, offset, text: piece } })
      await sleep(PIECE_MS)
    }
    if (!reply.ask?.options.length || this.stopped.has(turnId)) return
    const i = await this.askCard(chat, assistant, reply.ask, pub)
    const chosen = i === null ? undefined : reply.ask.options[i]
    if (chosen) await this.playReply(chat, assistant, chosen.reply, pub)
  }

  async playStep(chatId: string, assistant: Message, st: DemoStep, pub: (ev: ServerEventInput) => void) {
    const id = `d${assistant.steps.length + 1}`
    const put = (x: Step) => {
      assistant.steps = [...assistant.steps.filter((y) => y.id !== x.id), x]
      pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: x } })
    }
    const step: Step = { id, kind: 'tool', tool: st.tool ?? 'tool', label: st.label, status: 'running', startedAt: now(), endedAt: null }
    put(step)
    await sleep(st.ms ?? 700)
    put({ ...step, status: 'ok', endedAt: now() })
  }

  /** the card; the option picked (its index), or null */
  async askCard(chat: Chat, assistant: Message, ask: DemoAsk, pub: (ev: ServerEventInput) => void): Promise<number | null> {
    const turnId = assistant.turnId!
    const requestId = `demo-${assistant.steps.length}-${assistant.content.length}`
    const request: TurnRequest = {
      kind: 'ask_user', origin: 'server', requestId, allowText: false, multiple: false, question: ask.question,
      options: ask.options.map((o, i) => ({ label: o.label, value: String(i) })),
    }
    this.openAsks.set(turnId, { turnId, chatId: chat.id, messageId: assistant.id, request })
    const s = this.sharedChats.get(chat.id)
    if (s) s.waiting = true
    pub({ type: 'turn.request', data: { turnId, chatId: chat.id, messageId: assistant.id, request } })
    const answer = await new Promise<unknown>((r) => this.pendingAsk.set(turnId, r))
    this.openAsks.delete(turnId)
    if (s) s.waiting = false
    pub({ type: 'turn.request.closed', data: { turnId, requestId, reason: answer == null ? 'turn_ended' : 'answered' } })
    if (answer == null) return null
    const v = Number(Array.isArray(answer) ? answer[0] : answer)
    return Number.isInteger(v) && v >= 0 && v < ask.options.length ? v : null
  }
}
