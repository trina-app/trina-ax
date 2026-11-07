// A skill as people read it ("할 일 정리"), in place of its command ("/meeting-tasks"): in a question that runs it and in
// the message box that will (docs/DECISIONS.md "M — One meeting note, everyone's own tasks"). The command still runs
// underneath; the chip only names it. `onRemove`: the box's chip can be taken out (the question stays, without the
// skill).
import { Sparkles, X } from 'lucide-react'
import { useT } from '../../i18n'
import { Tooltip } from '../Tooltip'

export function SkillChip({ title, name, onRemove }: { title: string; name: string; onRemove?: () => void }) {
  const t = useT()
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent-soft py-0.5 pr-2 pl-2 text-label font-medium text-accent-text" title={`/${name}`} data-testid="skill-chip">
      <Sparkles size={13} className="shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{title}</span>
      {/* title="": the chip's own title (/name) does not show beside the tooltip */}
      {onRemove && (
        <Tooltip label={t('composer.skillRemove', { skill: title })}>
          <button type="button" onClick={onRemove} title="" className="-mr-1 rounded-full p-0.5 hover:bg-hover" aria-label={t('composer.skillRemove', { skill: title })} data-testid="skill-chip-remove">
            <X size={12} aria-hidden />
          </button>
        </Tooltip>
      )}
    </span>
  )
}
