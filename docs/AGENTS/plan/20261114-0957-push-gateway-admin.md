# Owners and admins choose where phone notifications go (Settings › Notifications)

- Date (UTC): 2026-11-14 09:57
- Branch: `feat/push-gateway-admin`
- Status: in progress
- Where: Team AX core (`server/src/notifications/`, `server/src/routes/`, `shared/src/api/`, Settings › Notifications in
  `web/src/components/settings/`). Why: phone push and team settings are core features (docs/REPOSITORY-RULES.md); the
  edition default stays in `editions/trina/branding/service.json`.
- Version impact: minor: a new admin setting and endpoint; no migration (the `settings` table holds it).

## Goal

Since #815 a Trina team server sends phone pushes through `https://push.trina.app` unless its operator sets
`MYCEL_PUSH_GATEWAY` or `push.gatewayUrl`. A self-hosted team that builds its own phone app needs its own gateway, and
editing server config is a developer's job. The owner (2026-11-14): self-hosted operators may want to change the phone
push address, so open it in the admin page.

## Scope

In:
- Settings › Notifications › Phone: one row "Phone notifications" for owners and admins (members do not see it), with
  three choices: **Trina push (default)** (phones with the Trina store app get notifications), **Off**, **Custom**
  (an address field with one line under it: works only with your own app build; the store app can't receive these).
- Save of Custom checks `<address>/health` answers `{"ok":true}` first; otherwise it says why and saves nothing. Address
  rule as app-config (`https://<host>`, or `http://127.0.0.1:<port>` for a gateway on the same machine).
- Operator config wins: when `MYCEL_PUSH_GATEWAY` or server.json `push.gatewayUrl` is set, the row shows the value,
  is locked, and one line says where it is set.
- Stored in the `settings` table (key `push.gateway`); read on every use, so a change applies without a restart. Audit
  entry `push.gateway` (choice and host).
- The old one-line gateway note under "Device push notifications" (and the desktop app's row) goes: the new row says it.
- Copy English first, then ko/id/ja/es/zh. Docs: DECISIONS, self-host docs, push-gateway README; changes fragment.

Out: per-person gateways; changes to the gateway itself; a test-send button.

## Steps

1. AppConfig `push.setBy` ('env' | 'file' | null) from `resolvePushGateway`'s inputs.
2. `server/src/notifications/push-gateway-setting.ts`: read/write the choice, `effectiveGateway`, health check.
   `readNativePushConfig` uses it.
3. API `GET/PUT /api/admin/push-gateway` (admin), audit, refusal reasons.
4. Web row (SettingRow / PhoneChoiceRow), remove the old lines, i18n.
5. Tests: server unit (resolution, lock, health reasons, route permissions and audit), web unit (row per role, lock,
   custom save error), e2e if the settings page has one. UI shots 1440/390, light/dark, owner/admin/member.

## Risks

- SSRF: the health check is a GET to an address an admin typed. https hosts must resolve to public addresses only (as
  web_fetch), no redirects, 5 s bound, 512 bytes read; loopback only as `http://127.0.0.1:<port>`, never on a hosted
  server.
- A changed address leaves old device rows unused (`nativeConfigKey`), as before: phones register again at the next
  sign-in or app start.
- Developer servers: the edition default does not apply there (no change from #815), so "Trina push" on a dev server
  sends nothing.
