# The phone app's own screens follow the page's language, else the phone's

- Date: 2026-11-27
- Status: accepted
- Supersedes: none
- Branch: fix/id-korean-leaks (the owner, 11-27: "한글이 나오는 곳이 너무 많아. 인도네시아어로 했는데.", on an iPhone)

- **Ask:** a person who chose Bahasa Indonesia in the web app, on an iPhone set to Korean, saw the phone app's own
  screens (team address, offline, cannot reach, Trina is updating, Try again) in Korean. The app had only English,
  Korean and Chinese and read only the phone's language.
- **Rule:** the app's own screens use the language the team's page says, through an optional, versioned bridge message
  `language` (capability `language-v1`, `{ type: 'language'; locale: 'ko'|'en'|'id'|'ja'|'es'|'zh' }`, the web app's
  six languages). The page sends it when the bridge comes, when its language changes and after a session reset, like
  `appearance-v1`; it sends nothing to an app that does not offer the capability. The app keeps the latest one for that
  team (secure store, one team at a time) and uses it at the next launch too. Before the page has said, and on the
  first-run setup screen with no team, the phone's language decides, as before.
- **Languages:** Indonesian (`id`, and Android's old code `in`), Japanese and Spanish tables join English, Korean and
  Chinese for the native screens and the iOS permission texts (`app.config.ts` `locales`). Words are the web app's own
  (link undangan, alamat tim; 招待リンク, チームアドレス; enlace de invitación, dirección del equipo) and its voice rules
  (Anda; usted).
- **Left out:** the Android notification channel's name stays in the language at its first creation (the OS keeps it;
  renaming later is not worth the code). An error line already on the setup screen keeps the language it was shown in.
- **Tests:** tests/unit/mobile-push.test.ts (every table has English's keys and placeholders, `id-ID`/`in` pick
  Indonesian, `language` messages parsed and refused without the capability), web/test/unit/mobile.test.ts (the page
  sends it on bridge, change and reset; never to an app without it).
- **Version impact:** minor (a new optional bridge capability and three new languages in the phone app; older apps and
  older pages keep working).
