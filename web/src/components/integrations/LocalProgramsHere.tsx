// Settings › Connectors, in the desktop app: "Programs connected on this computer" (docs/decisions/20261123-ask-registry-
// findings.md, decision 9). The programs this computer confirmed (Connect pressed in the app's own window) for this
// team, by the connection's name, each with Remove: the app drops the confirm (and stops the program if it runs), so the
// next call asks again on this computer. The ids come from the desktop app (localApps.connected); an id with no
// connection the person can see is left out. No command, setting or value is shown. Not there in a desktop app without
// the call (older apps), nor outside the desktop app.
import { useEffect, useState } from 'react'
import type { Integration } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Button } from '../ui'
import { localAppsBridge } from './LocalApp'

type Bridge = NonNullable<ReturnType<typeof localAppsBridge>>

export function LocalProgramsHere({ items, bridge = localAppsBridge() }: { items: readonly Integration[]; bridge?: Bridge | null }) {
  const t = useT()
  const [ids, setIds] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const connected = bridge?.connected
  useEffect(() => {
    if (!bridge?.connected) return
    let live = true
    const read = () => bridge.connected!().then((x) => live && setIds(Array.isArray(x) ? x : []), () => live && setIds([]))
    void read()
    // Connect pressed in the app's window: one more program here
    const off = bridge.onConfirmed?.(() => void read())
    return () => {
      live = false
      off?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, connected])
  if (!bridge?.connected || !bridge.forget || !ids) return null
  const rows = ids.flatMap((id) => {
    const i = items.find((x) => x.id === id && x.kind === 'local')
    return i ? [{ id, name: i.name }] : []
  })
  if (!rows.length) return null
  const remove = async (id: string) => {
    setBusy(id)
    try {
      await bridge.forget!(id)
      setIds((cur) => cur?.filter((x) => x !== id) ?? null)
    } catch {
      toast({ level: 'error', text: t('error.network') })
    } finally {
      setBusy(null)
    }
  }
  return (
    <section aria-labelledby="connectors-here" data-testid="local-programs-here">
      <h3 id="connectors-here" className="mb-1 text-title-sm font-semibold">{t('localApps.here.title')}</h3>
      <p className="mb-2 text-sm text-muted">{t('localApps.here.hint')}</p>
      {/* phones: plain rows under the section, like Security's devices (no frame around them) */}
      <ul className="divide-y divide-line md:rounded-xl md:border md:border-line">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-3 py-2.5 text-sm md:px-4" data-testid="local-program-here">
            <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{r.name}</span>
            <Button size="sm" variant="ghost" busy={busy === r.id} disabled={!!busy} aria-label={t('localApps.here.removeLabel', { name: r.name })} onClick={() => void remove(r.id)} data-testid="local-program-remove">
              {t('localApps.here.remove')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
