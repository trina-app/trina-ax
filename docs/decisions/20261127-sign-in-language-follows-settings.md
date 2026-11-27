# The language picked in Settings is this browser's sign-in language too

- Date: 2026-11-27
- Status: accepted
- Supersedes: [Offline reload language](../DECISIONS.md#offline-reload-language-qa2-offline-locale-2026-10-29) (only its rule that `mycel.locale` holds sign-in-screen picks alone)
- Branch: fix/id-korean-leaks (the owner, 11-27: "한글이 나오는 곳이 너무 많아. 인도네시아어로 했는데.", on an iPhone)

- **Ask:** a person who set the app to Bahasa Indonesia in a Korean team saw the sign-in screen, and its "wrong
  password" line, in Korean every time they were signed out or their session ended.
- **Rule:** the person's own language choice (Settings › Language, or the account's choice when they sign in) is also
  stored as this browser's sign-in language (`mycel.locale`). "Follow the team" clears it. The sign-in screen keeps its
  order: this browser's pick, else the team's default, else English. The recovery hint `mycel.recentLocale` is
  unchanged (cleared at sign-out).
- **Why:** like other apps, a device keeps the language its person chose; the team's default is for a browser nobody
  has chosen a language on.
- **Left out:** the browser's own language before the team's default on the sign-in screen (it stays only for first-run
  setup and a removed member's or guest's own screen).
- **Shared computers:** the next person sees the previous person's chosen language on the sign-in screen; it has the
  language picker, and their own choice applies once they sign in.
- **Tests:** web/test/unit session tests (sign-out after a Settings pick; follow the team clears it).
- **Version impact:** patch.
