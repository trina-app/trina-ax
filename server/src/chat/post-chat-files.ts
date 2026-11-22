// A file of this chat linked in a post (post_to_room): /c/<chat>?file=<id> opens only for the people of this chat, so
// a teammate it went to got "파일을 찾을 수 없거나 볼 권한이 없어요" while the answer said it was sent (smoke test of
// batch 4, S1-A/E: a chat file made by make_file, then "이 문서 한지우님한테 보내줘"). Such a link is first kept as a
// copy in the person's own downloads (users/<id>/downloads/, copy_files' own route: chat/places-copy.ts
// chatFileToTeam), and the post links that copy instead: the post's usual check then offers it as a file that goes
// with the post ("함께 보낼 파일"), as a team file in their own folder always was. The same call again (a retry, a
// waiting card answered later) finds the copy it made (same path, same bytes) and makes no second one.
// A link to another chat's file is left as it is (nothing of another chat is copied here).
import fs from 'node:fs'
import path from 'node:path'
import { hashFile } from '../team-files/place'
import { chatFileFor, chatFileToTeam } from './places-copy'
import type { TurnFiles } from '../files/service'
import type { TurnExec } from './turn'

/** a chat file's link as the app writes it (files/place-output.ts chatFileLink), any spelling its router opens */
const CHAT_FILE_LINK = /\/c\/([A-Za-z0-9_%-]+)\/?\?file=([A-Za-z0-9_%-]+)/gi

const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

/** The links to files of `chatId` in `text`, each once: the link as written and the file id. */
export function chatFileLinksIn(text: string, chatId: string): { link: string; id: string }[] {
  const out = new Map<string, string>()
  for (const m of text.matchAll(CHAT_FILE_LINK)) {
    if (decode(m[1]!).toLowerCase() !== chatId.toLowerCase()) continue
    out.set(m[0], decode(m[2]!))
  }
  return [...out].map(([link, id]) => ({ link, id }))
}

export type ChatLinksCopied = { ok: true; text: string; copies: { name: string; path: string }[] } | { ok: false; text: string; summary: string }

/** `text` with every link to a file of this chat replaced by the link to its copy in the person's own downloads. */
export async function chatLinksToCopies(exec: TurnExec, files: TurnFiles, text: string, tool: string): Promise<ChatLinksCopied> {
  const links = chatFileLinksIn(text, exec.spec.chatId)
  if (!links.length) return { ok: true, text, copies: [] }
  const root = exec.rt.files.fx.root
  const copies: { name: string; path: string }[] = []
  let out = text
  for (const l of links) {
    const f = chatFileFor(exec, { kind: 'chatFiles', id: l.id, name: '' })
    if (typeof f === 'string') return { ok: false, text: `Nothing was posted: the text links a file of this chat that cannot go with it (${f}) Leave that link out, or ask the user which file to send.`, summary: 'refused: chat file link' }
    const own = f.name.normalize('NFC').replace(/[/\\\u0000-\u001f]+/g, '_').trim() || 'file'
    const target = `users/${exec.spec.userId}/downloads/${own}`
    // the copy this post made before (the same call again): the same bytes at the same path
    let at: string | null = null
    try {
      const abs = path.join(root, ...target.split('/'))
      if (fs.statSync(abs).isFile() && await hashFile(abs) === f.sha256) at = target
    } catch { at = null }
    if (!at) {
      const r = await chatFileToTeam(exec, files, { file: f, target, tool, args: { paths: [`chat:files/${f.id}/${f.name}`], to_folder: `users/${exec.spec.userId}/downloads/` } })
      if (!r.ok) return { ok: false, text: `Nothing was posted: the text links a file of this chat, which only the people of this chat can open, and a copy to send with the post could not be kept: ${r.text}`, summary: 'refused: chat file not copied' }
      at = r.to
    }
    copies.push({ name: f.name, path: at })
    out = out.split(l.link).join(`/files/view?path=${encodeURIComponent(at)}`)
  }
  return { ok: true, text: out, copies }
}
