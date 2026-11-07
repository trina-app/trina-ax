// Team settings: name, default language, update channel and window, retention periods, whether people may turn on
// "Allow all websites" in the desktop app's in-app browser (each team decides; the desktop app enforces it), whether
// members may add their own external-service connections (Settings > External services), whether AI reads send images
// and PDF pages to the AI (server/src/files/vision.ts), how many tool rounds one answer may take (Claude Code
// --max-turns, docs/DECISIONS.md "Tool rounds per answer"), voice input (off, OpenRouter
// with the team's key, or whisper.cpp on this server; docs/DECISIONS.md "Voice input through OpenRouter"; a saved team key
// turns it on while no provider is chosen, "Voice input on a team's own server: the key turns it on") and whether
// the AI's video and audio reads turn sound into text ("AI reads video and audio"), and the team
// logo (the tab icon and the home-screen app icon; shared/src/team-icon.ts), the company profile every chat's AI is told
// (components/onboarding/CompanyProfileCard.tsx), the dev environment (DevEnvTeam.tsx, hidden when the server has it
// off), and for the owner the ownership transfer
// (TransferOwner.tsx). After the form, the team's AI settings (AI defaults, who picks the engine, members' own AI
// accounts, usage limits; TeamAiSettings.tsx, #ai and #ai-limits) and the knowledge graph (KnowledgeGraph.tsx,
// #knowledge-graph), which save on their own. The OpenRouter key is sealed in the
// browser (lib/seal.ts), asks for the password again, and is never shown again (only its last 4 characters).
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { ExternalLink, RotateCcw, Upload } from 'lucide-react'
import { teamIconUrl, TEAM_ICON_TYPES } from '@mycel/shared'
import { ANSWER_STEP_LIMIT_MAX, ANSWER_STEP_LIMIT_MIN, DEFAULT_ANSWER_STEP_LIMIT, DEFAULT_SPEECH_MODEL, mediaTranscriptsDefault, mediaTranscriptsOffSmall, TeamSettings, type Locale, type SpeechHost, type SpeechProvider, DEFAULT_DECK_TIER } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { canSeal, sealSecret } from '../../lib/seal'
import { LOCALES, useLocale, useT } from '../../i18n'
import { isOwner, useMeStrict, useSession } from '../../store/session'
import { toast } from '../../store/ui'
import { Button, confirmDialog, Field, inputCls, Switch } from '../../components/ui'
import { AdminPageHeader, FlatCardsProvider, Loadable, SettingRow, SettingsSection, useAction, useLoad } from './common'
import { legacyWindow } from '../../lib/officeUpdate'
import { timeZoneOptions } from '../../lib/time-zones'
import { checkIconFile } from '../../lib/team-icon'
import TransferOwnerCard from './TransferOwner'
import CompanyProfileCard from '../../components/onboarding/CompanyProfileCard'
import { DevEnvTeamCard } from './DevEnvTeam'
import TeamAiSettings from './TeamAiSettings'
import KnowledgeGraphSettings from './KnowledgeGraph'

export default function TeamSettingsPage() {
  const t = useT()
  const me = useMeStrict()
  const signedIn = useSession((s) => s.signedIn)
  const act = useAction()
  const state = useLoad(() => api.call(API.settings))
  // an office Mac only: what runs while the update window is empty (UpdateWindowField); no other server is asked
  const office = useLoad(async () => (me.server.features?.officeUpdate ? api.call(API.officeUpdateStatus) : null))
  const [f, setF] = useState<TeamSettings | null>(null)
  const [busy, setBusy] = useState(false)
  // the form starts from the loaded settings once; saves keep it (a key save must not throw away other drafts)
  useEffect(() => {
    if (state.data) setF((x) => x ?? state.data)
  }, [state.data])
  const num = (k: keyof TeamSettings, min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => (x ? { ...x, [k]: Math.max(min, Math.min(max, Math.floor(Number(e.target.value) || min))) } : x))
  const windowOk = TeamSettings.shape.updateWindow.safeParse(f?.updateWindow).success
  const save = async () => {
    if (!f || !state.data || !windowOk) return
    setBusy(true)
    const g = { ...f, speechModel: f.speechModel || DEFAULT_SPEECH_MODEL }
    const changed = Object.fromEntries(Object.entries(g).filter(([k, v]) => state.data![k as keyof TeamSettings] !== v))
    const r = await act(() => api.call(API.updateSettings, { body: changed }), t('common.saved'))
    setBusy(false)
    if (r) { state.setData(r); setF(r) }
    if (r && ('updateWindow' in changed || 'timeZone' in changed)) void office.reload()
    // people who follow the team default (maybe this admin) now see the new language: refresh the own view at once,
    // and the chat retention that the chat delete, chat trash and member delete dialogs name (read from /api/me)
    if (r && (changed.defaultLocale || changed.speechProvider || changed.chatTrashRetentionDays !== undefined)) await api.call(API.me).then(signedIn, () => {})
  }
  // what is not saved yet (text fields and switches alike), and what blocks Save: the save bar says both
  const unsaved = !!f && !!state.data && Object.entries(f).some(([k, v]) => state.data![k as keyof TeamSettings] !== v)
  const nameOk = !!f?.teamName.trim()
  const fix = !windowOk ? 'window' : !nameOk ? 'name' : null
  const goToFix = () => {
    const el = document.querySelector<HTMLElement>(fix === 'window' ? '[data-team-field="update-window"]' : '[data-team-field="name"]')
    el?.scrollIntoView({ block: 'center' })
    el?.focus({ preventScroll: true })
  }
  const owner = isOwner(me)
  return (
    <FlatCardsProvider value>
      <AdminPageHeader title={t('admin.settings')} />
      <div className="max-w-3xl" data-testid="team-settings">
        <Loadable state={state}>
          {() =>
            f && (
              <>
                <SettingsSection title={t('teamSettings.section.general')} id="ts-general" testId="team-settings-general">
                  <SettingRow id="ts-name" title={t('setup.teamName')} desc={owner ? t('teamSettings.row.nameDesc') : t('teamSettings.nameOwnerOnly')}
                    control={<input id="ts-name" aria-describedby="ts-name-desc" className={clsx(inputCls, 'sm:w-64')} data-team-field="name" value={f.teamName} disabled={!owner} onChange={(e) => setF({ ...f, teamName: e.target.value })} maxLength={100} />} />
                  <SettingRow id="ts-locale" title={t('teamSettings.defaultLocale')} desc={t('teamSettings.defaultLocaleHint')}
                    control={
                      <select id="ts-locale" aria-describedby="ts-locale-desc" className={clsx(inputCls, 'sm:w-64')} value={f.defaultLocale} onChange={(e) => setF({ ...f, defaultLocale: e.target.value as Locale })} data-testid="team-default-locale">
                        {LOCALES.map((l) => (
                          <option key={l.id} value={l.id} lang={l.id}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    } />
                  <TeamIconRow />
                </SettingsSection>
                <SettingsSection title={t('teamSettings.section.time')} id="ts-time" testId="team-settings-time">
                  <SettingRow id="ts-time-zone" title={t('teamSettings.timeZone')} desc={t('teamSettings.row.timeZoneDesc')} more={t('teamSettings.timeZoneHint')}
                    control={
                      <select id="ts-time-zone" aria-describedby="ts-time-zone-desc" className={clsx(inputCls, 'sm:w-64')} value={f.timeZone} onChange={(e) => setF({ ...f, timeZone: e.target.value })} data-testid="team-time-zone">
                        {timeZoneOptions(f.timeZone).map((z) => (
                          <option key={z} value={z}>
                            {z}
                          </option>
                        ))}
                      </select>
                    } />
                  {/* the update window drives every automatic update of this server: the app's own (Linux), the root update
                      timer (mycel-ctl) and an office Mac's update agent, in the team time zone. A hosted server is updated
                      by its control plane, so it has none. (No channel here: the channel is the installation's own,
                      server.json on Linux and `teamax update channel` on an office Mac; update audit O1.) */}
                  {me.server.features?.selfUpdate !== false && (
                    <UpdateWindowField value={f.updateWindow} ok={windowOk} legacy={legacyWindow(office.data, state.data?.updateWindow)} onChange={(v) => setF({ ...f, updateWindow: v })} />
                  )}
                </SettingsSection>
                <SettingsSection title={t('teamSettings.section.data')} id="ts-data" testId="team-settings-data">
                  <DaysRow id="ts-audit" title={t('teamSettings.row.audit')} desc={t('teamSettings.row.auditDesc')} value={f.auditRetentionDays} min={7} max={3650} onChange={num('auditRetentionDays', 7, 3650)} />
                  <DaysRow id="ts-history" title={t('teamSettings.row.history')} desc={t('teamSettings.row.historyDesc')} value={f.fileHistoryRetentionDays} min={1} max={3650} onChange={num('fileHistoryRetentionDays', 1, 3650)} />
                  <DaysRow id="ts-trash" title={t('teamSettings.row.trash')} desc={t('teamSettings.row.trashDesc')} value={f.trashRetentionDays} min={1} max={365} onChange={num('trashRetentionDays', 1, 365)} />
                  <DaysRow id="ts-chat-trash" title={t('teamSettings.row.chatTrash')} desc={t('teamSettings.row.chatTrashDesc')} value={f.chatTrashRetentionDays} min={1} max={365} onChange={num('chatTrashRetentionDays', 1, 365)} />
                </SettingsSection>
                <SettingsSection title={t('teamSettings.section.ai')} id="ts-ai" testId="team-settings-ai">
                  <BrowserPolicySwitch value={f.browserAllowAll} onChange={(v) => setF({ ...f, browserAllowAll: v })} />
                  <PersonalIntegrationsSwitch value={f.personalIntegrations} onChange={(v) => setF({ ...f, personalIntegrations: v })} />
                  <AiVisionSwitch value={f.aiVision} onChange={(v) => setF({ ...f, aiVision: v })} />
                  <AiSubagentsSwitch value={f.aiSubagents} onChange={(v) => setF({ ...f, aiSubagents: v })} />
                  <AnswerStepLimitField value={f.answerStepLimit} onChange={(v) => setF((x) => (x ? { ...x, answerStepLimit: v } : x))} />
                  <DeckTierField value={f.introDeckTier} onChange={(v) => setF((x) => (x ? { ...x, introDeckTier: v } : x))} />
                </SettingsSection>
                <SpeechSection provider={f.speechProvider} model={f.speechModel} transcripts={f.aiMediaTranscripts} saved={state.data!} onChange={(p) => setF({ ...f, ...p })}
                  onSaved={(r) => { state.setData(r); setF((x) => (x ? { ...x, speechProvider: r.speechProvider, speechModel: r.speechModel } : x)) }} />
                {/* one Save for the whole form, switches too, in a bar that shows only while something is not saved (or a
                    field needs a fix, with a button that goes to it). It stays at the bottom of the screen. The logo and
                    the voice input key save at once, on their own buttons. */}
                {(unsaved || fix) && (
                  <div className="sticky bottom-3 z-10 mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-4 py-2.5 shadow-lg" data-testid="team-settings-savebar">
                    <p className="min-w-0 flex-1 text-sm" role="status">
                      {fix ? (
                        <span className="text-danger">
                          {t('adminux.settings.needsFix')}{' '}
                          <button type="button" className="font-medium underline" onClick={goToFix} data-testid="team-settings-go-fix">
                            {t('adminux.settings.goToField')}
                          </button>
                        </span>
                      ) : (
                        <span className="text-muted">{t('teamSettings.unsaved')}</span>
                      )}
                    </p>
                    <Button variant="ghost" disabled={busy} onClick={() => setF(state.data)} data-testid="team-settings-cancel">
                      {t('common.cancel')}
                    </Button>
                    <Button variant="primary" busy={busy} disabled={!!fix} onClick={save}>
                      {t('common.save')}
                    </Button>
                  </div>
                )}
              </>
            )
          }
        </Loadable>
        {/* the team's AI: defaults, who picks the engine, members' own accounts, usage limits (were Providers' second tab).
            After the form has loaded, so a link to #ai or #ai-limits lands where the page will stay */}
        {state.data && <TeamAiSettings />}
        {/* the code map the AI uses (knowledge_explore; server/src/knowledge-graph/): saves on its own, like the AI groups */}
        {state.data && <KnowledgeGraphSettings />}
        {/* what every team chat's AI is told about the company (docs/DECISIONS.md "D — Company profile") */}
        <CompanyProfileCard />
        <DevEnvTeamCard />
        {owner && <TransferOwnerCard ownerId={me.user.id} />}
      </div>
    </FlatCardsProvider>
  )
}

/** A retention period: a small number field with "days" after it. */
function DaysRow({ id, title, desc, value, min, max, onChange }: { id: string; title: string; desc: string; value: number; min: number; max: number; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  const t = useT()
  return (
    <SettingRow id={id} title={title} desc={desc}
      control={
        <span className="inline-flex items-center gap-2">
          <input id={id} aria-describedby={`${id}-desc`} className={clsx(inputCls, 'text-right tabular-nums')} style={{ width: '6.5rem' }} type="number" min={min} max={max} value={value} onChange={onChange} />
          <span className="text-sm text-muted">{t('teamSettings.days')}</span>
        </span>
      } />
  )
}

/**
 * The team logo: the tab icon of everyone's browser, the sign-in page's icon and the home-screen app icon. Uploaded
 * at once when chosen (PNG, JPEG or WebP; checked here first, the server checks again), removed back to the default
 * mark. A row with the logo now and its buttons; the previews at the sizes browsers and phones show it, on a light and
 * a dark background, behind "Show previews".
 */
export function TeamIconRow() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const refreshMe = useSession((s) => s.refreshMe)
  const version = me.team.iconVersion ?? null
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previews, setPreviews] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const upload = async (file: File) => {
    setError(null)
    const ok = await checkIconFile(file)
    if (!ok.ok) return setError(t(`teamIcon.problem.${ok.problem}`))
    setBusy('upload')
    try {
      await api.call(API.putTeamIcon, { query: { type: ok.type }, body: file })
      await refreshMe()
      toast({ level: 'success', text: t('teamIcon.saved') })
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(null)
    }
  }
  const remove = async () => {
    if (!(await confirmDialog({ title: t('teamIcon.removeTitle'), body: t('teamIcon.removeBody'), confirm: t('teamIcon.removeConfirm'), danger: true }))) return
    setError(null)
    setBusy('remove')
    try {
      await api.call(API.deleteTeamIcon)
      await refreshMe()
      toast({ level: 'success', text: t('teamIcon.removed') })
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(null)
    }
  }

  // what each place shows: the logo at every size, or the default mark (the SVG in tabs, the home-screen PNG)
  const tabSrc = version ? teamIconUrl(version) : '/favicon.svg'
  const homeSrc = version ? teamIconUrl(version) : '/icons/apple-touch-icon.png'
  return (
    <div data-testid="team-icon" data-version={version ?? ''}>
      <SettingRow heading title={t('teamIcon.title')}
        desc={<>{t('teamIcon.desc')} <span data-testid="team-icon-status">{version ? t('teamIcon.custom') : t('teamIcon.default')}</span></>}
        more={t('teamIcon.hint')}
        control={
          <span className="inline-flex flex-wrap items-center gap-2">
            <img src={homeSrc} alt="" width={36} height={36} className="h-9 w-9 rounded-lg border border-line object-cover" />
            <Button size="sm" busy={busy === 'upload'} disabled={busy !== null} onClick={() => input.current?.click()} data-testid="team-icon-upload">
              <Upload size={14} aria-hidden /> {version ? t('teamIcon.replace') : t('teamIcon.upload')}
            </Button>
            {version && (
              <Button size="sm" variant="ghost" busy={busy === 'remove'} disabled={busy !== null} onClick={() => void remove()} data-testid="team-icon-remove">
                <RotateCcw size={14} aria-hidden /> {t('teamIcon.remove')}
              </Button>
            )}
            <input
              ref={input}
              type="file"
              accept={TEAM_ICON_TYPES.join(',')}
              hidden
              data-testid="team-icon-input"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void upload(file)
              }}
            />
          </span>
        }
        below={
          <>
            {error && (
              <p role="alert" className="mt-2 text-sm text-danger" data-testid="team-icon-error">
                {error}
              </p>
            )}
            <button type="button" aria-expanded={previews} className="mt-2 text-sm font-medium text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setPreviews(!previews)} data-testid="team-icon-previews">
              {previews ? t('teamIcon.hidePreviews') : t('teamIcon.showPreviews')}
            </button>
            <div hidden={!previews} className="mt-3 flex flex-wrap gap-3">
              {(['light', 'dark'] as const).map((scheme) => (
                <figure key={scheme} className="m-0" data-testid={`team-icon-preview-${scheme}`}>
                  <div className={`flex flex-wrap items-end gap-4 rounded-xl border p-3 ${scheme === 'light' ? 'border-[#d9d6cf] bg-[#ffffff]' : 'border-[#3a3835] bg-[#1f1e1c]'}`}>
                    {[16, 32].map((n) => (
                      <div key={n} className="flex flex-col items-center gap-1.5">
                        <img src={tabSrc} alt="" width={n} height={n} style={{ width: n, height: n }} className="object-contain" data-testid={`team-icon-img-${n}`} />
                        <span className={`text-[0.6875rem] ${scheme === 'light' ? 'text-[#4a4743]' : 'text-[#c9c5bd]'}`}>{t('teamIcon.sizeTab', { n })}</span>
                      </div>
                    ))}
                    <div className="flex flex-col items-center gap-1.5">
                      <img src={homeSrc} alt="" width={180} height={180} style={{ width: 180, height: 180, borderRadius: 40 }} className="object-cover" data-testid="team-icon-img-180" />
                      <span className={`text-[0.6875rem] ${scheme === 'light' ? 'text-[#4a4743]' : 'text-[#c9c5bd]'}`}>{t('teamIcon.sizeHome', { n: 180 })}</span>
                    </div>
                  </div>
                  <figcaption className="mt-1 text-xs text-muted">{t(scheme === 'light' ? 'teamIcon.light' : 'teamIcon.dark')}</figcaption>
                </figure>
              ))}
            </div>
          </>
        } />
    </div>
  )
}

/** "Automatic update window". `legacy`: an office Mac runs a time set with an older `teamax update time` while this field
 * is empty (lib/officeUpdate.ts legacyWindow). It is told, as the placeholder and in the row's line, and never put into
 * the field: saving would turn it into a team setting nobody chose. */
export function UpdateWindowField({ value, ok, legacy, onChange }: { value: string | null; ok: boolean; legacy: { window: string; zone: string } | null; onChange: (v: string | null) => void }) {
  const t = useT()
  return (
    <SettingRow id="ts-update-window" title={t('teamSettings.updateWindow')}
      desc={legacy ? t('teamSettings.updateWindowLegacy', legacy) : t('teamSettings.row.updateWindowDesc')}
      more={legacy ? undefined : t('teamSettings.updateWindowHint')}
      below={ok ? null : <p id="ts-update-window-error" role="alert" className="mt-1.5 text-xs text-danger">{t('teamSettings.updateWindowBad')}</p>}
      control={
        <input id="ts-update-window" aria-describedby={ok ? 'ts-update-window-desc' : 'ts-update-window-error'} aria-invalid={ok ? undefined : true}
          className={clsx(inputCls, 'sm:w-64', !ok && 'border-danger focus:border-danger focus:ring-danger')} data-team-field="update-window" placeholder={legacy?.window ?? '02:00-05:00'} value={value ?? ''} onChange={(e) => onChange(e.target.value.trim() || null)} />
      } />
  )
}

/** One team switch as a settings row: the name labels it, the short line describes it, the long text is "Learn more". */
function SwitchRow({ id, value, onChange, title, desc, more, testId }: { id: string; value: boolean; onChange: (v: boolean) => void; title: string; desc: string; more: string; testId: string }) {
  return (
    <SettingRow id={id} title={title} desc={desc} more={more} testId={testId} attrs={{ 'data-on': value ? 'true' : 'false' }}
      control={<Switch id={id} external describedBy={`${id}-desc`} checked={value} onChange={onChange} label={title} />} />
  )
}

/**
 * "Members can turn on 'Allow all websites'" (desktop app's in-app browser), default on. Off: the desktop app refuses the
 * choice and turns it back to "ask for each new site" for anyone who had it on (it reads the policy from GET /api/me).
 */
export function BrowserPolicySwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const t = useT()
  return <SwitchRow id="ts-browser-allow-all" testId="team-browser-allow-all" value={value} onChange={onChange} title={t('teamSettings.browserAllowAll')} desc={t('teamSettings.row.browserAllowAllDesc')} more={t('teamSettings.browserAllowAllHint')} />
}

/** "Members can add their own connections" (Settings > MCP), default on. Off: none can be added and the ones there are
 * left out of chats; team connections are not affected. */
export function PersonalIntegrationsSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const t = useT()
  return <SwitchRow id="ts-personal-integrations" testId="team-personal-integrations" value={value} onChange={onChange} title={t('teamSettings.personalIntegrations')} desc={t('teamSettings.row.personalIntegrationsDesc')} more={t('teamSettings.personalIntegrationsHint')} />
}

/** "Send images, PDF pages and video frames to the AI" (default on; server/src/files/vision.ts). Off: AI reads send no
 * pixels. The short line keeps the one thing to know: the images go to the AI provider. */
export function AiVisionSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const t = useT()
  return <SwitchRow id="ts-ai-vision" testId="team-ai-vision" value={value} onChange={onChange} title={t('teamSettings.aiVision')} desc={t('teamSettings.row.aiVisionDesc')} more={t('teamSettings.aiVisionHint')} />
}

/** "Let the AI split work into sub-tasks" (default on; server/src/chat/subagents.ts). Off: no Agent tool. */
export function AiSubagentsSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const t = useT()
  return <SwitchRow id="ts-ai-subagents" testId="team-ai-subagents" value={value} onChange={onChange} title={t('teamSettings.aiSubagents')} desc={t('teamSettings.row.aiSubagentsDesc')} more={t('teamSettings.aiSubagentsHint')} />
}

/**
 * "Tool rounds per answer" (Claude Code --max-turns, default 150, 10-500). Typed freely: the form takes a number in
 * range at once and brings anything else back into range when the field is left (a per-key clamp turned "1" into 10).
 */
export function AnswerStepLimitField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useT()
  const [text, setText] = useState(String(value))
  // a saved or reloaded value replaces what is shown, unless it is what was typed
  useEffect(() => { setText((cur) => (Number(cur) === value ? cur : String(value))) }, [value])
  const inRange = (n: number) => Number.isInteger(n) && n >= ANSWER_STEP_LIMIT_MIN && n <= ANSWER_STEP_LIMIT_MAX
  const leave = () => {
    const n = Number(text)
    const v = text.trim() && Number.isFinite(n) ? Math.max(ANSWER_STEP_LIMIT_MIN, Math.min(ANSWER_STEP_LIMIT_MAX, Math.floor(n))) : value
    setText(String(v))
    if (v !== value) onChange(v)
  }
  return (
    <SettingRow id="ts-answer-step-limit" testId="team-answer-step-limit" title={t('teamSettings.answerStepLimit')} desc={t('teamSettings.row.answerStepLimitDesc', { def: DEFAULT_ANSWER_STEP_LIMIT })}
      more={t('teamSettings.answerStepLimitHint', { min: ANSWER_STEP_LIMIT_MIN, max: ANSWER_STEP_LIMIT_MAX, def: DEFAULT_ANSWER_STEP_LIMIT })}
      control={
        <input id="ts-answer-step-limit" aria-describedby="ts-answer-step-limit-desc" className={clsx(inputCls, 'text-right tabular-nums')} style={{ width: '6.5rem' }} type="number" inputMode="numeric" min={ANSWER_STEP_LIMIT_MIN} max={ANSWER_STEP_LIMIT_MAX} step={1} value={text}
          onChange={(e) => { setText(e.target.value); const n = Number(e.target.value); if (inRange(n)) onChange(n) }} onBlur={leave} />
      } />
  )
}

/** How long the company intro deck may take (server/src/intro-deck/tiers.ts): 3, 5 (the default, DEFAULT_DECK_TIER) or 10 minutes. */
export function DeckTierField({ value, onChange }: { value: TeamSettings['introDeckTier'] | undefined; onChange: (v: TeamSettings['introDeckTier']) => void }) {
  const t = useT()
  return (
    <SettingRow id="ts-deck-tier" testId="team-deck-tier" title={t('teamSettings.deckTier')} desc={t('teamSettings.row.deckTierDesc')} more={t('teamSettings.deckTierHint')}
      control={
        <select id="ts-deck-tier" aria-describedby="ts-deck-tier-desc" className={clsx(inputCls, 'sm:w-64')} value={value ?? DEFAULT_DECK_TIER} onChange={(e) => onChange(e.target.value as TeamSettings['introDeckTier'])}>
          <option value="quick">{t('teamSettings.deckTierQuick')}</option>
          <option value="standard">{t('teamSettings.deckTierStandard')}</option>
          <option value="deep">{t('teamSettings.deckTierDeep')}</option>
        </select>
      } />
  )
}

const PROVIDERS: SpeechProvider[] = ['off', 'openrouter', 'local']

/** hours of sound with one decimal ("1.5"); any use shows at least 0.1 */
export const speechHours = (sec: number): string => String(sec <= 0 ? 0 : Math.max(0.1, Math.round(sec / 360) / 10))

/** "Turn video sound into text" after the form's provider changed to `next`: another provider than the saved one starts
 * from its own default (null), and the saved provider gets the saved choice back (QA L4: an admin's "off" must not
 * turn on by picking another provider and back). The server resets the choice only when a save changes the provider. */
export const transcriptsAfterProvider = (next: SpeechProvider, saved: Pick<TeamSettings, 'speechProvider' | 'aiMediaTranscripts'>): boolean | null =>
  next === saved.speechProvider ? saved.aiMediaTranscripts : null

/** The switch with what it means on this server: where the sound goes, the piece length and how a read goes on, a
 * hosted server's cap, the speed measured here, and why it starts off on a small server (shared mediaTranscriptsDefault).
 * `hostedKey`: OpenRouter goes with the hosting service's key (on by default, its free hours). */
export function MediaTranscriptsSwitch({ provider, value, host, hostedKey = false, onChange }: { provider: SpeechProvider; value: boolean | null; host: SpeechHost; hostedKey?: boolean; onChange: (v: boolean) => void }) {
  const t = useT()
  const on = value ?? mediaTranscriptsDefault(provider, host.cpuCores, hostedKey)
  const local = provider === 'local'
  const perMinute = host.localSecPerSec === null ? null : host.localSecPerSec * 60
  return (
    <SettingRow id="ts-media-transcripts" testId="team-media-transcripts" attrs={{ 'data-on': on ? 'true' : 'false' }} title={t('speech.mediaTranscripts')}
      desc={<span className={local ? undefined : hostedKey ? undefined : 'text-warn'}>{local ? t('speech.mediaTranscriptsLocal', { sec: host.localPieceSec }) : hostedKey ? t('speech.mediaTranscriptsHostedKey') : t('speech.mediaTranscriptsOpenRouter')}</span>}
      control={<Switch id="ts-media-transcripts" external describedBy="ts-media-transcripts-desc" checked={on} onChange={onChange} label={t('speech.mediaTranscripts')} />}
      below={
        <>
          {local && value === null && mediaTranscriptsOffSmall(provider, host.cpuCores) && <p className="mt-1 text-xs text-muted" data-testid="team-media-transcripts-small">{t('speech.mediaTranscriptsSmall', { cores: host.cpuCores })}</p>}
          {local && host.hostedNewSec !== null && <p className="mt-1 text-xs text-faint">{t('speech.mediaTranscriptsHosted', { min: Math.round(host.hostedNewSec / 60) })}</p>}
          {local && perMinute !== null && (
            <p className="mt-1 text-xs text-faint" data-testid="team-media-transcripts-speed">
              {perMinute < 90 ? t('speech.mediaTranscriptsSpeedSec', { n: Math.max(1, Math.round(perMinute)) }) : t('speech.mediaTranscriptsSpeedMin', { n: Math.round(perMinute / 6) / 10 })}
            </p>
          )}
        </>
      } />
  )
}

/** Voice input: the provider (saved with the form), the OpenRouter model and the OpenRouter key (saved on its own), and
 * "Turn video sound into text" for the AI's video and audio reads (aiMediaTranscripts; null = this provider's default
 * on this server, transcriptsAfterProvider when the form's provider changes). */
export function SpeechSection({ provider, model, transcripts, saved, onChange, onSaved }: {
  provider: SpeechProvider; model: string; transcripts: boolean | null; saved: TeamSettings
  onChange: (p: { speechProvider?: SpeechProvider; speechModel?: string; aiMediaTranscripts?: boolean | null }) => void
  /** the settings after the key was saved or removed (the provider may follow the key: the form takes it too) */
  onSaved: (s: TeamSettings) => void
}) {
  const t = useT()
  const act = useAction()
  const signedIn = useSession((s) => s.signedIn)
  const key = useLoad(() => api.call(API.speechKey))
  const host = useLoad(() => api.call(API.speechHost))
  // a hosted server's key from the hosting service, used while the team has none of its own (its free hours)
  const hostedKey = provider === 'openrouter' && !!key.data?.hosted && !key.data.set
  // "this server" without the tools the mic's recordings need: voice input is off (Me.team.voiceInput), say which
  const missing = provider === 'local' ? host.data?.localMissing ?? [] : []
  const [secret, setSecret] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const secure = canSeal()
  const send = async (value: string | null) => {
    setBusy(true)
    const r = await act(async () => {
      const sealed = value === null ? null : await sealSecret(await api.call(API.sealingKey), value, 'speech.key')
      const out = await api.call(API.setSpeechKey, { body: { sealed, password } })
      // with no provider chosen, the server reads OpenRouter while the team's key is there (nothing stored: removing the
      // key turns voice input off again). Write a choice only over another saved one, or for another model
      const now = await api.call(API.settings)
      const m = model || DEFAULT_SPEECH_MODEL
      const patch = value === null ? {} : { ...(now.speechProvider !== 'openrouter' ? { speechProvider: 'openrouter' as const } : {}), ...(now.speechModel !== m ? { speechModel: m } : {}) }
      onSaved(Object.keys(patch).length ? await api.call(API.updateSettings, { body: patch }) : now)
      return out
    }, value === null ? t('speech.keyRemoved') : t('speech.keySaved'))
    setBusy(false)
    if (!r) return
    key.setData(r)
    setSecret('')
    setPassword('')
    await api.call(API.me).then(signedIn, () => {})
  }
  const remove = async () => {
    if (await confirmDialog({ title: t(key.data?.hosted ? 'speech.removeConfirmHosted' : 'speech.removeConfirm'), confirm: t('speech.removeKey'), danger: true })) await send(null)
  }
  return (
    <SettingsSection id="speech" testId="team-speech" title={t('speech.title')} desc={t('speech.desc')}>
      <SettingRow id="ts-speech-provider" title={t('speech.provider')}
        desc={provider === 'local' ? t('speech.localHint') : undefined}
        below={provider === 'openrouter' ? <p className={`mt-1 text-sm ${hostedKey ? 'text-muted' : 'text-warn'}`} data-testid="team-speech-privacy">{t(hostedKey ? 'speech.privacyHosted' : 'speech.privacy')}</p>
          : missing.length > 0 ? <p className="mt-1 text-sm text-warn" data-testid="team-speech-local-missing">{t('speech.localMissing', { tools: missing.join(', ') })}</p> : null}
        control={
          <select id="ts-speech-provider" aria-describedby={provider === 'local' ? 'ts-speech-provider-desc' : undefined} className={clsx(inputCls, 'sm:w-64')} value={provider}
            onChange={(e) => { const next = e.target.value as SpeechProvider; onChange({ speechProvider: next, aiMediaTranscripts: transcriptsAfterProvider(next, saved) }) }} data-testid="team-speech-provider">
            {PROVIDERS.map((p) => <option key={p} value={p}>{t(`speech.${p}`)}</option>)}
          </select>
        } />
      {provider !== 'off' && (
        <Loadable state={host} lines={1}>
          {(h) => <MediaTranscriptsSwitch provider={provider} value={transcripts} host={h} hostedKey={hostedKey} onChange={(v) => onChange({ aiMediaTranscripts: v })} />}
        </Loadable>
      )}
      {/* the hosting service's key is for its one model; the team picks a model for its own key */}
      {provider === 'openrouter' && !hostedKey && (
        <SettingRow id="ts-speech-model" title={t('speech.model')}
          control={<input id="ts-speech-model" className={clsx(inputCls, 'sm:w-64')} value={model} placeholder={DEFAULT_SPEECH_MODEL} spellCheck={false} maxLength={128} onChange={(e) => onChange({ speechModel: e.target.value.trim() })} onBlur={() => { if (!model) onChange({ speechModel: DEFAULT_SPEECH_MODEL }) }} />} />
      )}
      {provider === 'openrouter' && (
        <Loadable state={key} lines={1}>
          {(k) => (
            <SettingRow heading title={t('speech.key')}
              desc={<span data-testid="team-speech-key-state">{k.set ? t('speech.keySet', { hint: k.hint ?? '' }) : k.hosted ? t('speech.hostedKeyInUse') : t('speech.keyNone')}</span>}
              below={
                <div className="mt-2 space-y-3">
                  {k.hosted && (
                    <p className="text-xs text-muted" data-testid="team-speech-hosted-usage" data-used-sec={k.hosted.usedSec}>
                      {k.set ? t('speech.hostedOwnKey') : t('speech.hostedUsage', { used: speechHours(k.hosted.usedSec), free: speechHours(k.hosted.freeSec) })}
                    </p>
                  )}
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent-text hover:underline">
                      {t('speech.getKey')} <ExternalLink size={12} aria-hidden />
                    </a>
                    {/* what the team's own key costs (the owner's figure); a hosted team's free hours are above */}
                    {!k.hosted && <span className="text-muted" data-testid="team-speech-price">{t('speech.price')}</span>}
                  </p>
                  {!secure ? <p className="text-sm text-warn">{t('credentials.httpsOnly')}</p> : (
                    <div className="grid max-w-xl gap-3 sm:grid-cols-2">
                      <Field label={t('speech.key')}>
                        <input className={inputCls} type="password" autoComplete="off" spellCheck={false} placeholder="sk-or-…" value={secret} onChange={(e) => setSecret(e.target.value)} data-testid="team-speech-key" />
                      </Field>
                      <Field label={t('credentials.reauth')}>
                        <input className={inputCls} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="team-speech-password" />
                      </Field>
                      <div className="flex flex-wrap gap-2 sm:col-span-2">
                        <Button size="sm" variant="primary" busy={busy} disabled={secret.trim().length < 16 || !password} onClick={() => send(secret.trim())} data-testid="team-speech-save-key">{t('speech.saveKey')}</Button>
                        {k.set && <Button size="sm" busy={busy} disabled={!password} onClick={remove} data-testid="team-speech-remove-key">{t('speech.removeKey')}</Button>}
                      </div>
                    </div>
                  )}
                </div>
              } />
          )}
        </Loadable>
      )}
    </SettingsSection>
  )
}
