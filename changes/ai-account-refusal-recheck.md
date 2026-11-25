- An AI account is no longer shown as **Refused** after one refusal that a second, free check does not confirm. The
  request is tried again on the same account instead.
- A Claude account whose plan or organization does not allow access right now now says exactly that, instead of
  "subscription ended". Trina checks such accounts again every few hours and uses them again by itself once they are
  allowed. The provider's own answer is shown when you open the account's row.
- **Check again** in Admin › AI providers shows a spinner on the account while it checks, then says what it found:
  connected, still refused (with the reason and a Reconnect button), or could not check (try again in a moment).
