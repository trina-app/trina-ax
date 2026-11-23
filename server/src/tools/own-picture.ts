// A picture the asker did not upload themselves (files/own-upload.ts: where a file lies proves nothing) goes into a
// document only after their yes on a card, which names every such picture in full; with nobody to ask (a call outside a
// chat) it is refused. Used by edit_hwp's image change.
import type { Locale } from '@mycel/shared/api'
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

/** Asks the card for `pictures` (each named in full; none: nothing happens); anything but yes refuses, nothing saved. */
export async function confirmNotOwnPictures(ctx: AppContext, c: ToolCtx, pictures: readonly string[], doc: string): Promise<void> {
  if (!pictures.length) return
  const L = c.person?.locale ?? teamDefaultLocale(ctx.db)
  const pics = pictures.map((n) => `'${n}'`).join(', ')
  const name = `'${doc.split('/').pop()}'`
  const end = c.person ? await askConfirm(c.person, PICTURE_TEXT.ask[L].replace('{pics}', () => pics).replace('{doc}', () => name), PICTURE_TEXT.yes[L], PICTURE_TEXT.no[L]) : 'unattended'
  if (end !== 'yes') throw new ToolError(refusal({
    done: 'Nothing was saved.', why: cardReason(end === 'declined' || end === 'timeout' || end === 'ended' ? end : 'unattended', { run: c.person ? undefined : 'a call outside a chat' }),
    next: 'use the person\'s own signature or seal, or ask them which picture to use', names: [...pictures],
  }))
}
