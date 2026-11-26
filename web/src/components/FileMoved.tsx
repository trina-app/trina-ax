// The side panel's answer to a team file that is not at its path any more (QA TC-r2b-02: a chat's link to a poster
// someone moved said only "can't be found, or you don't have access"). GET /api/files/moved says where it went:
// "Moved to 전사 공유 › 마케팅 by 박준호 · Nov 22" with Open (the file where it is now, in the same panel); moved to a
// folder the viewer cannot open; or put in the trash. Anything else (the server answers 'no' for a path that never
// was, or a folder the viewer may not open): the usual line, `fallback`, with nothing about the file, and who can share
// it (the file's owner or an admin).
import { useEffect, useState } from 'react'
import type { FileMoved as Moved } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { formatDate } from '../lib/format'
import { useFolderWords } from '../lib/folderLabels'
import { openTeamFile } from '../lib/sidePanel'
import { useLocale, useT } from '../i18n'
import { Button, PreviewLoading } from './ui'

export function FileMoved({ path, chatId, fallback }: { path: string; chatId?: string; fallback: string }) {
  const t = useT()
  const locale = useLocale()
  const words = useFolderWords()
  const [state, setState] = useState<Moved | { status: 'loading' }>({ status: 'loading' })
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    api.call(API.moved, { query: { path } }).then((r) => live && setState(r), () => live && setState({ status: 'no' }))
    return () => { live = false }
  }, [path])
  if (state.status === 'loading') return <PreviewLoading label={t('common.loading')} />
  // nothing here to ask with (no message I see linked it, a file the linker cannot read either …): one plain line on who
  // can share it, never whether it is there or whose it is (QA after #651: the line alone was a dead end)
  if (state.status === 'no')
    return (
      <div className="flex flex-col items-start gap-1 p-6">
        <p className="text-sm text-muted" role="alert" data-testid="file-moved-no">{fallback}</p>
        <p className="text-sm break-keep text-faint" data-testid="file-moved-who">{t('preview.notFoundWho')}</p>
      </div>
    )
  const date = formatDate(state.at, locale)
  // (an account removed since: its name is gone)
  const who = state.by.name || t('fileMoved.someone')
  const folder = state.status === 'moved' && state.to ? state.to.slice(0, Math.max(0, state.to.lastIndexOf('/'))) : null
  const to = state.status === 'moved' ? state.to : undefined
  return (
    <div className="flex flex-col items-start gap-3 p-6" data-testid="file-moved" data-state={state.status}>
      <p className="text-sm leading-6 font-medium break-keep text-ink" role="status">
        {state.status === 'trashed'
          ? t('fileMoved.trashed', { name: who, date })
          : folder !== null
            ? t('fileMoved.movedTo', { place: words.path(folder, ' › ') || t('files.root'), name: who, date })
            : t('fileMoved.movedHidden', { name: who, date })}
      </p>
      {to && (
        <Button variant="primary" onClick={() => openTeamFile(to, null, chatId ?? null)} data-testid="file-moved-open">
          {t('fileMoved.open')}
        </Button>
      )}
    </div>
  )
}
