// The one count pill of the navigation: a room's unread count (nav/RoomsList.tsx UnreadBadge), a folded room folder's
// pill (nav/NavFolders.tsx RoomFolderPillView) and the Team skills row's "waiting for my review" count
// (panels/TrinaPanel.tsx, phone/TrinaDrawer.tsx). The number (or "@") for the eye, the words for a screen reader.
// `quiet`: grey (a muted room), not counted elsewhere.
import clsx from 'clsx'

export function CountPill({ text, label, quiet, className, testId, ...data }: { text: string; label: string; quiet?: boolean; className?: string; testId?: string } & { [data: `data-${string}`]: string | undefined }) {
  return (
    <span className={clsx('shrink-0 rounded-full px-1.5 text-micro font-medium', quiet ? 'bg-hover text-muted' : 'bg-accent text-accent-ink', className)} data-testid={testId} {...data}>
      <span aria-hidden>{text}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
