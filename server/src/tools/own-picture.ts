// A picture the asker did not upload themselves (files/own-upload.ts: where a file lies proves nothing) goes into a
// document only after their yes on a card, which names every such picture in full; with nobody to ask (a call outside a
// chat) it is refused. Used by edit_hwp's image change and edit_office's insert_picture.
import type { Locale, PictureAlwaysKey } from '@mycel/shared/api'
import { parsePlace } from '@mycel/shared/places'
import { teamDefaultLocale } from '../admin/settings'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { ToolError } from '../policy/errors'
import { cardReason, refusal } from '../policy/refusal'
import { askConfirm } from './url-gate'

const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): Record<Locale, string> => ({ ko, en, id, ja, es, zh })
const PICTURE_TEXT = {
  ask: t('AI가 {pics}을(를) {doc}에 넣으려고 해요. 직접 올린 그림이 아니에요. 넣을까요?', 'The AI wants to put {pics} into {doc}. You did not upload this picture yourself. Put it in?', 'AI ingin menaruh {pics} ke {doc}. Gambar ini bukan Anda sendiri yang mengunggahnya. Taruh?', 'AIが{pics}を{doc}に入れようとしています。あなた自身がアップロードした画像ではありません。入れますか？', 'La IA quiere poner {pics} en {doc}. No subiste tú esta imagen. ¿Ponerla?', 'AI 想把{pics}放进{doc}。这张图片不是你自己上传的。要放进去吗？'),
  yes: t('넣기', 'Put it in', 'Taruh', '入れる', 'Ponerla', '放进去'),
  no: t('넣지 않기', "Don't", 'Jangan', '入れない', 'No', '不要'),
}

/** A picture the card may name: the words it shows, and what its "Always allow" keeps (this person, this one picture). */
export interface NotOwnPicture { name: string; key: PictureAlwaysKey }

/** The key of one picture as the file layer names it: a chat file by its id, a team file by its path. */
export function pictureAlwaysKey(rel: string): PictureAlwaysKey {
  const at = parsePlace(rel)
  return at?.kind === 'chatFiles' ? `picture:c:${at.id ?? rel}` : `picture:t:${rel}`
}

/** Asks the card for the `pictures` the person has not allowed for good, each named in full (none: nothing happens);
 * anything but yes refuses, nothing saved. Its "Always allow" covers exactly the pictures it lists. */
export async function confirmNotOwnPictures(ctx: AppContext, c: ToolCtx, pictures: readonly NotOwnPicture[], doc: string): Promise<void> {
  const ask = pictures.filter((p) => !c.person?.pictureAlwaysOn?.(p.key))
  if (!ask.length) return
  const L = c.person?.locale ?? teamDefaultLocale(ctx.db)
  const pics = ask.map((p) => `'${p.name}'`).join(', ')
  const name = `'${doc.split('/').pop()}'`
  const end = c.person ? await askConfirm(c.person, PICTURE_TEXT.ask[L].replace('{pics}', () => pics).replace('{doc}', () => name), PICTURE_TEXT.yes[L], PICTURE_TEXT.no[L], { pictures: ask.map((p) => p.key) }) : 'unattended'
  if (end !== 'yes') throw new ToolError(refusal({
    done: 'Nothing was saved.', why: cardReason(end === 'declined' || end === 'timeout' || end === 'ended' ? end : 'unattended', { run: c.person ? undefined : 'a call outside a chat' }),
    next: 'use the person\'s own signature or seal, or ask them which picture to use', names: ask.map((p) => p.name),
  }))
}
