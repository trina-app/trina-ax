# One e-mail signs in one account: the login takes the e-mail, and no two accounts get the same new one

- Date: 2026-11-27
- Status: accepted
- Supersedes: [20261116-admin-guest-email-unique](20261116-admin-guest-email-unique.md) (members may no longer share
  an address either)
- Branch: fix/create-team-live-qa, batch/20261127d (live QA of 0.20.0, security re-review)

- **Ask:** an owner made from the desktop app gets a username from the e-mail that they never chose, so the team's
  sign-in must take the e-mail too. The security re-review: no guessing spread over several accounts, no shared
  answer that tells who is in the team, no username that takes over another person's e-mail.
- **Rule:**
  - The sign-in name is the username (trimmed, any case), else the e-mail of exactly **one** active account (any
    case). An address no active account or several accounts have is an unknown name: the same answer and the same one
    password check. Once an e-mail names an account, it is that account: its own lock, temporary-password count and
    everything else, as by username.
  - No new or changed e-mail may be one another active account has, or another account's username: Settings ›
    Profile, Admin › Members, a new member ("Another account already uses this email."). An address Google gives at a
    join that another account has is not kept (the person adds one in Settings). Accounts that share an address from
    before keep it and sign in with their username.
  - No new username may be any account's e-mail.
- **Why:** a sign-in by e-mail is only safe when an e-mail stands for one person; refusing new shared addresses keeps
  it so, and treating old shared ones as unknown keeps every answer the same.
- **Tests:** tests/unit/a-login-email.test.ts, tests/unit/a-admin-guest-email.test.ts, tests/unit/a-guests-email.test.ts.
- **Version impact:** patch (a fix of the sign-in; members can no longer share a new address).
