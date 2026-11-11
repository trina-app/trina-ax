# Desktop: a stuck storage clear never blocks the in-app browser or team removal

- Date (UTC): 2026-11-11 06:32
- Branch: `fix/desktop-clear-storage-hang`
- Status: done
- Where: `desktop/`. Why: the hang is in the desktop app's main process (Electron session clears).
- Version impact: patch, desktop app only; no API, bridge or data change

## Goal

While testing PR #360 on macOS 26.6 with Electron 44.7.2, `session.clearStorageData()` with no options never settled.
The in-app browser runs that clear when another person signs in or the person signs out
(`BrowserPane.resetForNewPerson`, `AppWindow.checkBrowserOwner`). Every AI browser call waits for that identity check
(`ensureBrowserOwner`), so every later AI browser call waited forever. Removing a team (`AppWindow.removeTeam`) awaits
the same clear, so it never finished. If the packaged app does the same, a person's in-app browser stops working after
a sign-out or a person switch.

## Scope

In:
- Every `clearStorageData` / `clearCache` / `clearAuthCache` call in `desktop/` goes through one helper that clears an
  explicit list of storage types (cookies, local storage, IndexedDB, file systems, service workers, cache storage,
  shader cache), the HTTP cache and HTTP logins, each with a time limit. A clear that does not finish in time is
  logged and the app goes on.
- Callers: the pane's "new person" reset, the reset when the pane is closed, team removal (both partitions).

Out: Electron upgrade; a bug report upstream (noted in the PR).

## Steps

1. List the clear calls and what waits on them.
2. Reproduce on this Mac (minimal Electron app and the real app) and note which storage types hang.
3. `desktop/src/main/clear-session.ts`: the helper with a time limit per clear.
4. Use it in `pane.ts` and `app-window.ts`.
5. Unit tests (time limit, the list of types, the call sites), desktop e2e (sign-out then an AI browser call, team
   removal finishing, nothing of the first person left: cookies, localStorage, IndexedDB, cache storage, service
   workers).
6. `changes/desktop-clear-storage-hang.md`, a docs/DECISIONS.md entry.

## Risks

- A clear that times out may leave that type's data in place. The time limit is logged; the identity check still
  moves the pane to the new person (tabs closed, allowed sites forgotten), as the task asks.
- The explicit list leaves out data types the "all" mask also removed (media licences, interest groups, shared storage,
  attribution data, device-bound sessions and the like). Sites keep sign-ins in cookies and site storage, which the
  list covers; device-bound sessions need a key service Electron 44 does not have (docs/DECISIONS.md).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/e-*.test.ts`, the desktop e2e suite
(`person`, `desktop`, `keyboard-focus`, `page-focus` and the rest).

## Result

Built as planned, PR #384. Reproduced on the Mac: while it was overloaded (load average ~230), a no-list clear and
`clearData()` never settled in this app and in a bare Electron app; each
named type and the list together settled in 1-2 s. Likely cause: background-priority subtasks starved (see
docs/DECISIONS.md). Added after review: a failed (not timed-out) clear does not record the new person, as before; a
removed team leaves the list before its data is cleared.
