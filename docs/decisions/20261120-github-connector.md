# GitHub as a connector: Sign in with GitHub through the server's GitHub App

- Date: 2026-11-20
- Status: accepted (the owner: a real sign-in button, not a pasted token)
- Supersedes: in [INTEGRATIONS.md "Discover"](../INTEGRATIONS.md) and DECISIONS.md "External services: Connected and
  Discover", GitHub being left out because it needs an app of its own
- Branch: feat/github-connector

- **Ask:** connect GitHub the way other AI products do: press Connect, sign in at GitHub, done. No personal access
  token to make and paste.
- **What others do (checked 2026-11-20):** Claude.ai, ChatGPT/Codex, Cursor, Linear, Notion and Slack all use a
  **GitHub App**: the person (or an organization owner) installs it and picks the repositories on GitHub's own page;
  the product signs the person in with the app. GitHub's remote MCP server (`https://api.githubcopilot.com/mcp/`) has
  OAuth metadata but **no dynamic client registration** (github-mcp-server issues #549, #1404): every host brings its
  own app's client ID and secret.
- **Rule:**
  - GitHub is one more card in Discover, at GitHub's official MCP address. Its tools are GitHub's (46 by default on
    2026-11-20; read tools marked read-only by GitHub, so changes go through the write card as for every connection).
  - A connection at that exact address (https, host and path only: `serverAppAt`) with no own app signs in through the
    **GitHub App the server holds** (`server/src/integrations/github/app.ts`): `MYCEL_GITHUB_APP_FILE`, else
    `<secrets>/integrations/github/app.json` (`clientId`, `clientSecret`, optional `slug`), a private file of the server
    account read like Google's client files. Sign-in and token addresses are GitHub's, fixed in code, never discovered.
    Everything else is the ordinary own-app sign-in (PKCE S256, state, `iss` checked, sealed tokens, the secret only to
    the token address and hidden in answers), so personal connections, team connections and templates all work.
  - **GitHub App, not an OAuth App:** fine-grained permissions instead of the broad `repo` scope, the repositories
    chosen per installation on GitHub's page (our "Choose on GitHub" link goes there, no picker of our
    own), organizations install or approve it like any GitHub App, and user tokens expire after 8 hours with a
    refresh token (refreshed here ahead of expiry; GitHub's rotated refresh token is kept).
  - **One app, many team addresses:** the app's callback URL is registered once on the team domain with GitHub's
    wildcard matching (`https://<team domain>/api/integrations/oauth/callback` also takes every
    `<team>.<team domain>` address with that path). So a hosted team needs no broker for GitHub, unlike Google (which
    takes exact addresses only: the Drive broker). The hosting service only writes the app file on its servers. A
    server on a company's own address uses the company's own GitHub App: the same file, or a team template with
    "Sign in with my own app".
  - Refreshes use the app **as it is now** (a rotated secret works without anyone signing in again; another client
    ID ends the sign-ins). GitHub's HTTP-200 token errors (`bad_refresh_token`, `bad_verification_code`,
    `incorrect_client_credentials`) are read as refusals.
  - **Checked for real (2026-11-20)** with the registered app (trina-app › "Trina AX", slug `trina-ax`): the GitHub
    App user token works on GitHub's MCP server; reading, an issue and a pull request from a chat; the shared-chat card;
    a refresh; the wildcard callback takes `<team>.trina.app` and refuses other hosts and paths.
  - Without the app file the card says "Not set up yet" (a member can ask an admin; an admin reads where it is set
    up), and a sign-in fails as for any service that registers no apps.
- **Not now (MVP first):** revoking the grant at GitHub on Disconnect (GitHub's `DELETE /applications/{client_id}/grant`
  needs its own call; the person can revoke in GitHub › Settings › Applications), an admin page to upload the app
  file (operators and the hosting service write it), moving the client secret behind the control plane like the Drive
  broker (every hosted server holds the app's secret; the token is useless without the person's sign-in, and the
  secret can be rotated on GitHub without anyone signing in again).
