// "스킬로 제안" (docs/DECISIONS.md "팀 스킬 관리"): from an answer in my chat or a file in my own folder. The suggestion
// waits on the server (not in skills/) until someone who manages the chosen skills folder registers it or turns it
// down; they are told, and so am I when it is reviewed.
import { useEffect, useState } from 'react'
import type { SkillSuggestionSource } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { skillsChanged } from '../store/live'
import { toast } from '../store/ui'
import { Button, Field, Modal, inputCls } from './ui'

/** A Markdown text with a skill header ("---\nname: …\ndescription: …\n---") split into its parts. */
export function splitSkillText(text: string): { name: string; description: string; body: string } {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { name: '', description: '', body: text }
  const field = (k: string) => new RegExp(`^${k}\\s*:\\s*(.*)$`, 'mi').exec(m[1]!)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2') ?? ''
  return { name: field('name'), description: field('description'), body: text.slice(m[0].length) }
}

export default function SuggestSkillDialog({ source, initialName = '', initialContent, onClose }: { source: SkillSuggestionSource; initialName?: string; initialContent?: string; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [folders, setFolders] = useState<string[] | null>(null)
  const [folder, setFolder] = useState('skills')
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState('')
  const [content, setContent] = useState(initialContent ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.call(API.skillsOverview).then((o) => setFolders(o.suggestFolders.length ? o.suggestFolders : ['skills']), () => setFolders(['skills']))
    // a file: its text (and its header, when it already is a skill file)
    if (source.kind === 'file' && initialContent === undefined) {
      api.call(API.content, { query: { path: source.path } }).then(
        (c) => {
          const s = splitSkillText(c.content ?? '')
          setContent(s.body)
          if (s.name) setName(s.name)
          if (s.description) setDescription(s.description)
        },
        (e) => setError(errorText(e, locale, t('error.network'))),
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const slash = name.includes('/')
  const ready = !!name.trim() && !slash && !!content.trim() && name.trim().length <= 60
  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.call(API.createSkillSuggestion, { body: { source, targetFolder: folder, name: name.trim(), description: description.trim(), content } })
      toast({ level: 'success', text: t('suggest.sent') })
      skillsChanged.emit()
      onClose()
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      width={620}
      title={t('suggest.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={send} data-testid="suggest-send">
            {t('suggest.send')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="suggest-dialog">
        <p className="text-sm text-muted">{t('suggest.desc')}</p>
        <Field label={t('suggest.folder')}>
          <select className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} data-testid="suggest-folder" disabled={!folders}>
            {(folders ?? ['skills']).map((f) => (
              <option key={f} value={f}>
                {f}/
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('suggest.name')} hint={t('suggest.nameHint')} error={slash ? t('suggest.nameSlash') : null}>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-autofocus data-testid="suggest-name" />
        </Field>
        <Field label={t('suggest.description')}>
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} data-testid="suggest-description" />
        </Field>
        <Field label={t('suggest.content')}>
          <textarea className={`${inputCls} h-auto min-h-48 resize-y py-2 font-mono text-[13px]`} value={content} onChange={(e) => setContent(e.target.value)} maxLength={16000} data-testid="suggest-content" />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger" data-testid="suggest-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
