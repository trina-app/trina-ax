// A skill's short form (docs/DECISIONS.md "C. Onboarding: marketing skill pack and skill forms"): instead of a blank
// chat, the few facts the skill asks for (its metadata `inputs`, shared/src/api/skill-inputs.ts), some already filled
// in from the company profile. Running it starts a new chat with the ordinary skill command ("/<name>" and the
// values, lib/skillForm.ts), as if the person had typed it. A skill without a form gets one free text box.
//
// Opened from the Team skills page (a skill's run button, and /skills?run=<path>), from the "/" menu in the message
// box (there it fills the box instead: `onCompose`), and later from the welcome steps. Standalone: `onDone` after the
// chat started (default: open it), `onSkip` adds a quiet "Skip" button. The command runs by name, so a form whose
// name runs another skill for this person (a personal skill or another team skill with the same name) refuses to run
// and says which one is in the way.
import { Play } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { SKILL_INPUT_TEXT_MAX, SKILL_INPUT_VALUE_MAX, type SkillInfo } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { composeSkillMessage, loadProfile, missingRequired, skillRunBy, withPrefill } from '../../lib/skillForm'
import { rememberChat } from '../../lib/teamAttach'
import { useLocale, useT } from '../../i18n'
import { useChats } from '../../store/chats'
import { canChooseEngine, useMeStrict } from '../../store/session'
import { Button, ErrorNote, Field, Modal, Skeleton, inputCls } from '../ui'

type Props = {
  /** the skill's entry point (GET /api/skills `path`) */
  path: string
  /** the skill, when the caller has it: shown at once (the form still checks it against the person's list) */
  skill?: SkillInfo
  /** the chat started (default: it opens) */
  onDone?: (chatId: string) => void
  onSkip?: () => void
  /** hand the message back instead of starting a chat (the message box's "/" menu) */
  onCompose?: (message: string) => void
}

export function SkillForm({ path, skill: given, onDone, onSkip, onCompose }: Props) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const navigate = useNavigate()
  const send = useChats((s) => s.send)
  const [list, setList] = useState<SkillInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [free, setFree] = useState('')
  const typed = useRef(new Set<string>())
  const [missing, setMissing] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formId = useId()

  // the skills this person can use: the form's own (by path; any other path is "not found") and the one "/<name>"
  // runs for them
  useEffect(() => {
    let live = true
    setList(null)
    setLoadError(null)
    api.call(API.listSkills).then((r) => live && setList(r.items), (e) => live && setLoadError(errorText(e, locale, t('error.network'))))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  const skill = list ? (list.find((s) => s.path === path) ?? null) : given
  const runs = list && skill ? skillRunBy(list, skill.name) : null
  const clash = runs && skill && runs.path !== skill.path ? runs : null
  // only once the list says which skill "/<name>" runs for this person (a skill passed in is shown before that)
  const ready = !!list && !clash

  // the company profile fills the fields that ask for it, unless the person already typed there
  const inputs = skill?.inputs ?? []
  useEffect(() => {
    if (!inputs.some((i) => i.prefill)) return
    let live = true
    void loadProfile().then((profile) => { if (live && profile) setValues((v) => withPrefill(inputs, profile, v, typed.current)) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill?.path, !!skill?.inputs])

  if (loadError && !skill) return <ErrorNote>{loadError}</ErrorNote>
  if (skill === undefined) return <Skeleton lines={4} />
  if (skill === null) {
    // a personal skill of the same name takes the team skill's place for this person (server/src/chat/skills.ts)
    const folder = /([^/]+)\/SKILL\.md$/.exec(path)?.[1]
    const mine = folder ? list?.find((s) => s.personal && s.name.normalize('NFC').toLowerCase() === folder.normalize('NFC').toLowerCase()) : undefined
    return <p className="text-sm text-muted" data-testid="skill-form-missing">{mine ? t('skillForm.shadowed', { name: mine.name }) : t('skillForm.notFound')}</p>
  }

  const set = (name: string, v: string) => {
    typed.current.add(name)
    setValues((cur) => ({ ...cur, [name]: v }))
    if (missing.includes(name) && v.trim()) setMissing((m) => m.filter((x) => x !== name))
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    const left = missingRequired(inputs, values)
    setMissing(left)
    if (left.length) {
      document.getElementById(`${formId}-${left[0]}`)?.focus()
      return
    }
    const message = composeSkillMessage(skill.name, inputs, values, free)
    if (onCompose) { onCompose(message); return }
    setBusy(true)
    setError(null)
    try {
      const choose = canChooseEngine(me)
      const r = await send({ chatId: null, content: message, attachments: [], author: { id: me.user.id, name: me.user.name }, projectId: null, engine: choose ? me.user.prefs.engine : undefined, model: choose ? me.user.prefs.model ?? null : undefined })
      rememberChat(me.user.id, r.chatId)
      if (onDone) onDone(r.chatId)
      else navigate(`/c/${r.chatId}`)
    } catch (err) {
      setError(errorText(err, locale, t('error.network')))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-3" data-testid="skill-form" data-path={skill.path}>
      {skill.description && <p className="text-sm text-muted">{skill.description}</p>}
      {loadError && <ErrorNote>{loadError}</ErrorNote>}
      {clash && <p role="alert" className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn" data-testid="skill-form-clash">{t('skillForm.sameName', { name: skill.name, path: clash.path })}</p>}
      {inputs.map((i) => {
        const common = {
          id: `${formId}-${i.name}`,
          value: values[i.name] ?? '',
          placeholder: i.placeholder,
          required: i.required,
          onChange: (e: { target: { value: string } }) => set(i.name, e.target.value),
          'data-testid': `skill-input-${i.name}`,
        }
        return (
          <Field key={i.name} label={i.required ? i.label : t('skillForm.optional', { label: i.label })} error={missing.includes(i.name) ? t('skillForm.required') : null}>
            {i.multiline
              ? <textarea {...common} rows={4} maxLength={SKILL_INPUT_TEXT_MAX} className={`${inputCls} h-auto min-h-16 resize-y py-2`} />
              : <input {...common} maxLength={SKILL_INPUT_VALUE_MAX} className={inputCls} />}
          </Field>
        )
      })}
      {!inputs.length && (
        <Field label={t('skillForm.request')}>
          <textarea value={free} onChange={(e) => setFree(e.target.value)} rows={3} maxLength={SKILL_INPUT_TEXT_MAX} placeholder={t('skillForm.requestHint')} className={`${inputCls} h-auto min-h-16 resize-y py-2`} data-testid="skill-input-free" />
        </Field>
      )}
      <p className="text-xs text-faint">{onCompose ? t('skillForm.noSecrets') : `${t('skillForm.noSecrets')} ${t('skillForm.newChat')}`}</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex items-center justify-end gap-2 pt-1">
        {onSkip && <Button variant="ghost" className="mr-auto" onClick={onSkip} data-testid="skill-form-skip">{t('skillForm.skip')}</Button>}
        <Button type="submit" variant="primary" busy={busy} disabled={!ready} data-testid="skill-form-run">
          <Play size={14} aria-hidden /> {onCompose ? t('skillForm.fill') : t('skillForm.run')}
        </Button>
      </div>
    </form>
  )
}

/** The form in a dialog (Team skills page, /skills?run=, "/" menu). The title names the skill: from `skill`, or the
 * folder of a SKILL.md (its name must equal it). */
export function SkillFormDialog({ path, skill, onClose, onCompose }: { path: string; skill?: SkillInfo; onClose: () => void; onCompose?: (message: string) => void }) {
  const t = useT()
  const name = skill?.name ?? /([^/]+)\/SKILL\.md$/.exec(path)?.[1]
  return (
    <Modal open onClose={onClose} width={560} title={name ? t('skillForm.title', { name }) : t('skillForm.titlePlain')}>
      <SkillForm path={path} skill={skill} onCompose={onCompose ? (m) => { onCompose(m); onClose() } : undefined} />
    </Modal>
  )
}
