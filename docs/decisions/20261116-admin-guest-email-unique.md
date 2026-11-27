# An admin can't give a guest an e-mail used in the team

- Date: 2026-11-16
- Status: superseded by [20261127-one-email-one-account](20261127-one-email-one-account.md)
- Supersedes: the "Left as is" line of [A guest can't take an e-mail used in the team](../DECISIONS.md#a-guest-cant-take-an-e-mail-used-in-the-team--게스트는-팀에서-쓰는-이메일을-못-쓴다-fixguest-email-unique-2026-11-16-the-owner)
- Branch: fix/admin-guest-email-unique (the owner)

- **Ask:** #1029 stopped a guest from setting an e-mail another account in the team gives (Settings › Profile), but an
  owner or admin could still set one for a guest in Admin › Members (`PATCH /api/admin/users/:id`). Close that gap with
  the same rule.
- **Rule:** `PATCH /api/admin/users/:id` on a guest (`users.guest = 1`, read from the database inside the write) with an
  address another account gives (not deleted, any state), compared as Settings › Profile and the Slack e-mail proof
  compare (NFC, trimmed, lower case; `auth/guests.ts emailUsedByOther`), is 409 `conflict`, `params.reason:
  'email_in_use'`, field `body.email`, with the same plain line: "This e-mail is already used in this team." Nothing in
  that change is saved (other fields in the same body included). The line names nobody, like the Profile one, even
  though an admin can see the people list anyway: one wording for one rule.
- **Not limited:** the guest's 10-addresses-an-hour cap is not applied to an admin's changes (an admin already sees
  every address in the people list, so there is nothing to probe), and an admin's changes do not count against it.
- **Members unchanged:** an admin may still give members the same address. Making a guest a member (`convert-guest`)
  needs no check: afterwards they are a member. No path makes a member a guest (`role` takes no `guest`), so there is
  nothing to check there.
- **Tests:** `tests/unit/a-admin-guest-email.test.ts`.
