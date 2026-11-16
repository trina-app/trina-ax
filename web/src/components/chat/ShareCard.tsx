// The AI share card (docs/decisions/20261116-ai-share-card-and-stop.md): what share_with_person or stop_sharing did, drawn
// from the server's record on the step (`Step.shared`), never from the AI's words. One card: the confirmation card
// (AskCard.tsx, the same rows: ShareAskRows) turns into this where it is.
//   - a share: "Shared Quote.pdf with Jun", the file with its place in words, the people with "Can view", who was told,
//     one button [Manage access] (the file's Share dialog; several files: the card lists them, each opens its dialog);
//   - a stop: "Stopped sharing Quote.pdf with Jun", who can still open it and through what, one button [Undo] (shares it
//     with the same people again through the dialog's own endpoint, as the viewer; then the card says so and its button
//     is Manage access);
//   - a refusal or a partial result: what was not done and why, with a slot for the next step's button
//     (registerShareNext: the record's `next` as data; no button for a kind nobody registered).
// What the button may do is read live as the viewer (POST /api/files/shares/cards, by the record's link ids): a file that
// is gone, or one the viewer can no longer open, has no button. Only the person whose turn it was gets the record (the
// server leaves it out for every other viewer of a shared chat), so nobody else sees this card.
import { Users } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import type { ShareCardAsk, ShareCardFile, ShareCardNext, ShareCardState, ShareCardWho, StepFix, StepShared } from '@mycel/shared/api'
import { api, API, ApiError, errorText, isConnectionError } from '../../lib/api'
import { askHeadline, isRestored, liveFiles, shareHeadline, shareNotes } from '../../lib/shareCard'
import { useLocale, useT } from '../../i18n'
import { fileSharesChanged } from '../../store/live'
import { Avatar } from '../Avatar'
import { openFileShare } from '../FileShareDialog'
import { ListRow } from '../list/List'
import { Button } from '../ui'
import { ActionCard, ActionNote, ActionRows } from './ActionCard'
import { FileKindIcon } from './TeamFilePicker'

/** The button of a refusal's next step (`Step.shared.next`), by its kind. Another module fills it:
 * `registerShareNext('ask_owner', ({ next, shared }) => <Button …>Ask {next.name}</Button>)`. */
export type ShareNextButton = (p: { next: ShareCardNext; shared: StepShared; fix?: StepFix }) => ReactNode
const nextButtons: Partial<Record<ShareCardNext['kind'], ShareNextButton>> = {}
export function registerShareNext(kind: ShareCardNext['kind'], button: ShareNextButton | null): void {
  if (button) nextButtons[kind] = button
  else delete nextButtons[kind]
}

const Face = ({ who }: { who: ShareCardWho }) => (who.subjectType === 'group' ? <Users /> : <Avatar user={{ id: who.subjectId, name: who.name, avatarVersion: who.avatarVersion }} size="fill" />)

function FileRow({ file, owner, onOpen }: { file: ShareCardFile; owner?: string; onOpen?: () => void }) {
  const t = useT()
  const meta = [file.place, owner ? t('shareCard.ownerFile', { name: owner }) : ''].filter(Boolean).join(' · ')
  return <ListRow icon={<FileKindIcon name={file.name} />} name={file.name} nameTitle={file.name} meta={meta || undefined} onClick={onOpen} testId="share-card-file" nameTestId="share-card-file-name" metaTestId="share-card-file-place" />
}

function PeopleRows({ who }: { who: readonly ShareCardWho[] }) {
  const t = useT()
  return (
    <>
      {who.map((w) => (
        <ListRow key={`${w.subjectType}:${w.subjectId}`} face icon={<Face who={w} />} name={w.everyone ? t('fileShare.everyone') : w.name} tag={t('fileShare.canView')} testId="share-card-person" />
      ))}
    </>
  )
}

/** The rows of the confirmation card (AskCard.tsx, `AskUserRequest.share`): the headline as a question, the files with
 * their places, and for a share the people with "Can view". */
export function ShareAskRows({ ask, titleId }: { ask: ShareCardAsk; titleId: string }) {
  const t = useT()
  const locale = useLocale()
  return (
    <div data-testid="share-ask" data-op={ask.op}>
      {ask.why && <p className="mt-1 text-xs break-keep text-muted [overflow-wrap:anywhere]" data-testid="share-ask-why">{ask.why}</p>}
      <p id={titleId} className="mt-1 text-sm font-medium break-keep [overflow-wrap:anywhere]" data-testid="share-ask-title">{askHeadline(t, locale, ask)}</p>
      <ActionRows testId="share-ask-rows">
        {ask.files.map((f, i) => <FileRow key={i} file={f} owner={ask.owner?.name} />)}
        {ask.op === 'share' && <PeopleRows who={ask.who} />}
      </ActionRows>
    </div>
  )
}

/** The files of the card as the viewer may see them now; null while it is read (and when the read failed: no button). */
function useLive(ids: readonly string[]): { live: ShareCardState[] | null; reload: () => void } {
  const key = ids.join(',')
  const [live, setLive] = useState<ShareCardState[] | null>(null)
  const reload = useCallback(() => {
    if (!key) { setLive([]); return }
    api.call(API.shareCards, { body: { ids: key.split(',') } }).then((r) => setLive(r.items), () => setLive((v) => v ?? []))
  }, [key])
  useEffect(() => { reload() }, [reload])
  // a share changed somewhere (the dialog this card opened, another window): read again
  useEffect(() => fileSharesChanged.on(reload), [reload])
  return { live, reload }
}

/** `fixes`: the step's server offers (Step.fixes); the one the record's `next.fixId` names is this card's button. */
export default function ShareCard({ shared, fixes }: { shared: StepShared; fixes?: readonly StepFix[] }) {
  const t = useT()
  const locale = useLocale()
  const ids = useMemo(() => shared.files.map((f) => f.linkId).filter((x): x is string => !!x), [shared])
  const { live, reload } = useLive(ids)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listed, setListed] = useState(false)
  const restored = isRestored(shared, live)
  const mine = liveFiles(shared, live)
  const title = shareHeadline(t, locale, shared, restored)
  const notes = shareNotes(t, locale, shared, restored)
  const refused = shared.outcome === 'refused'
  const stop = shared.op === 'stop' && !restored
  const pathOf = (f: ShareCardFile) => mine.find((x) => x.id === f.linkId)?.path

  const manage = () => {
    if (mine.length === 1) openFileShare(mine[0]!.path)
    else setListed((v) => !v)
  }
  const undo = async () => {
    setBusy(true)
    setError(null)
    try {
      const add = shared.who.map((w) => ({ subjectType: w.subjectType, subjectId: w.subjectId }))
      for (const f of mine) await api.call(API.putFileShares, { body: { path: f.path, add, remove: [] } })
    } catch (e) {
      // the server's own words for a refusal (members' sharing turned off, someone who left), else "try again"
      setError(e instanceof ApiError && !isConnectionError(e) && e.status < 500 ? errorText(e, locale, t('shareCard.undoFailed')) : t('shareCard.undoFailed'))
    } finally {
      setBusy(false)
      reload()
    }
  }

  const Next = refused && shared.next ? nextButtons[shared.next.kind] : undefined
  const button = refused
    ? (Next && shared.next ? Next({ next: shared.next, shared, fix: fixes?.find((f) => f.id === shared.next?.fixId) }) : null)
    : !mine.length ? null
    : stop
      ? <Button size="sm" variant="secondary" busy={busy} onClick={() => void undo()} data-testid="share-card-undo">{t('shareCard.undo')}</Button>
      : <Button size="sm" variant="secondary" onClick={manage} aria-expanded={mine.length > 1 ? listed : undefined} data-testid="share-card-manage">{t('shareCard.manage')}</Button>
  // one file: its row. Several: the headline names them; the rows show once Manage access is pressed (each opens its dialog)
  const files = refused ? (shared.failed ?? []).slice(0, 1) : shared.files.length === 1 ? shared.files : listed ? shared.files : []

  return (
    <ActionCard title={title} label={title} testId="share-card" state={refused ? 'refused' : restored ? 'restored' : shared.outcome} kind={shared.op}
      footer={button || error ? <>{error && <span role="alert" className="mr-auto text-xs break-keep text-danger" data-testid="share-card-error">{error}</span>}{button}</> : undefined}>
      {(files.length > 0 || (shared.op === 'share' && !refused) || restored) && (
        <ActionRows testId="share-card-rows">
          {files.map((f, i) => { const p = !refused && shared.files.length > 1 ? pathOf(f) : undefined; return <FileRow key={i} file={f} owner={shared.owner?.name} onOpen={p ? () => openFileShare(p) : undefined} /> })}
          {((shared.op === 'share' && !refused) || restored) && <PeopleRows who={shared.who} />}
        </ActionRows>
      )}
      {notes.map((n, i) => <ActionNote key={i} testId="share-card-note">{n}</ActionNote>)}
    </ActionCard>
  )
}
