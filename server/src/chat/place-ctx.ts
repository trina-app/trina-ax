// The chat's places for one tool call of a turn (files/place-output.ts ChatPlaces): the resolver's view of the turn
// (files/places.ts ResolveCtx), the attach of a produced file to this answer (#200's entry: ChatFiles.createFromAi, then
// the answer's attachments) and the one open of a chat file (ChatFiles.open). Built for every call, so the person, the
// chat's kind and the answer's k group are read as they are then.
import type { Attachment } from '@mycel/shared/api'
import { chatFilePath } from '@mycel/shared/places'
import { isGuestUser } from '../credentials/guest-ai'
import type { TurnFiles } from '../files/service'
import { chatFileLink, type ChatHead, type ChatPlaces, type ChatVersionMade } from '../files/place-output'
import { mayWriteChatVersion, PLACE_WORDS, type ResolveCtx } from '../files/places'
import { ToolError } from '../policy/errors'
import { confidentialChat } from '../safe-ops/confidential'
import { chainIdOf, chatFilesOf, type ChatFileRow } from './chat-files'
import { seesChatFiles } from './chat-files-access'
import { onChatFileVersion } from './chat-file-version-hook'
import { addSources } from './read-scope'
import { chatFor } from './shared'
import type { TurnExec } from './turn'

/** What kind of chat this turn is in, as the resolver's table of chat kinds reads it (plan section 2) */
export function chatKindOf(exec: TurnExec): ResolveCtx['chatKind'] {
  const { rt, spec } = exec
  if (isGuestUser(rt.db, spec.userId)) return 'guest'
  if (spec.clientKind === 'schedule') return 'scheduled'
  if (confidentialChat(rt.db, spec.chatId)) return 'locked'
  if (exec.shared?.kind === 'project') return 'project'
  if (exec.shared?.kind === 'people') return 'people'
  return 'personal'
}

export function chatPlaces(exec: TurnExec, files: TurnFiles): ChatPlaces {
  const { rt, spec } = exec
  const me = spec.userId
  const chatId = spec.chatId
  const store = chatFilesOf(rt.ctx)
  const ctx: ResolveCtx = {
    db: rt.db, userId: me, chatId,
    // the main AI of the turn only: a sub-agent's TurnFiles is apart(), never the turn's own
    main: files === exec.files,
    chatKind: chatKindOf(exec),
    // read at every check: a connection's answer may join this answer while a conversion runs
    get hiddenGroup() { return exec.hiddenFromLater },
    workFolder: files.workFolder,
    workWhy: files.workWhy,
    live: () => { try { exec.livePrincipal(); return true } catch { return false } },
  }
  /** this chat's files the person may open now, one per chain (its newest version), newest change first
   * (ChatFiles.visibleTo, the one filtered list) */
  const rows = (): ChatFileRow[] => store.visibleTo(me, chatId).map((v) => v.head)
  return {
    ctx,
    async attach(name, src, sha256): Promise<Attachment & { sha256: string }> {
      // right before the hand-off: still no hidden part in the answer, still a person who sees the chat
      if (exec.hiddenFromLater) throw new ToolError(PLACE_WORDS.hiddenTurn, 'hidden_turn')
      exec.livePrincipal()
      if (!seesChatFiles(rt.db, me, chatId)) throw new ToolError(PLACE_WORDS.notSeen, 'not_here')
      // the chat itself joins the read scope, as save_work_file's attach does (who may see the answer and its file)
      addSources(rt.db, chatId, [{ type: 'chat', id: chatId }])
      const att = await store.createFromAi(me, chatId, name, src, sha256, exec.files.readHashes)
      exec.attachToAnswer(att)
      const kept = (store.row(att.id)?.sha256) ?? sha256
      return { ...att, sha256: kept }
    },
    open(id, name) {
      // root → head (P4): any id of a chain opens its newest version (ChatFiles.open), and a name is looked up in
      // ChatFiles.visibleTo's heads; the id given back is the chain's (its root's), the one a place path keeps
      const ids = id ? [chainIdOf({ id, root_id: store.row(id)?.root_id ?? null })] : rows().filter((r) => r.name.normalize('NFC') === name.normalize('NFC')).map((r) => chainIdOf(r))
      for (const i of ids) {
        // a file carried only by an answer hidden from people who join later (k) is never read into another file: the
        // same "not found" as P1's read (chat-file-tool.ts readChatFile)
        if (store.kCarried({ id: i, chat_id: chatId })) continue
        try { const o = store.open(me, chatId, i, false); return { abs: o.abs, name: o.name, quarantined: o.quarantined, sha256: o.sha256, id: i } } catch { /* the next of that name */ }
      }
      throw new ToolError('not found in this chat\'s files', 'not_found')
    },
    // only the names this person may open (sent, or their own upload; not carried only by a hidden answer): a name taken
    // by a file they cannot see never turns the new one into "name (2)", which would tell them it is there
    names() { return new Set(rows().filter((r) => !store.kCarried(r) && (r.user_id === me || store.sent(r))).map((r) => r.name)) },
    head(id, name) { return headOf(id, name) },
    async version(id, src, read, files): Promise<ChatVersionMade> {
      // every rule again right before the save (a card may have waited; a connection's answer may have joined)
      const h = headOf(id, '')
      // the version the AI read decides `beside`: the newest row of the chain with the bytes it read
      const seenRow = store.chain(h.id).filter((r) => r.sha256 === read).at(-1)
      let made: Awaited<ReturnType<typeof store.putVersion>>
      try {
        // the gate again in the same synchronous step as the insert (the bytes took time: a move into a project, a
        // connection's answer joining, the person taken out of the chat)
        made = await store.putVersion(me, chatId, h.id, src, { origin: 'ai', turn: files, expectHead: seenRow?.id ?? 'not-the-head', recheck: gate })
      } catch (e) { throw versionError(e, h.name) }
      // the AI now knows this version (a next edit in this answer reads from it); the chat is the read scope's source
      files.readHashes.set(h.path, made.row.sha256)
      addSources(rt.db, chatId, [{ type: 'chat', id: chatId }])
      onChatFileVersion(chatId, h.id)
      return { id: h.id, name: h.name, path: h.path, version: made.row.version ?? 1, size: made.row.size, sha256: made.row.sha256, beside: made.beside, link: chatFileLink(chatId, h.id), everyone: chatKindOf(exec) === 'people' }
    },
    async restore(id, n, files): Promise<ChatVersionMade> {
      const h = headOf(id, '')
      let made: Awaited<ReturnType<typeof store.restore>>
      try { made = await store.restore(me, chatId, h.id, n, { origin: 'ai', turn: files, recheck: gate }) } catch (e) { throw versionError(e, h.name) }
      files.readHashes.set(h.path, made.row.sha256)
      addSources(rt.db, chatId, [{ type: 'chat', id: chatId }])
      onChatFileVersion(chatId, h.id)
      return { id: h.id, name: h.name, path: h.path, version: made.row.version ?? 1, size: made.row.size, sha256: made.row.sha256, beside: false, link: chatFileLink(chatId, h.id), everyone: chatKindOf(exec) === 'people' }
    },
  }

  /** the chain a new version would go on, with every rule of the turn (ChatPlaces.head) */
  /** who may write a version now: the turn's rule (mayWriteChatVersion) and the chat as it is in the database now
   * (continued by the person; a chat moved into a project since the turn began is a project chat: read-only) */
  function gate(): void {
    // the chat's kind as it is now, not as it was when this call began (an edit_office conversion takes seconds; a
    // personal chat locked meanwhile, chatFor 'continue' below does not see that for a chat that is not shared)
    const may = mayWriteChatVersion({ ...ctx, chatKind: chatKindOf(exec) })
    if (may !== true) throw new ToolError(may, 'not_here')
    let kind: string | null
    try { kind = chatFor(rt, me, chatId, 'continue').kind } catch { throw new ToolError(PLACE_WORDS.noContinue, 'not_here') }
    if (kind === 'project') throw new ToolError(PLACE_WORDS.projectReadOnly, 'not_here')
  }
  function headOf(id: string | null, name: string): ChatHead {
    gate()
    const shown = id ? chatFilePath(id, name || 'file') : `chat:files/${name}`
    const notFound = () => new ToolError(ctx.chatKind === 'personal'
      ? `No file '${shown}' in this chat's files. ${PLACE_WORDS.personalSave}`
      : `No file '${shown}' in this chat's files (list chat:files/ to see them). A new file is made with make_file (output chat:files/<name>).`, 'not_found')
    // the one filtered list: any id of a chain, or the exact name, gives its newest version (ChatFiles.find)
    const v = store.find(me, chatId, id ?? name, !id)
    if (!v) throw notFound()
    // a file a connection's (k) answer carries keeps that protection: never read, never changed (as read refuses it)
    if (store.kCarried(v.root)) throw new ToolError(`The file '${v.head.name}' came with an answer that is kept from some people who may join this chat, so it is not changed here.`, 'hidden')
    let o: ReturnType<typeof store.open>
    try { o = store.open(me, chatId, v.id, false) } catch { throw notFound() }
    return { id: v.id, name: v.root.name, path: chatFilePath(v.id, v.root.name), abs: o.abs, sha256: o.sha256, size: o.row.size, quarantined: o.quarantined, version: o.row.version ?? 1 }
  }
}

/** putVersion's refusals (HTTP-shaped for a person's save) as words for the AI; a ToolError (the turn's limits, the
 * storage check) passes as it is */
function versionError(e: unknown, name: string): unknown {
  if (e instanceof ToolError) return e
  const code = (e as { code?: unknown } | null)?.code
  if (code === 'payload_too_large') return new ToolError(`'${name}' would be too large as a chat file (at most 1 GB); nothing was saved`, 'too_large')
  if (code === 'conflict') return new ToolError(PLACE_WORDS.noContinue, 'not_here')
  if (code === 'not_found') return new ToolError(`'${name}' is no longer in this chat's files; nothing was saved`, 'not_found')
  if (code === 'validation') return new ToolError(`'${name}' could not be saved: ${String((e as Error).message).slice(0, 200)}`, 'bad_file')
  return e
}
