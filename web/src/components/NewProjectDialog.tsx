// Making a project (docs/DECISIONS.md "Making a project: a name, only me, people later"): the name and nothing else,
// as a folder in Google Drive. Every new project starts as mine alone (POST /api/projects scope personal: a folder in
// my own projects folder, named after the project, "-2" on a clash); people are added later from its page (멤버 추가),
// its instructions and files there too. Opened from 프로젝트's "새 프로젝트" row (panels/ProjectsPanel.tsx), the
// Projects page and Search's "New project", and from a chat's "프로젝트로 옮기기 › 새 프로젝트" (chat/ChatProject.tsx),
// which fills in the chat's title (selected, so typing replaces it) and moves the chat in right after.
// A name I already use for a project I see gets one quiet line; saving still works (names need not be unique).
import { useEffect, useId, useRef, useState } from 'react'
import type { Project } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { readProjectList, useProjects } from '../store/projects'
import { isAdmin, useMe } from '../store/session'
import { Button, Modal, inputCls } from './ui'

export const PROJECT_NAME_MAX = 100

const fold = (s: string) => s.normalize('NFC').trim().toLocaleLowerCase()

export function NewProjectDialog({ initialName = '', onClose, onMade }: { initialName?: string; onClose: () => void; onMade: (p: Project) => void }) {
  const t = useT()
  const locale = useLocale()
  const [name, setName] = useState(initialName.trim().slice(0, PROJECT_NAME_MAX))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const byId = useProjects((s) => s.byId)
  const listed = useProjects((s) => s.listed)
  // may share it later (the team lets members make team projects, or I am an admin): else just "나만 봐요."
  const me = useMe()
  const mayShare = isAdmin(me) || me?.team.projectCreators === 'members'
  useEffect(() => void readProjectList({ minAgeMs: 30_000 }).catch(() => {}), [])
  // the chat's title, selected: one keystroke replaces it
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    if (typeof el.select === 'function') el.select()
  }, [])
  const finalName = name.normalize('NFC').trim()
  // a personal project I see with the same name (where the new one goes)
  const same = !!finalName && Object.values(byId).some((p) => listed?.has(p.id) && p.folderPath.startsWith('users/') && fold(p.name) === fold(finalName))
  const make = async () => {
    if (!finalName || busy) return
    setBusy(true)
    setError(null)
    try {
      const p = await api.call(API.createProject, { body: { name: finalName, scope: 'personal', instructions: '', participants: [] } })
      useProjects.getState().see(p)
      onMade(p)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('projects.new')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!finalName} onClick={() => void make()} data-testid="project-create">
            {t('projects.create')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void make()
        }}
        className="space-y-2"
      >
        <label className="block text-sm font-medium" htmlFor={`${hintId}-name`}>
          {t('projects.newName')}
        </label>
        <input
          id={`${hintId}-name`}
          ref={input}
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={PROJECT_NAME_MAX}
          placeholder={t('projects.namePlaceholder')}
          aria-describedby={hintId}
          data-autofocus
          data-testid="project-name"
        />
        <div id={hintId} className="space-y-1 text-xs text-faint">
          {same && <p data-testid="project-same-name">{t('projects.sameName')}</p>}
          <p data-testid="project-who">{t(mayShare ? 'projects.who.later' : 'projects.who.meOnly')}</p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}
