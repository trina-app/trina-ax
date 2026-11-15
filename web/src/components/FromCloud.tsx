// "Getting report.docx from iCloud…": a file of Find work files on this computer whose content is in the cloud only is
// downloaded by the desktop app before it goes up (shared/src/desktop-bridge.ts workFiles.read onCloud), which can take a
// while; the run says so, apart from "Uploading", so a slow file explains itself.
import type { WorkCloudProvider } from '@mycel/shared'
import { useT } from '../i18n'
import { baseName } from '../lib/paths'
import { cloudName } from '../lib/workFiles'

/** The first file of a run that is being downloaded from its cloud now, in a sentence; nothing when there is none. */
export function FromCloudLine({ active, className }: { active: readonly { name: string; cloud?: WorkCloudProvider }[]; className?: string }) {
  const t = useT()
  const now = active.find((a) => a.cloud)
  if (!now?.cloud) return null
  return (
    <p className={className ?? 'truncate text-sm text-muted'} data-testid="from-cloud" data-cloud={now.cloud}>
      {t('files.findWork.fromCloud', { name: baseName(now.name), provider: cloudName(now.cloud, t) })}
    </p>
  )
}
