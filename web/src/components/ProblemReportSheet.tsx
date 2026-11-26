// "문제 신고" (docs/decisions/20261126-problem-reports.md): one sheet for Settings › About and 👎 under an AI answer.
// One box, one line on who reads it (and, on a self-installed server, that it leaves the server), and from 👎 one tick
// that sends the person's own question and the answer, with a preview of exactly that. The server builds the rest from
// an allow-list (server/src/system/problem-reports.ts) and sends it in the background: "받았어요" at once.
import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { PROBLEM_REPORT_ANSWER_MAX, PROBLEM_REPORT_QUESTION_MAX, PROBLEM_REPORT_TEXT_MAX, problemReportCut } from '@mycel/shared/cloud-protocol/problem-report'
import { api, API, errorText, isApiError } from '../lib/api'
import { problemReportClient, screenKindOf } from '../lib/problemReport'
import { useLocale, useT } from '../i18n'
import { useMe } from '../store/session'
import { toast } from '../store/ui'
import { Button, Modal, inputCls } from './ui'

export interface ReportedAnswer {
  messageId: string
  /** the tick may be offered: the person's own chat of one person (the server checks it again) */
  conversation: { question: string; answer: string } | null
}

export default function ProblemReportSheet({ answer, onClose }: { answer?: ReportedAnswer; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const where = useLocation()
  const [text, setText] = useState('')
  const [attach, setAttach] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const self = me?.server.problemReports === 'self'
  const ready = text.trim().length > 0 && !busy
  const conv = answer?.conversation ?? null
  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.call(API.sendProblemReport, { body: {
        text: text.trim(), screen: screenKindOf(where.pathname), client: problemReportClient(),
        ...(answer ? { answer: { messageId: answer.messageId, withConversation: !!conv && attach } } : {}),
      } })
      toast({ level: 'success', text: t('problemReport.sent') })
      onClose()
    } catch (e) {
      setError(isApiError(e) && e.status === 429 ? t('problemReport.limit') : errorText(e, locale, t('error.network')))
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title={t('problemReport.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={send} data-testid="problem-report-send">{t('problemReport.send')}</Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="problem-report-sheet">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">{t('problemReport.label')}</span>
          <textarea
            className={`${inputCls} h-auto min-h-32 resize-y py-2`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={PROBLEM_REPORT_TEXT_MAX}
            placeholder={t('problemReport.placeholder')}
            data-autofocus
            data-testid="problem-report-text"
          />
        </label>
        {conv && (
          <div>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--c-accent)]" checked={attach} onChange={(e) => setAttach(e.target.checked)} data-testid="problem-report-attach" />
              <span>{t('problemReport.attach')}</span>
            </label>
            {attach && (
              // exactly what goes: the question and the answer, cut as the server cuts them, and a line on the rest
              <div className="mt-2 max-h-48 space-y-2 overflow-y-auto rounded-xl border border-line bg-subtle px-3 py-2 text-xs leading-5 text-muted" data-testid="problem-report-preview">
                {conv.question.trim() && (
                  <p className="break-words whitespace-pre-wrap"><span className="font-medium text-ink">{t('problemReport.previewQuestion')}</span>{'\n'}{problemReportCut(conv.question, PROBLEM_REPORT_QUESTION_MAX)}</p>
                )}
                <p className="break-words whitespace-pre-wrap"><span className="font-medium text-ink">{t('problemReport.previewAnswer')}</span>{'\n'}{problemReportCut(conv.answer, PROBLEM_REPORT_ANSWER_MAX)}</p>
                {/* the rest of what goes with it (server/src/system/problem-reports.ts buildProblemReport), in one line */}
                <p className="text-faint" data-testid="problem-report-preview-also">{t('problemReport.previewAlso')}</p>
              </div>
            )}
          </div>
        )}
        <p className="text-sm text-muted" data-testid="problem-report-who">
          {t('problemReport.who')}{self ? ` ${t('problemReport.whoSelf')}` : ''}
        </p>
        {error && <p role="alert" className="text-sm text-danger" data-testid="problem-report-error">{error}</p>}
      </div>
    </Modal>
  )
}
