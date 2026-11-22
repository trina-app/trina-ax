// "자동으로 기억하기" (Settings › Memory; docs/decisions/20261122-auto-memory.md): on by default, the AI keeps lasting
// preferences and ways of working on its own; off, only what the person asks it to keep (prefs.autoMemory).
import { errorText } from '../../lib/api'
import { aiName } from '../../lib/tabs'
import { useLocale, useT } from '../../i18n'
import { useMeStrict, useSession } from '../../store/session'
import { toast } from '../../store/ui'
import { Switch } from '../ui'
import { SettingRow } from './SettingRow'

export function AutoMemoryRow() {
  const t = useT()
  const locale = useLocale()
  const on = useMeStrict().user.prefs?.autoMemory !== 'off'
  const change = (v: boolean) => {
    // shown at once (store/session.ts); a refusal puts it back and says why
    void useSession.getState().updatePrefs({ autoMemory: v ? null : 'off' }).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))
  }
  return (
    <div className="mb-4" data-testid="memory-auto-row">
      <SettingRow inline id="memory-auto" title={t('memory.auto')} desc={t('memory.autoDesc', { ai: aiName(t) })} descId="memory-auto-desc"
        control={<Switch id="memory-auto" external describedBy="memory-auto-desc" checked={on} onChange={change} label={t('memory.auto')} testId="memory-auto" />} />
    </div>
  )
}
