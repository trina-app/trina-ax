// Admin › Connected apps › Ask a member to connect: who the picker offers (components/integrations/RequestDialog.tsx).
// A guest never opens Settings › Connectors, so a request to one would wait on nobody: guests are not offered (QA TC-2948).
import { expect, test } from 'bun:test'
import type { User } from '@mycel/shared/api'
import { askablePeople } from '../../src/components/integrations/RequestDialog'

const person = (id: string, name: string, o: Partial<User> = {}) => ({ id, username: id, name, email: null, role: 'member', status: 'active', mustChangePassword: false, groupIds: [], ...o }) as unknown as User

test('active members and admins by name; never a guest or a disabled account', () => {
  const users = [
    person('olga', 'Olga', { role: 'owner' }),
    person('gina', 'Gina', { role: 'guest' }),
    person('bob', 'Bob'),
    person('ada', 'Ada', { role: 'admin' }),
    person('dan', 'Dan', { status: 'disabled' }),
  ]
  expect(askablePeople(users).map((u) => u.id)).toEqual(['ada', 'bob', 'olga'])
})
