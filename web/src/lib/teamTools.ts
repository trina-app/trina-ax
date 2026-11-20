// "팀 추천" (docs/decisions/20261120-team-vs-personal-onboarding.md; the list and its helpers: shared/src/api/
// team-tools.ts): the tools an owner or admin recommends to the team, read and changed here for the welcome steps'
// 팀이 쓸 도구 and a tool's page in Settings › Connectors. Everyone else reads it from GET /api/integrations.
import { useCallback, useEffect, useRef, useState } from 'react'
import { API, isRecommended, withRecommended } from '@mycel/shared/api'
import { api, errorText } from './api'
import { useLocale, useT } from '../i18n'

/** For an owner or admin: the team's recommended tools (undefined while they load or after a failed first read: no
 * toggle that could show the wrong state), `on`, and `set` (saved at once; a failure puts it back and says why in
 * `error`). `reload` reads it again (back from Settings). */
export function useRecommendedTools() {
  const t = useT()
  const locale = useLocale()
  const [tools, setTools] = useState<string[] | undefined>(undefined)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)
  const latest = useRef(tools)
  latest.current = tools
  const reload = useCallback(async () => {
    try { setTools((await api.call(API.settings)).recommendedTools ?? []) } catch { /* kept */ }
  }, [])
  useEffect(() => { void reload() }, [reload])
  const set = useCallback(async (id: string, on: boolean) => {
    const before = latest.current
    const next = withRecommended(before, id, on)
    setTools(next)
    setSaving(id)
    setError(null)
    try { setTools((await api.call(API.updateSettings, { body: { recommendedTools: next } })).recommendedTools ?? []) } catch (e) {
      setTools(before)
      setError({ id, text: errorText(e, locale, t('error.network')) })
    } finally { setSaving(null) }
  }, [locale, t])
  return { tools, on: (id: string) => isRecommended(tools, id), set, saving, error, reload }
}
