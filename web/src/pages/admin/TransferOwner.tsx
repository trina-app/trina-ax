// Team settings > Transfer ownership (owner only): make another active person the owner. The server asks for the
// password again (POST /api/admin/transfer-ownership, auth owner-reauth) and makes the old owner an admin, so the
// screen reloads the own account after the transfer and the owner-only controls go away.
import { useState } from 'react'
import type { User } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { useT } from '../../i18n'
import { useSession } from '../../store/session'
import { Button, Field, inputCls } from '../../components/ui'
import { Card, ReauthDialog, useAction, useLoad } from './common'

/** Who can become the owner: active people other than the owner (admins and members). */
export function transferCandidates(users: readonly User[], ownerId: string): User[] {
  return users.filter((u) => u.id !== ownerId && u.role !== 'owner' && u.status === 'active')
}

/** The picker and its button, without data loading (rendered alone in web/test/unit/transfer-owner.test.tsx). */
export function TransferOwnerForm({ candidates, value, onChange, onStart }: { candidates: readonly User[]; value: string; onChange: (id: string) => void; onStart: () => void }) {
  const t = useT()
  if (!candidates.length) return <p className="text-sm text-faint" data-testid="transfer-none">{t('transfer.none')}</p>
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label={t('transfer.to')}>
        <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} data-testid="transfer-target">
          <option value="">{t('transfer.pick')}</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({t(`role.${u.role}`)})
            </option>
          ))}
        </select>
      </Field>
      <Button variant="danger" disabled={!value} onClick={onStart} data-testid="transfer-start">
        {t('transfer.start')}
      </Button>
    </div>
  )
}

export default function TransferOwnerCard({ ownerId }: { ownerId: string }) {
  const t = useT()
  const act = useAction()
  const signedIn = useSession((s) => s.signedIn)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const [target, setTarget] = useState('')
  const [confirming, setConfirming] = useState(false)
  const candidates = transferCandidates(users.data ?? [], ownerId)
  const chosen = candidates.find((u) => u.id === target)
  return (
    <Card title={t('transfer.title')} desc={t('transfer.desc')}>
      {users.data && <TransferOwnerForm candidates={candidates} value={target} onChange={setTarget} onStart={() => setConfirming(true)} />}
      {confirming && chosen && (
        <ReauthDialog
          danger
          title={t('transfer.confirmTitle', { name: chosen.name })}
          body={t('transfer.confirmBody', { name: chosen.name })}
          confirm={t('transfer.confirm')}
          onClose={() => setConfirming(false)}
          onConfirm={async (password) => {
            const r = await act(() => api.call(API.transferOwnership, { body: { userId: chosen.id, password } }), t('transfer.done', { name: chosen.name }))
            if (!r) return
            setConfirming(false)
            setTarget('')
            // this person is an admin now: reload the own account so the owner-only screens and controls go away
            await api.call(API.me).then(signedIn, () => {})
          }}
        />
      )}
    </Card>
  )
}
