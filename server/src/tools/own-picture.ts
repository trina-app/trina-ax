// A picture that goes into a document and is not the asker's own (a signature or seal another member sent in the chat,
// or a team file outside their own folder) goes in only after their yes on a card, never on the AI's choice; with
// nobody to ask (a call outside a chat) it is refused. Used by edit_hwp's image change.
import type { Locale } from '@mycel/shared/api'
import { teamDefaultLocale } from '../admin/settings'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { ToolError } from '../policy/errors'
import { cardReason, refusal } from '../policy/refusal'
import { askConfirm } from './url-gate'

const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): Record<Locale, string> => ({ ko, en, id, ja, es, zh })
const PICTURE_TEXT = {
  ask: t('AI가 내 것이 아닌 그림 {pics}을(를) {doc}에 넣으려고 해요. 넣을까요?', 'The AI wants to put {pics} into {doc}. It is not your own picture: someone else sent it, or it is outside your own folder. Put it in?', 'AI ingin menaruh {pics} ke {doc}. Gambar ini bukan milik Anda: orang lain mengirimnya, atau ada di luar folder Anda. Taruh?', 'AIが{pics}を{doc}に入れようとしています。あなた自身の画像ではありません（ほかの人が送ったか、あなたのフォルダーの外にあります）。入れますか？', 'La IA quiere poner {pics} en {doc}. No es una imagen tuya: la envió otra persona o está fuera de tu carpeta. ¿Ponerla?', 'AI 想把{pics}放进{doc}。这不是你自己的图片：是别人发送的，或在你自己的文件夹之外。要放进去吗？'),
  yes: t('넣기', 'Put it in', 'Taruh', '入れる', 'Ponerla', '放进去'),
  no: t('넣지 않기', "Don't", 'Jangan', '入れない', 'No', '不要'),
}

/**
 * Whether a picture is the asker's own: the one place that decides it, so #448's shared helper is a one-line swap here.
 * Until then nothing counts as own. Where a file lies or whose row it is does not show who put it there: the AI can copy
 * someone's seal into the asker's folder, and a chat file the AI attached carries the asker's id. So every picture gets
 * the card (fails closed).
 */
export const ownPicture = { is: (_ctx: AppContext, _place: string, _userId: string): boolean => false }

/** Asks the card for `pictures` (none: nothing happens); anything but yes refuses the call, nothing saved. */
export async function confirmNotOwnPictures(ctx: AppContext, c: ToolCtx, pictures: ReadonlySet<string>, doc: string): Promise<void> {
  if (!pictures.size) return
  const L = c.person?.locale ?? teamDefaultLocale(ctx.db)
  const pics = [...pictures].slice(0, 5).map((n) => `'${n.split('/').pop()}'`).join(', ')
  const end = c.person ? await askConfirm(c.person, PICTURE_TEXT.ask[L].replace('{pics}', pics).replace('{doc}', `'${doc.split('/').pop()}'`), PICTURE_TEXT.yes[L], PICTURE_TEXT.no[L]) : 'unattended'
  if (end !== 'yes') throw new ToolError(refusal({
    done: 'Nothing was saved.', why: cardReason(end === 'declined' || end === 'timeout' || end === 'ended' ? end : 'unattended', { run: c.person ? undefined : 'a call outside a chat' }),
    next: 'use the person\'s own signature or seal, or ask them which picture to use', names: [...pictures],
  }))
}
