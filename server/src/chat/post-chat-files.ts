// A file of this chat linked in a post (post_to_room): /c/<chat>?file=<id> opens only for the people of this chat, so
// a teammate it went to got "파일을 찾을 수 없거나 볼 권한이 없어요" while the answer said it was sent (smoke test of
// batch 4, S1-A/E: a chat file made by make_file, then "이 문서 한지우님한테 보내줘"). Such a link is first kept as a
// copy in the person's own downloads (users/<id>/downloads/, copy_files' own route and checks: chat/places-copy.ts
// teamTargetRefusal, chatFileToTeam), and the post links the copy instead: the post's usual check then offers it as a
// file that goes with the post ("함께 보낼 파일"), as a team file in their own folder always was. The same call again
// (a retry, a waiting card answered later) finds the copy it made (same chat file, same bytes, still at its path) and
// makes no second one. A link to another chat's file is refused: nothing of another chat is copied, and it would be
// dead for the people it goes to.
import fs from 'node:fs'
import path from 'node:path'
import type { AppContext } from '../context'
import { hashFile } from '../team-files/place'
import { chatFileFor, chatFileToTeam, teamTargetRefusal } from './places-copy'
import type { TurnFiles } from '../files/service'
import type { TurnExec } from './turn'

/** a chat file's link as the app writes it (files/place-output.ts chatFileLink), any spelling its router opens */
// (the app's own relative link only: another site's /c/…?file=… is not a chat file)
const CHAT_FILE_LINK = /(?<![\w.:/-])\/c\/([A-Za-z0-9_%-]+)\/?\?file=([A-Za-z0-9_%-]+)/gi

const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

/** Every chat-file link in `text`: the link as written, its chat and file id, and whether it is `chatId`'s. */
export function chatFileLinksIn(text: string, chatId: string): { link: string; chat: string; id: string; here: boolean }[] {
  return [...text.matchAll(CHAT_FILE_LINK)].map((m) => {
    const chat = decode(m[1]!)
    return { link: m[0], chat, id: decode(m[2]!), here: chat.toLowerCase() === chatId.toLowerCase() }
  })
}

/** the copies this server made for a post, by `${userId}\0${chatId}\0${fileId}\0${sha256}`: the team path (a retry or a
 * late answer to the card finds it, also when the name was taken and the copy went next to it) */
const made = new WeakMap<AppContext, Map<string, string>>()
const madeOf = (ctx: AppContext) => made.get(ctx) ?? made.set(ctx, new Map()).get(ctx)!

/** the bytes at team path `rel` now are `sha256` */
async function sameBytes(root: string, rel: string, sha256: string): Promise<boolean> {
  try {
    const abs = path.join(root, ...rel.split('/'))
    return fs.statSync(abs).isFile() && await hashFile(abs) === sha256
  } catch { return false }
}

export type ChatLinksCopied = { ok: true; text: string; copies: { name: string; path: string; madeNow: boolean }[] } | { ok: false; text: string; summary: string }

/** `text` with every link to a file of this chat replaced by the link to its copy in the person's own downloads. */
export async function chatLinksToCopies(exec: TurnExec, files: TurnFiles, text: string, tool: string): Promise<ChatLinksCopied> {
  const links = chatFileLinksIn(text, exec.spec.chatId)
  if (!links.length) return { ok: true, text, copies: [] }
  if (links.some((l) => !l.here)) return { ok: false, text: 'Nothing was posted: the text links a file of another chat, which the people it goes to cannot open, and nothing of another chat is sent from here. Leave that link out, or tell the user to send it from that chat.', summary: 'refused: another chat\'s file link' }
  const root = exec.rt.files.fx.root
  // only a place to save (the person's own downloads, as save_chat_file's default): chatFileToTeam's wider-audience
  // card still decides, and nothing counts readers by it
  const downloads = `users/${exec.spec.userId}/downloads`
  const cache = madeOf(exec.rt.ctx)
  const copies: { name: string; path: string; madeNow: boolean }[] = []
  const to = new Map<string, string>()
  for (const l of links) {
    if (to.has(l.link)) continue
    const f = chatFileFor(exec, { kind: 'chatFiles', id: l.id, name: '' })
    if (typeof f === 'string') return { ok: false, text: `Nothing was posted: the text links a file of this chat that cannot go with it (${f}) Leave that link out, or ask the user which file to send.`, summary: 'refused: chat file link' }
    const own = f.name.normalize('NFC').replace(/[/\\\u0000-\u001f]+/g, '_').trim() || 'file'
    const target = `${downloads}/${own}`
    // copy_files' own checks of where a copy may go (never a skills folder or an instruction file's name; write access)
    const bad = teamTargetRefusal(exec, target)
    if (bad) return { ok: false, text: `Nothing was posted: the text links a file of this chat, which only the people of this chat can open, and its copy to send cannot be kept in the user's downloads: ${bad}`, summary: 'refused: chat file not copied' }
    const key = `${exec.spec.userId}\0${exec.spec.chatId}\0${f.id}\0${f.sha256}`
    // the copy this post made before (the same call again), or the same bytes at that path already
    let at: string | null = null
    const before = cache.get(key)
    if (before && await sameBytes(root, before, f.sha256)) at = before
    else if (await sameBytes(root, target, f.sha256)) at = target
    let madeNow = false
    if (!at) {
      const r = await chatFileToTeam(exec, files, { file: f, target, tool, args: { paths: [`chat:files/${f.id}/${f.name}`], to_folder: `${downloads}/` } })
      if (!r.ok) return { ok: false, text: `Nothing was posted: the text links a file of this chat, which only the people of this chat can open, and a copy to send with the post could not be kept: ${r.text}`, summary: 'refused: chat file not copied' }
      at = r.to
      madeNow = true
      cache.set(key, at)
    }
    copies.push({ name: f.name, path: at, madeNow })
    to.set(l.link, `/files/view?path=${encodeURIComponent(at)}`)
  }
  const out = text.replace(CHAT_FILE_LINK, (m) => to.get(m) ?? m)
  return { ok: true, text: out, copies }
}

/** The words a post that did not go adds when it kept copies of chat files (they stay in the user's downloads). */
export function copiesKeptNote(copies: readonly { name: string; madeNow: boolean }[]): string {
  const n = copies.filter((c) => c.madeNow).length
  return n ? ` A copy of the chat file${n === 1 ? '' : 's'} it linked was kept in the user's own downloads folder for this post; it stays there (tell the user if it matters).` : ''
}
