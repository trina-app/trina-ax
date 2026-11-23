// The words of an AI share card (components/chat/ShareCard.tsx; docs/decisions/20261116-ai-share-card-and-stop.md), made
// from the server's record (`Step.shared`, `AskUserRequest.share`) and nothing else: the headline, who it names, and the
// plain lines under the rows. No path and no link ever: a file is its name, a place is the record's words.
import type { Locale, ShareCardAsk, ShareCardState, ShareCardWho, StepShared } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

type T = (key: MessageKey, params?: Record<string, string | number>) => string
/** file names listed in a headline before "and N more" */
export const SHARE_CARD_NAMES = 3

const listOf = (locale: Locale, items: string[]) => {
  try { return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items) } catch { return items.join(', ') }
}

/** Who a card names: a person by name, a group as "the Sales group (6 people)", the whole team in words; "and 2 more"
 * for those the record counts but does not list. */
export function whoWords(t: T, locale: Locale, who: readonly ShareCardWho[], more = 0): string {
  const names = who.map((w) => (w.everyone ? t('fileShare.everyoneWho') : w.subjectType === 'group' ? (w.members !== undefined ? t('shareCard.groupCount', { name: w.name, n: w.members }) : t('shareCard.group', { name: w.name })) : w.name))
  const list = listOf(locale, names)
  return more > 0 ? t('shareCard.andMorePeople', { list, n: more }) : list
}

/** "Quote.pdf, Budget.xlsx, Notes.docx and 1 more" */
export function fileNames(t: T, locale: Locale, files: readonly { name: string }[]): string {
  const shown = files.slice(0, SHARE_CARD_NAMES).map((f) => f.name)
  const more = files.length - shown.length
  return more > 0 ? t('shareCard.andMoreFiles', { list: shown.join(', '), n: more }) : listOf(locale, shown)
}

/** The confirmation card's question: "Share Quote.pdf with Jun?" */
export function askHeadline(t: T, locale: Locale, a: ShareCardAsk): string {
  const who = whoWords(t, locale, a.who, a.whoMore)
  return a.files.length === 1 ? t(`shareCard.ask.${a.op}.one`, { file: a.files[0]!.name, who }) : t(`shareCard.ask.${a.op}.many`, { n: a.files.length, who })
}

/** The result card's headline, in the past tense. `restored`: a stop that was undone (the people have it again). */
export function shareHeadline(t: T, locale: Locale, s: StepShared, restored = false): string {
  const who = whoWords(t, locale, s.who, s.whoMore)
  if (s.outcome === 'refused') return t(`shareCard.refused.${s.op}`, { file: s.refusal?.file ?? s.failed?.[0]?.name ?? '' })
  if (s.outcome === 'partial') return t(`shareCard.partial.${s.op}`, { n: s.files.length, total: s.files.length + (s.failed?.length ?? 0), who })
  // nobody new: everyone named could already open the files (the server checked before the card)
  if (s.op === 'share' && !s.who.length && s.already?.length) {
    const had = whoWords(t, locale, s.already)
    return s.files.length === 1 ? t('shareCard.already.one', { who: had, file: s.files[0]!.name, n: s.already.length }) : t('shareCard.already.many', { who: had, n: s.files.length, people: s.already.length })
  }
  // a folder share_folder made from files that were only in the chat: "<folder>를 만들고 공유했어요"
  if (s.madeFolder && s.op === 'share' && s.files.length === 1 && !restored) return t('shareCard.madeFolder', { file: s.files[0]!.name, who })
  if (restored) return s.files.length === 1 ? t('shareCard.restored.one', { file: s.files[0]!.name, who }) : t('shareCard.restored.many', { n: s.files.length, who })
  return s.files.length === 1 ? t(`shareCard.done.${s.op}.one`, { file: s.files[0]!.name, who }) : t(`shareCard.done.${s.op}.many`, { n: s.files.length, who, names: fileNames(t, locale, s.files) })
}

/** Why it was not done (or not all of it), in one line. */
export function refusalLine(t: T, s: StepShared): string | null {
  const r = s.refusal
  if (!r) return null
  const why = r.reason === 'not_owner' ? (r.owner ? t(`shareCard.why.notOwner.${s.op}`, { owner: r.owner }) : t('fileShare.ownerOnly'))
    : r.reason === 'switched_off' ? t(s.failed?.[0]?.folder ? 'fileShare.offFolder' : 'fileShare.off')
    // a folder (share_folder): the Share dialog's own words for why it can't be shared, or that its share is paused
    : r.reason === 'place' ? t(`fileShare.blocked.${r.block ?? 'system_place'}` as MessageKey)
    : r.reason === 'paused' ? t('fileShare.paused')
    : t(`shareCard.why.${r.reason}`)
  // a partial result names the file it stopped at; a refusal's headline has it already
  return s.outcome === 'partial' && r.file ? `${t(`shareCard.refused.${s.op}`, { file: r.file })} ${why}` : why
}

/** The plain lines under the rows: who was told and what a group share means (a share), who can still open it and
 * through what (a stop), why it was refused. */
export function shareNotes(t: T, locale: Locale, s: StepShared, restored = false): string[] {
  const out: string[] = []
  // a folder (share_folder): its people see what is added to it later too
  if (s.op === 'share' && s.outcome !== 'refused' && s.files[0]?.folder && s.who.length) out.push(t('fileShare.folderLater'))
  if (s.op === 'share' && s.outcome !== 'refused') {
    if (s.who.some((w) => w.everyone)) out.push(t('shareCard.note.everyoneLater'))
    else if (s.who.some((w) => w.subjectType === 'group')) out.push(t('shareCard.note.groupLater'))
    const told = s.notified ?? []
    const people = s.who.filter((w) => w.subjectType === 'user')
    if (told.length && !s.whoMore && people.length === s.who.length && people.every((w) => told.includes(w.subjectId))) out.push(t('shareCard.note.notified', { who: listOf(locale, people.map((w) => w.name)), n: people.length }))
    else if (told.length) out.push(t('shareCard.note.notifiedCount', { n: told.length }))
    // some of the people named could already open them: said under the rows, not shared again
    if (s.who.length && s.already?.length) out.push(t('shareCard.note.already', { who: whoWords(t, locale, s.already), n: s.already.length }))
  }
  if (s.op === 'stop' && s.outcome !== 'refused' && !restored) {
    const one = s.files.length === 1
    for (const p of s.still ?? []) {
      out.push(p.through === 'group' && p.group
        ? t(one ? 'shareCard.still.group.it' : 'shareCard.still.group.files', { name: p.name, group: p.group, n: p.files })
        : t(one ? `shareCard.still.${p.through === 'everyone' ? 'everyone' : 'folder'}.it` : `shareCard.still.${p.through === 'everyone' ? 'everyone' : 'folder'}.files`, { name: p.name, n: p.files }))
    }
    if (s.stillMore) out.push(t('shareCard.still.more', { n: s.stillMore }))
    // a folder's stop: what inside stays shared on its own
    if (s.keptOwn && (s.keptOwn.files || s.keptOwn.folders)) {
      const what = listOf(locale, [s.keptOwn.files ? t('fileShare.holdsFiles', { n: s.keptOwn.files }) : '', s.keptOwn.folders ? t('fileShare.holdsFolders', { n: s.keptOwn.folders }) : ''].filter(Boolean))
      out.push(t('shareCard.note.keptOwn', { what }))
    }
  }
  const why = refusalLine(t, s)
  if (why) out.push(why)
  return out
}

/** A stop that was undone: every file the viewer can still see has every person and group of the card on it again. */
export function isRestored(s: StepShared, live: readonly ShareCardState[] | null): boolean {
  if (s.op !== 'stop' || s.outcome === 'refused' || !live || s.whoMore) return false
  const mine = s.files.map((f) => live.find((x) => x.id === f.linkId)).filter((x): x is Extract<ShareCardState, { path: string }> => !!x && !('gone' in x))
  return mine.length > 0 && mine.every((x) => s.who.every((w) => x.people.some((r) => r.subjectType === w.subjectType && r.subjectId === w.subjectId)))
}

/** The server's Undo of a folder's stop or removal (`Step.shared.undo`), while it is offered; null otherwise. */
export function serverUndo(s: StepShared, now = Date.now()): string | null {
  return s.op === 'stop' && s.outcome !== 'refused' && s.undo && Date.parse(s.undo.until) > now ? s.undo.id : null
}

/** The card's files the viewer can act on now (the Share dialog, Undo), in the card's order. */
export function liveFiles(s: StepShared, live: readonly ShareCardState[] | null): Extract<ShareCardState, { path: string }>[] {
  if (!live) return []
  return s.files.map((f) => live.find((x) => x.id === f.linkId)).filter((x): x is Extract<ShareCardState, { path: string }> => !!x && !('gone' in x))
}
