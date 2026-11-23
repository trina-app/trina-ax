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
  ask: t('AI가 그림 {pics}을(를) {doc}에 넣으려고 해요. 이 서명이나 도장이 맞나요?', 'The AI wants to put {pics} into {doc}. Is this the right signature or seal to use?', 'AI ingin menaruh {pics} ke {doc}. Apakah ini tanda tangan atau stempel yang benar?', 'AIが{pics}を{doc}に入れようとしています。この署名または印で合っていますか？', 'La IA quiere poner {pics} en {doc}. ¿Es la firma o el sello correcto?', 'AI 想把{pics}放进{doc}。这是要用的签名或印章吗？'),
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
