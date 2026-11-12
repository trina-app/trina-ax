// A column that takes files dropped anywhere on it (a room's messages column, a thread, the ✦ side chat, the AI chat
// page) and hands them to its message box, as if they were dropped on the box. Only files from this computer: a drag
// of text, a link or a message of the app is not taken (components/chat/ComposerFiles.tsx useFileDrop). The nearest
// column wins: a thread beside the room takes what is dropped on the thread, the room the rest.
// The box inside registers itself (useDropTarget), with its own checks: what would make it refuse the whole drop (full,
// a shared chat that takes no file from this computer) shows on the overlay instead of "여기에 놓으면 첨부돼요", and the
// drop does nothing; a column with no box (a thread that takes no reply, a chat in the trash) says `empty`. What it takes
// only in part (more files than it has room for, one too big) it says itself, as for a drop on the box.
// While files are dragged over it: one light overlay with a dashed edge and one line (the app's drop look, as the
// skills sheets'), drawn over the column and never in the way of the drag (pointer-events: none).
import clsx from 'clsx'
import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { useT } from '../i18n'
import { useFileDrop } from './chat/ComposerFiles'

/** A message box as a zone's target: what takes the files, and why it would take none of them now (or null). */
export interface DropTarget {
  files: (files: File[]) => void
  refusal?: () => string | null
}

type Attach = (target: RefObject<DropTarget>) => () => void
const ZoneContext = createContext<Attach | null>(null)

/** A message box inside a FileDropZone: files dropped anywhere on the zone come here. True when it is inside one (the
 * box then leaves files to the zone; outside every zone it takes drops on itself). */
export function useDropTarget(target: DropTarget): boolean {
  const attach = useContext(ZoneContext)
  const latest = useRef(target)
  latest.current = target
  useLayoutEffect(() => attach?.(latest), [attach])
  return !!attach
}

/** `target`: the zone's own box (the side chat's), else the box that registers inside it; `empty`: why nothing can be
 * attached while there is no box (default: no message can be sent here). */
export function FileDropZone({ target, empty, className, children, ...rest }: { target?: DropTarget; empty?: string; className?: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  const t = useT()
  const attached = useRef<RefObject<DropTarget> | null>(null)
  const attach = useMemo<Attach>(() => (ref) => {
    attached.current = ref
    return () => { if (attached.current === ref) attached.current = null }
  }, [])
  const box = () => target ?? attached.current?.current ?? null
  const { drag, refusal, dropProps } = useFileDrop({
    files: (all) => box()?.files(all),
    refusal: () => {
      const b = box()
      return b ? (b.refusal?.() ?? null) : (empty ?? t('drop.noBox'))
    },
  })
  return (
    <ZoneContext.Provider value={attach}>
      <div {...rest} className={clsx('relative', className)} {...dropProps}>
        {children}
        {drag && <DropOverlay refusal={refusal} />}
      </div>
    </ZoneContext.Provider>
  )
}

/** The overlay while files are over a zone: "여기에 놓으면 첨부돼요", or why they cannot go here. */
function DropOverlay({ refusal }: { refusal: string | null }) {
  const t = useT()
  return (
    <div
      className={clsx(
        'pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-xl border-2 border-dashed p-6',
        refusal ? 'border-line-strong bg-subtle/80' : 'border-accent/55 bg-accent-soft/70',
      )}
      data-testid="drop-overlay"
      data-refused={refusal ? '' : undefined}
    >
      <p role="status" className={clsx('max-w-md rounded-full bg-surface px-4 py-2 text-center text-sm font-medium shadow-[var(--c-shadow)] break-keep', refusal ? 'text-muted' : 'text-accent-text')}>
        {refusal ?? t('drop.here')}
      </p>
    </div>
  )
}
