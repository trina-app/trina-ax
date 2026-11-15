// Share at the top right of a page's title row, as Drive, Notion and Claude have it (docs/DECISIONS.md "Share in the
// title row"): who can see it next to it ("Only me", a count, or the faces of who is in it), then Share. One component
// for a project's page (pages/Projects.tsx ProjectShareRow) and a chat's header (pages/Chat.tsx), so both look and
// behave the same. Share shows only for someone who may share (`onShare`); anyone else sees who can see it and no
// button (a Share that cannot share is a dead end). `icon`: a phone's top bar, which has room for one icon only: the
// people-plus icon named "Share", no words beside it (the line under the box says who sees a chat).
import { UserPlus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../i18n'
import { Button, IconButton } from './ui'

/** Who can see it, in words: a button when it opens the list of people (`onOpen`), else plain muted words. */
export function WhoSeesWords({ words, onOpen, testId }: { words: string; onOpen?: () => void; testId: string }) {
  if (!onOpen) return <span className="truncate text-sm text-muted" data-testid={testId}>{words}</span>
  return (
    <button type="button" onClick={onOpen} className="touch-hit -mx-1.5 truncate rounded-md px-1.5 py-1 text-sm text-muted hover:bg-hover hover:text-ink" data-testid={testId}>
      {words}
    </button>
  )
}

export function HeaderShare({ who, onShare, icon = false, testId }: { who?: ReactNode; onShare?: () => void; icon?: boolean; testId: string }) {
  const t = useT()
  if (icon)
    return onShare ? (
      <IconButton label={t('projects.share')} onClick={onShare} className="size-11 shrink-0" data-testid={testId}>
        <UserPlus size={18} aria-hidden />
      </IconButton>
    ) : null
  if (!who && !onShare) return null
  return (
    <div className="flex min-w-0 items-center gap-3 max-md:justify-between" data-testid={`${testId}-cluster`}>
      {who}
      {onShare && (
        <Button size="sm" onClick={onShare} className="shrink-0 pointer-coarse:min-h-11" data-testid={testId}>
          <UserPlus size={14} aria-hidden /> {t('projects.share')}
        </Button>
      )}
    </div>
  )
}
