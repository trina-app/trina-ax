// write and edit of a chat file (plan docs/AGENTS/plan/20261121-1240-places-ai-versions.md, P4 of
// 20261121-0615-chat-places-as-paths.md): the main AI of a chat shared with people (or of a personal chat that holds
// the file) changes `chat:files/<id>/<name>` by saving a new version of it (ChatFiles.putVersion through the turn's
// chat places, chat/place-ctx.ts version: origin 'ai', the turn's write limits, the storage check). The earlier version
// stays, and the chain keeps its id, so every message and link that names it opens the new one.
//   - Who may: files/places.ts mayWriteChatVersion (no k group, no project chat, the main AI only, a person who may
//     continue the chat), checked before any card (chat/tools.ts beforeFileTool) and again at the save.
//   - Read before write, as for a team file: the head's sha256 the read recorded under the chain's path
//     (chat:files/<root id>/<name>). Someone saved since: write saves beside it (nothing is lost, the result says so);
//     edit applies to the newest text when it still applies once, else asks for a new read.
import { chatFilePath, type Place } from '@mycel/shared/places'
import { versionText } from '../files/place-output'
import { PLACE_WORDS } from '../files/places'
import { BINARY_WRITE, readForReplace, type ChatPlaceHooks, type ToolCtx, type ToolOutput } from '../files/service'
import { ext, isOffice } from '../files/extract'
import { readRegular, sha256 } from '../files/store'
import { ToolError } from '../policy/errors'
import { editedText } from '../skills/guard'
import { chatPlaces } from './place-ctx'
import type { TurnExec } from './turn'

type ChatFilePlace = Extract<Place, { kind: 'chatFiles' }>

/** The main AI's write and edit of chat:files/<file> (ChatPlaceHooks.write / edit) */
export function chatFileWriteHooks(exec: TurnExec): Pick<ChatPlaceHooks, 'write' | 'edit'> {
  /** the turn's chat places for the main AI's own call (a sub-agent's view has no chatPlace hook at all) */
  const placesFor = (ctx: ToolCtx) => {
    if (ctx.files.agentView || ctx.sharedChild) throw new ToolError(PLACE_WORDS.noChat, 'no_chat')
    return chatPlaces(exec, ctx.files)
  }
  const named = (place: ChatFilePlace) => place.id ? chatFilePath(place.id, place.name ?? 'file') : `chat:files/${place.name ?? ''}`
  return {
    async write(ctx, a, place): Promise<ToolOutput> {
      const p = placesFor(ctx)
      if (BINARY_WRITE.has(ext(place.name ?? ''))) throw new ToolError(`'${ext(place.name ?? '')}' files cannot be written as text; change a Word, Excel or PowerPoint chat file with edit_office (without output)`)
      const h = p.head(place.id, place.name ?? '')
      if (BINARY_WRITE.has(ext(h.name))) throw new ToolError(`'${ext(h.name)}' files cannot be written as text; change a Word, Excel or PowerPoint chat file with edit_office (without output)`)
      if (h.quarantined) throw new ToolError(`'${h.name}' is held by the team's safety check, so it is not changed`, 'held')
      // a whole-file replace needs a read of this answer, or of an earlier one in this same engine session
      const seen = readForReplace(ctx.files, h.path)
      if (!seen) throw new ToolError(`read '${h.path}' first (with read) before overwriting it`, 'not_read')
      const data = Buffer.from(a.content, 'utf8')
      if (sha256(data) === h.sha256) return { text: `No change: ${h.path} already has this content`, summary: 'write chat file -> unchanged' }
      const made = await p.version(h.id, { bytes: data }, seen, ctx.files)
      return { text: versionText(made, 'Updated'), summary: `write chat file -> version ${made.version} ${data.length}B${made.beside ? ' (beside a newer one)' : ''}` }
    },
    async edit(ctx, a, place): Promise<ToolOutput> {
      if (a.old_string === a.new_string) throw new ToolError('old_string and new_string are the same')
      const p = placesFor(ctx)
      const h = p.head(place.id, place.name ?? '')
      if (isOffice(h.name) || BINARY_WRITE.has(ext(h.name))) throw new ToolError(`only text files can be edited; change a Word, Excel or PowerPoint chat file with edit_office (without output: it saves a new version of ${named(place)})`)
      if (h.quarantined) throw new ToolError(`'${h.name}' is held by the team's safety check, so it is not changed`, 'held')
      const cur = readRegular(h.abs).bytes
      if (cur.subarray(0, 8000).includes(0)) throw new ToolError('binary file; cannot edit')
      const seen = ctx.files.readHashes.get(h.path)
      if (!seen) throw new ToolError(`read '${h.path}' first (with read) before editing it`, 'not_read')
      const text = cur.toString('utf8')
      const n = text.split(a.old_string).length - 1
      // someone saved after the read: the edit goes on the newest text only when it still applies there as it would have
      if (sha256(cur) !== seen && !(n === 1 || (n > 1 && a.replace_all))) throw new ToolError(`'${h.path}' was changed by someone else after you read it, and your edit no longer applies. Read it again.`, 'conflict')
      if (n === 0) throw new ToolError('old_string not found in the file')
      if (n > 1 && !a.replace_all) throw new ToolError(`old_string appears ${n} times; add more surrounding text to make it unique, or set replace_all`)
      const data = Buffer.from(editedText(text, a.old_string, a.new_string, a.replace_all), 'utf8')
      const made = await p.version(h.id, { bytes: data }, seen, ctx.files)
      const k = a.replace_all ? n : 1
      return { text: versionText(made, `Edited (${k} replacement${k > 1 ? 's' : ''})`), summary: `edit chat file -> version ${made.version}, ${k} replacements${made.beside ? ' (beside a newer one)' : ''}` }
    },
  }
}
