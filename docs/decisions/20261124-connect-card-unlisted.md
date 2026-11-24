# The chat's connect card says when an address is not in the app's list, and still connects

- Date: 2026-11-24
- Status: accepted
- Supersedes: none (the words of the warning box in
  [The chat's connect card trusts the app's list](../DECISIONS.md#the-chats-connect-card-trusts-the-apps-list-fixconnect-card-trust-2026-11-12-qa-tc-135-bugs-2-4-5))
- Branch: feat/connect-card-unlisted (the owner, 2026-11-24)

- **Ask:** when the AI fills in a connection whose address is not a listed service's official address, show a warning
  and still allow connecting. The owner's line: "트리나 앱 목록에 없는 주소예요. 이 서비스의 공식 문서에 나온 주소와
  같은지 확인해 주세요."
- **Rule:** the card's existing warning box (`connect-unlisted`, the host in bold before it) carries the owner's line,
  no second line. Before, it said "This app does not know this address, so it cannot check it. Connect only if you know
  and trust it.", which did not say what to check.
  - en: "This address is not in Trina's list of apps. Check that it matches the address in the service's official docs."
  - ko: "트리나 앱 목록에 없는 주소예요. 이 서비스의 공식 문서에 나온 주소와 같은지 확인해 주세요."
  - ja: "トリナのアプリ一覧にないアドレスです。このサービスの公式ドキュメントにあるアドレスと同じか確認してください。"
  - zh: "这个地址不在 Trina 的应用列表中。请确认它与这项服务官方文档中的地址一致。"
  - es: "Esta dirección no está en la lista de apps de Trina. Compruebe que coincide con la de la documentación oficial
    del servicio."
  - id: "Alamat ini tidak ada di daftar aplikasi Trina. Pastikan alamatnya sama dengan yang ada di dokumentasi resmi
    layanan ini."
- **When it shows (unchanged):** a `connect_service` card for a service (`web/src/lib/connectCard.ts` `cardTrust` kind
  `unlisted`) whose address is not exactly a listed service's official one (`officialService`: https, host and path; a
  service's other official addresses in `shared/src/service-catalog.ts` `otherUrls`, such as Atlassian's v1, Canva's
  documented one or Netlify's earlier one, count as official). Not on an admin's template (the team chose the address)
  or a reconnect card (a connection the person already has). A listed name at another address keeps its more exact
  line in its place ("This is not Notion's official address. Notion's official address is mcp.notion.com. …"), so a
  card has at most one such line.
- **Connecting stays possible.** The warning is a line, not a block or a second step: self-hosted and regional editions
  and services the list does not have are allowed (owner decision 2026-11-12), and the person is the check.
- **Why the owner's words:** "Connect only if you know and trust it" asked for trust without a way to get it; the
  service's own documentation is where the person can check the address the AI chose.
- **Left out:** the not-official line's words; the Settings dialogs (the person types the address there); the server,
  which already sends the card as it is.
- **Tests:** `web/test/unit/connect-card.test.tsx` (an unknown MCP server, an HTTP API with a key header, a sign-in
  service and a listed host at another path show the one line with the host in bold and keep Connect; a listed
  official address, another official address of a listed service, templates and reconnect cards do not; the Korean and
  English words pinned).
- **Version impact:** patch (the same warning on the same card, in plainer words).
