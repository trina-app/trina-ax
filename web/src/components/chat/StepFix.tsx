// A next step under an AI answer (docs/decisions/20261116-ai-share-who-can-open.md): one line that says what is in the
// way and one button that fixes it, in place of a refusal that ends there.
//
//   NextStep   the shared piece: { text, label, action }, and what it says once done. Any card or result can mount it
//              (a refusal card, a result card): it holds no rule of its own.
//   StepFixes  the offers the server put on an answer's steps (Step.fixes, server/src/files/share-fixes.ts): "Erin in
//              #Marketing can't open offer.pdf yet. [Let them view]", "It's Mina's file… [Ask Mina]", "Only admins can
//              share the folder… [Ask an admin]", "Only you can see this chat. [Share with project]". They show under
//              the answer (the step list folds away once the answer is done), and only to the person whose turn it was
//              (the server sends them to nobody else).
//
// Every word on the line is built here from what the server sent (names it read from its own records, counts); the AI's
// text is never on it. The tap is the confirmation: the line named the people before the button was pressed. The server
// checks everything again and answers what the offer became.
import { Check } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Step, StepFix } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { api, API, errorText } from '../../lib/api'
import { toast } from '../../store/ui'
import { useChats } from '../../store/chats'
import { Button } from '../ui'
import { openShareChat } from './ShareChat'
import { registerShareNext, type ShareNextButton } from './ShareCard'

type TFunction = ReturnType<typeof useT>

/** One line and one button. `action` may be async (the button shows busy and cannot be pressed twice); `done`: what the
 * line says once it ran (then no button). A failure is the caller's to say (a toast); the button comes back. */
export function NextStep({ text, label, action, done, testId = 'next-step' }: { text: ReactNode; label: string; action: () => void | Promise<void>; done?: ReactNode; testId?: string }) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    if (busy) return
    setBusy(true)
    try { await action() } finally { setBusy(false) }
  }
  return (
    <div role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-subtle px-3 py-2 text-sm" data-testid={testId} data-state={done ? 'done' : 'open'}>
      {done ? <Check size={16} className="shrink-0 text-ok" aria-hidden /> : null}
      {/* at least ~12rem for the text: on a phone the button goes to its own line instead of squeezing it */}
      <span className="min-w-0 flex-[1_1_12rem] py-1 leading-6 break-keep text-ink" data-testid={`${testId}-text`}>{done ?? text}</span>
      {!done && (
        <Button size="sm" variant="primary" className="ml-auto" busy={busy} onClick={() => void run()} data-testid={`${testId}-button`}>
          {label}
        </Button>
      )}
    </div>
  )
}

/** "Erin, Jun and 2 more": the names the server gave, then how many more. */
const whoOf = (f: StepFix, t: TFunction) => {
  const names = (f.people ?? []).join(', ')
  return f.count > (f.people?.length ?? 0) ? t('stepFix.andMore', { names, n: f.count - (f.people?.length ?? 0) }) : names
}
const fileOf = (f: StepFix, t: TFunction) => (f.moreFiles ? t('stepFix.fileMore', { file: f.file, n: f.moreFiles }) : f.file)

/** The line of an offer while it is open. */
export function fixText(f: StepFix, t: TFunction): string {
  const file = fileOf(f, t)
  if (f.kind === 'share_project') return t('stepFix.chatPrivate')
  if (f.kind === 'ask_admin' && f.reason === 'switch') return t('stepFix.switchOff', { file })
  if (f.kind === 'ask_admin') return [t('stepFix.folderOnlyAdmins', { file }), f.owner ? t('stepFix.folderAsk', { owner: f.owner }) : ''].filter(Boolean).join(' ')
  const cant = f.people?.length
    ? (f.place ? t('stepFix.cantOpenNamedIn', { who: whoOf(f, t), place: f.place, file }) : t('stepFix.cantOpenNamed', { who: whoOf(f, t), file }))
    : (f.place ? t('stepFix.cantOpenCountIn', { n: f.count, place: f.place, file }) : t('stepFix.cantOpenCount', { n: f.count, file }))
  const why = f.kind === 'ask_owner' ? (f.owner ? t('stepFix.ownerOnly', { owner: f.owner }) : t('stepFix.adminOnly')) : ''
  return [cant, why, f.guests ? t('stepFix.guests') : ''].filter(Boolean).join(' ')
}
/** The button of an offer. */
export const fixLabel = (f: StepFix, t: TFunction): string =>
  f.kind === 'let_view' ? t('stepFix.letView') : f.kind === 'share_project' ? t('stepFix.shareProject') : f.kind === 'ask_owner' && f.owner ? t('stepFix.askOwner', { owner: f.owner }) : t('stepFix.askAdmin')
/** What the line says once it ran (or when nothing was left to do). */
export function fixDone(f: StepFix, t: TFunction): string {
  if (f.state === 'gone') return t('stepFix.gone')
  const file = fileOf(f, t)
  if (f.kind === 'share_project') return t('stepFix.chatShared', { file: f.file })
  if (f.kind === 'ask_admin' && f.reason === 'switch') return f.owner ? t('stepFix.switchAsked', { owner: f.owner }) : t('stepFix.switchAskedAdmins')
  if (f.kind === 'ask_admin') return f.owner ? t('stepFix.folderAsked', { owner: f.owner, file }) : t('stepFix.askedAdmins', { file })
  if (f.kind === 'ask_owner') return f.owner ? t('stepFix.askedOwner', { owner: f.owner, file }) : t('stepFix.askedAdmins', { file })
  return [t('stepFix.viewDone', { n: f.doneCount ?? f.count, file }), f.left ? t('stepFix.left', { n: f.left }) : ''].filter(Boolean).join(' ')
}

/** An offer as it is now in this window, and what its button does. */
function useStepFix(fix: StepFix): { f: StepFix; action: () => Promise<void> } {
  const t = useT()
  const locale = useLocale()
  const [now, setNow] = useState(fix)
  // "Share with project": done as soon as this window knows the chat as shared (the share flow puts it in the store)
  const sharedNow = useChats((s) => fix.kind === 'share_project' && !!fix.chatId && !!s.chats.find((c) => c.id === fix.chatId)?.shared)
  // the server's newer word (the message read again) wins over what this row kept
  const f: StepFix = fix.state !== 'open' ? fix : sharedNow ? { ...fix, state: 'done' } : now
  const action = async () => {
    // the chat's own share flow, with its check and its confirm (components/chat/ShareChat.tsx): nothing runs here
    if (f.kind === 'share_project') { if (f.chatId) openShareChat(f.chatId); return }
    try {
      const r = await api.call(API.runShareFix, { params: { id: f.id } })
      setNow({ ...f, ...r })
    } catch (e) {
      // refused (the file can no longer be shared by me, too many in a short time): the server's words, the button stays
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  return { f, action: async () => { await action() } }
}

/** One offer of the server: its line, its button, and what it became. */
export function StepFixRow({ fix }: { fix: StepFix }) {
  const t = useT()
  const { f, action } = useStepFix(fix)
  return <NextStep text={fixText(f, t)} label={fixLabel(f, t)} action={action} done={f.state === 'open' ? undefined : fixDone(f, t)} testId="step-fix" />
}

/** The same offer as a share card's button (ShareCard.tsx registerShareNext): the card already says what is in the
 * way, so only the button, and once it ran, what it became. */
export function StepFixButton({ fix }: { fix: StepFix }) {
  const t = useT()
  const { f, action } = useStepFix(fix)
  const [busy, setBusy] = useState(false)
  if (f.state !== 'open') {
    return (
      <span role="status" className="mr-auto flex min-w-0 items-center gap-1.5 text-xs break-keep text-muted" data-testid="share-card-next-done">
        <Check size={14} className="shrink-0 text-ok" aria-hidden />{fixDone(f, t)}
      </span>
    )
  }
  const run = async () => {
    if (busy) return
    setBusy(true)
    try { await action() } finally { setBusy(false) }
  }
  return <Button size="sm" variant="primary" busy={busy} onClick={() => void run()} data-testid="share-card-next">{fixLabel(f, t)}</Button>
}

/** The offers a share card shows as its button (`Step.shared.next.fixId`): not shown again under the answer. */
export const onCard = (steps: readonly Step[]): Set<string> => new Set(steps.flatMap((s) => (s.shared?.next?.fixId ? [s.shared.next.fixId] : [])))

/** Every offer on an answer's steps, under the answer (those a share card shows as its button left out). */
export function StepFixes({ steps }: { steps: Step[] }) {
  const card = onCard(steps)
  const fixes = steps.flatMap((s) => s.fixes ?? []).filter((f) => !card.has(f.id))
  if (!fixes.length) return null
  return <>{fixes.map((f) => <StepFixRow key={f.id} fix={f} />)}</>
}

// A refusal card's next step (ShareCard.tsx `Step.shared.next`) is the server's stored offer on the same step: one
// mechanism for both places. A record without its offer (an older answer) shows no button.
const cardButton: ShareNextButton = ({ fix }) => (fix ? <StepFixButton fix={fix} /> : null)
registerShareNext('ask_owner', cardButton)
registerShareNext('ask_admin', cardButton)
