// The chat's places for one tool call of a turn (files/place-output.ts ChatPlaces): the resolver's view of the turn
// (files/places.ts ResolveCtx), the attach of a produced file to this answer (#200's entry: ChatFiles.createFromAi, then
// the answer's attachments) and the one open of a chat file (ChatFiles.open). Built for every call, so the person, the
// chat's kind and the answer's k group are read as they are then.
import type { Attachment } from '@mycel/shared/api'
import { isGuestUser } from '../credentials/guest-ai'
import type { TurnFiles } from '../files/service'
import type { ChatPlaces } from '../files/place-output'
import { PLACE_WORDS, type ResolveCtx } from '../files/places'
import { ToolError } from '../policy/errors'
import { confidentialChat } from '../safe-ops/confidential'
import { chatFilesOf, type ChatFileRow } from './chat-files'
import { seesChatFiles } from './chat-files-access'
import { carriedByHiddenAnswer } from './chat-file-tool'
import { addSources } from './read-scope'
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
    live: () => { try { exec.livePrincipal(); return true } catch { return false } },
  }
  /** this chat's files the person may open now, newest first (ChatFiles.open decides each) */
  const rows = (): ChatFileRow[] => rt.db.query('SELECT * FROM chat_files WHERE chat_id = ? ORDER BY created_at DESC, id DESC').all(chatId) as ChatFileRow[]
  return {
    ctx,
    async attach(name, src, sha256): Promise<Attachment & { sha256: string }> {
      // right before the hand-off: still no hidden part in the answer, still a person who sees the chat
      if (exec.hiddenFromLater) throw new ToolError(PLACE_WORDS.hiddenTurn, 'hidden_turn')
      exec.livePrincipal()
      if (!seesChatFiles(rt.db, me, chatId)) throw new ToolError(PLACE_WORDS.notSeen, 'not_here')
      // the chat itself joins the read scope, as save_work_file's attach does (who may see the answer and its file)
      addSources(rt.db, chatId, [{ type: 'chat', id: chatId }])
      const att = await store.createFromAi(me, chatId, name, src, sha256)
      exec.attachToAnswer(att)
      const kept = (store.row(att.id)?.sha256) ?? sha256
      return { ...att, sha256: kept }
    },
    open(id, name) {
      // TODO(P4, feat/chat-file-versions): root → head through ChatFiles.visibleTo
      const ids = id ? [id] : rows().filter((r) => r.name.normalize('NFC') === name.normalize('NFC')).map((r) => r.id)
      for (const i of ids) {
        // a file carried only by an answer hidden from people who join later (k) is never read into another file: the
        // same "not found" as P1's read (chat-file-tool.ts readChatFile)
        if (carriedByHiddenAnswer(rt.db, chatId, i)) continue
        try { const o = store.open(me, chatId, i, false); return { abs: o.abs, name: o.name, quarantined: o.quarantined, sha256: o.sha256, id: i } } catch { /* the next of that name */ }
      }
      throw new ToolError('not found in this chat\'s files', 'not_found')
    },
    names() { return new Set(rows().map((r) => r.name)) },
  }
}
