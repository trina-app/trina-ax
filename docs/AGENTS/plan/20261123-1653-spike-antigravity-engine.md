# Spike: Antigravity CLI (`agy`) as a third engine

- Date (UTC): 2026-11-23 09:53 (local 16:53)
- Branch: `spike/antigravity-engine`
- Status: spike done; subscription section added 2026-11-23 on owner request. Doc only. No product code changed. No production host touched.
- Question: can Google's Antigravity CLI (`agy`) run as a third Trina AX engine next to Claude Code and Codex, with
  the same lock-down (restricted tools, engine sandbox, model proxy, team tools through MCP)?

## Answer

**Feasible, with conditions, in API key mode only.** A Google subscription sign-in (Pro/Ultra) is **not
recommended**: the Antigravity terms call it a breach (see [Google subscription sign-in](#google-subscription-sign-in-google-ai-pro--ultra)).
One open check: all runs used a mock model, so one short run with a real
Gemini API key (through a local proxy) must pass before the build starts. `agy` 1.5.15 ran headless in a non-TTY, inside a copy of the Trina Linux engine
sandbox (bubblewrap + Landlock `required-scoped` + seccomp + `--net-proxy`), with a placeholder API key and all model
traffic sent to a local stand-in for the model proxy. Team tools worked through the real `mycel-bridge`. The deny
rules stopped every built-in tool that we forced the model to call.

The conditions are in [Conditions](#conditions). The two most important:

1. `agy` has **no allow-list** for its built-in tools. It always declares 14 built-in tools to the model. We can only
   block them with deny rules, and some tools (`schedule`, `swarm`, `send_message`, `manage_task`,
   `define_subagent`) have no permission action at all. This is weaker than Claude (`--tools`) and Codex
   (`features.*=false` + locked catalog). The engine sandbox must stay the real boundary.
2. Use **Gemini API key mode only** (`modelProvider: "gemini"`). Never a Google account login or a personal
   subscription.

Before we build it: Trina's own `api` engine already supports Gemini models through Google's OpenAI-compatible
endpoint (`server/src/engine/api-agent.ts`, line 2). If the goal is "Gemini models in Trina", that path costs almost
nothing. Build the `agy` engine only if the team needs agy's own agent behaviour.

## How we tested

All runs were on this Mac, in throwaway OrbStack containers (Linux 7.2, arm64, Landlock ABI 10). The containers, the volume and
the image were deleted after the spike. No account and no real API key were used. Model spend: 0.

- `agy` 1.5.15, `linux_arm64` build, from Google's release manifest, SHA-512 checked. It is one 257 MB dynamically
  linked ELF (glibc). The `linux_amd64` build (274 MB) exists. We did not run it.
- **Model proxy stand-in:** a small mock of the Gemini API on `127.0.0.1:47821`
  (`POST /v1beta/models/<model>:streamGenerateContent?alt=sse`). It logged every request, so we saw the exact tool
  declarations that `agy` sends to the model. A prompt `CALL <tool> <json>` made the mock answer with that function
  call, so we could force each tool.
- **Team tools stand-in:** a fake `tools.sock` server that speaks MCP. The engine reached it through the real
  `mycel-bridge` (built from `native/cmd/mycel-bridge`, origin/dev d8b57856f).
- **Sandbox:** the argv of `buildBwrapArgs` (golden test `goldenClaude` in
  `native/cmd/mycel-launcher/sandbox_linux_test.go`), with the agy engine folder in place of Claude's, and the real
  `mycel-sandbox` helper (`exec --landlock required-scoped --exec-allow ... --net-proxy 47821`). The container used the
  security options of `docker/docker-compose.yml` (cap list, `seccomp.json`, `apparmor=unconfined`,
  `systempaths=unconfined`, `no-new-privileges`) and `--network none`. So the only network the engine had was the
  mock on loopback, forwarded into the turn's own network namespace. This is a fair stand-in for "nftables: model
  proxy only". The real nftables rule was not part of the test.
- **Discovery pass** (no sandbox, container with network): `strace -f -e connect,execve` to find what `agy` reaches
  and starts.

## The 5 checks

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | Headless, non-TTY, in the Trina sandbox, no hang | **Pass against a mock model.** Real-model run pending. | `agy -p ... --output-format stream-json < /dev/null` ended in 0.2–0.3 s in the sandbox, 0.8 s without it. 20 of 20 sandboxed turns with a team-tool call ended with exit 0. `--input-format stream-json` (two turns, one process) also ended. Needs `--allow-listen` (see C3). Issue #318 (hang) did not show with the mock. But #318 is in print mode's "turn complete" check after the model stream ends, and the mock sends a simple stream (no thought parts, no `thoughtSignature`). A real Gemini stream can differ, so this check is not closed until one real-key run passes. #318 was reported in Google-account mode (1.2.x Linux, 1.4.10 Windows). |
| 2 | Auth through the model proxy, real key outside the sandbox | **Pass** | `settings.json` `{"modelProvider":"gemini"}` + `GEMINI_API_KEY=<placeholder>` + `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:<proxy port>`. Every model call went to the base URL with header `x-goog-api-key: <placeholder>`. No browser, no keyring, no login. Headless use with an API key is billed per token on the Gemini API. It does not use a subscription. |
| 3 | Built-in tools off or allow-listed; permissions decided by Trina | **Pass with conditions** | No allow-list exists (`--settings` refuses `disableBuiltInTools`, `excludeTools`, `browserEnabled`). Deny rules work, also with `--dangerously-skip-permissions` and in sub-agents. See [Tool lock-down](#tool-lock-down). |
| 4 | Trina's MCP server for team tools | **Pass** | `mcp_config.json` → `mycel-bridge --turn-dir . --sock <tools.sock>`. The bridge read and deleted `.turn/token`. `enabledTools` (allow-list per server) and `tools.<name>.eager: true` give the model `mcp_team_<tool>` directly. `allow: ["mcp(team/*)"]` lets the calls run without a prompt. `timeoutSeconds: 1800` was accepted. |
| 5 | stream-json → Trina steps and answer | **Pass** | Parser sketch below, run on the captured streams: text, tool start/end, errors, usage map 1:1 to `EngineEvent`. |

## Tool lock-down

What the model gets (captured from the requests, not from the docs): 14 built-in function declarations, always:
`read_file`, `run_command`, `manage_task`, `send_message`, `schedule`, `invoke_subagent`, `define_subagent`,
`manage_subagents`, `write_file`, `edit_file`, `search_web`, `run_workflow`, `swarm`, `ask_question`. With MCP:
plus `mcp_team_<tool>` (eager) or `call_mcp_tool` / `list_resources` / `read_resource` (lazy). The `init` event lists
60 tool names (browser tools and more). The model does not get those.

Forced calls. "Deny set" = `command(*)`, `unsandboxed(*)`, `write_file(*)`, `read_file(*)`, `read_url(*)`,
`execute_url(*)`; allow `mcp(team/*)`.

| Forced tool | No rules, no flag | No rules + `--dangerously-skip-permissions` | Deny set (+ flag or not) | In the Trina sandbox, no rules + flag |
|---|---|---|---|---|
| `run_command` | soft-denied, turn ends with no answer | **ran** (`id` wrote a file) | denied, model gets the error | ran, but failed: no `bash` in the sandbox |
| `run_workflow` (Python) | soft-denied (`unsandboxed`) | **ran** (Python wrote a file) | denied only with `unsandboxed(*)` | stopped by Landlock, see the note below |
| `write_file` | – | – | denied, also inside the workspace | outside the chat folder: read-only file system |
| `read_file` | – | – | denied, also inside the workspace | outside the binds: "file does not exist" |
| `search_web` | – | – | **not stopped** by `read_url(*)` | ran: a second model call with `tools: [{googleSearch: {}}]` to the model proxy |
| `invoke_subagent` (`self`) | – | – | sub-agent ran; its `run_command` was denied by the same rules | – |
| `schedule` | – | – | **ran** (no permission action): a background task; `agy` waited for it before exit | – |

Findings:

- `run_workflow` does not need a system Python: `agy` has an embedded Python and unpacks it (68 MB) into
  `~/.cache/antigravity/python`, which is in the chat folder. We tested it with `/var/lib/mycel` on a Docker volume,
  as in compose:
  - Landlock `required-scoped` (the product setting): the unpack failed at the rename with EXDEV ("invalid
    cross-device link"). This is Landlock's REFER rule, not the file system: with Landlock off, on the same volume,
    the unpack worked.
  - Landlock off (helper refuses this with `--net-proxy`, so the run used the container network): the bundled
    Python ran the model's script (`wf-ran uid 1001`).
  - Interpreter already unpacked in the chat folder (copied in before the turn), Landlock on: `fork/exec
    .../bin/python3: permission denied`. The exec-allow list holds.

  So in Trina, two Landlock rules stop it. Without Landlock, the deny set is the only stop. Keep Landlock
  `required` for this engine on every host, and keep `unsandboxed(*)` in the deny set.
- `--dangerously-skip-permissions` without deny rules gives the model a shell and Python on the host. Never use it.
  With the deny set, the flag has no effect on the tools above.
- Without the flag (mode `request-review`), a tool that needs a permission is "soft-denied": the turn ends at once,
  with exit 0, an empty answer, and a notice on stderr only. With an explicit deny rule, the model gets an error and
  continues. So Trina must always pass the full deny set.
- `unsandboxed(*)` works in API key mode, although the docs say only business accounts use it.
- Some tools have no permission action (`schedule`, `swarm`, `send_message`, `manage_task`, `define_subagent`,
  `manage_subagents`, `ask_question`). No rule can stop them. Today they only act inside `agy`, but a later version
  can change that. The pinned version and a lock-down test must catch new tools.
- Web search goes through the model proxy as a `googleSearch` tool on a `generateContent` call. The proxy can remove
  or keep it, the same way it holds Codex web search (`proxy/codex-path.ts`).

## Gemini CLI comparison (docs only, not run)

| | Antigravity CLI (`agy`) | Gemini CLI (`gemini`) |
|---|---|---|
| Status | Google's current CLI. Gemini CLI "was replaced by Antigravity CLI on June 18th, 2026" for unpaid and Google One users. | Still released (v0.70.0, 2026-11-19), Apache-2.0, open source. Site says it is "not optimized for Gemini 4 Argon". |
| Runtime | One 257–274 MB Go binary (glibc). | Node.js package: Trina must ship and exec-allow a Node runtime. |
| Built-in tool allow-list | **None.** Deny rules only. | **Yes:** `tools.core` (allow-list), `tools.exclude`, policy engine, admin/system settings. |
| MCP allow-list | `enabledTools` per server. | `includeTools` / `excludeTools` per server. |
| API key + base URL | `GEMINI_API_KEY` + `GOOGLE_GEMINI_BASE_URL` (+ `modelProvider: "gemini"`). | `GEMINI_API_KEY` + `GOOGLE_GEMINI_BASE_URL` (HTTP allowed only for localhost). |
| Headless stream | `init` → `step_update` → `result`. | `init` → `message` / `tool_use` / `tool_result` / `error` → `result`. |
| Known hang | #318 (account mode). | None found. |

Gemini CLI has the better lock-down model (a real allow-list, like Claude and Codex). It is the fallback if a
security review refuses a deny-list-only engine. Its risk: Google moves consumers to `agy`, and new Gemini models may
come to `agy` first.

## Conditions

- **C1 Auth.** API key mode only. The launcher writes `settings.json` with `modelProvider: "gemini"` and sets
  `GEMINI_API_KEY` to the turn's proxy token and `GOOGLE_GEMINI_BASE_URL` to the proxy. The model proxy gets a Gemini
  path: swap `x-goog-api-key` for the real key of the AI connection, allow only the pinned models, pass SSE through,
  price per request. Never a Google login, never a personal Pro/Ultra subscription: the plans are for personal
  accounts under Google's terms. A team product that shares one subscription is a terms risk, not only a technical
  one.
- **C2 Tools.** Every turn passes the deny set (with `unsandboxed(*)`) and `allow: ["mcp(team/*)"]`. Never
  `--dangerously-skip-permissions`. MCP config: `enabledTools` = Trina's tool list, every tool `eager`. A lock-down test
  (like the Codex one) runs the pinned `agy` against a mock model and checks: the declared tool list is the known 14
  plus `mcp_team_*`, and each forced call is denied. Any `agy` update reruns it.
- **C3 Sandbox.** `agy` starts an internal server on `127.0.0.1:0`, so it needs `listen()`. Our seccomp filter
  refuses it ("listen: operation not permitted"). The launcher must pass `--allow-listen` for this engine only (today it
  is a launcher-wide flag). The listener is inside the turn's own network namespace, so other turns cannot reach it.
  Exec-allow: the engine folder, the bridge, and `ld-linux`. The engine folder must be read-only: then the
  auto-updater says "not fully accessible ... skipping update".
- **C4 Files the engine reads from its own folders.** In the run, the model saw `AGENTS.md` and `GEMINI.md` from the
  chat folder and `~/.gemini/GEMINI.md` from HOME (HOME is in the chat folder). `agy` also reads
  `<workspace>/.agents/mcp_config.json`, `.agents/skills`, plugins, and `~/.gemini/antigravity-cli/settings.json`. The
  launcher must bind these as empty read-only files and folders (the same idea as `codexLockFiles`), and write
  `settings.json` and `~/.gemini/config/mcp_config.json` per turn as read-only.
- **C5 Network.** `agy` tries `play.googleapis.com/log` (telemetry) and the update service. In the sandbox both fail
  (DNS), with no effect on the turn. Keep it that way: no CONNECT tunnel for this engine.
- **C6 Timeouts.** With the proxy down, `agy` retried 8 times over about 2 minutes, then gave `status: ERROR`. Use
  `--print-timeout` and Trina's own turn timeout. `schedule` keeps the process alive until its task ends.

## Parser sketch

Checked on the captured streams (plain answer, denied and allowed `run_command`, `search_web`, sub-agent, team
tool). Notes from the real lines: ACTIVE `text_delta` parts and the DONE part do not repeat text. A turn can have
more than one `agent_response` step (after a sub-agent or a schedule), so join them with a blank line, as
`codex-parse.ts` does. Tool output starts with "Created At / Completed At" lines. We saw no thinking text in the
stream, only `thinking_tokens`.

```ts
// `agy -p --output-format stream-json` events -> EngineEvent (same shape as codex-parse.ts)
const TEAM_PREFIX = 'mcp_team_'
export class AgyEventParser {
  sessionId: string | null = null
  text = ''
  toolNames = new Map<string, number>() // the lock-down test asserts only mcp_team_* (and search_web if allowed)
  private open = new Set<string>()
  push(line: string): EngineEvent[] {
    let ev: any
    try { ev = JSON.parse(line) } catch { return [] }
    const out: EngineEvent[] = []
    if (ev.event === 'init' && ev.conversation_id) {
      this.sessionId = ev.conversation_id
      out.push({ type: 'session', sessionId: ev.conversation_id })
    } else if (ev.event === 'step_update') {
      const s = ev.step_update ?? {}
      const id = `step-${s.step_index}`
      if (s.step_type === 'agent_response' && s.text_delta) {
        this.text += s.text_delta
        out.push({ type: 'text', delta: s.text_delta })
      } else if (s.step_type === 'tool' || s.step_type === 'subagent') {
        const name = String(s.tool_name ?? s.tool_info?.name ?? 'unknown')
        const trinaName = name.startsWith(TEAM_PREFIX) ? `mcp__team__${name.slice(TEAM_PREFIX.length)}` : `agy:${name}`
        if (!this.open.has(id)) {
          this.open.add(id)
          this.toolNames.set(name, (this.toolNames.get(name) ?? 0) + 1)
          const input = s.tool_info?.parameters ?? {}
          out.push({ type: 'tool_start', id, name: trinaName, summary: JSON.stringify(input).slice(0, 300), input })
        }
        if (s.state === 'DONE' || s.state === 'ERROR') {
          this.open.delete(id)
          const err = s.tool_info?.error
          out.push({ type: 'tool_end', id, ok: s.state === 'DONE' && !err,
            output: String(err?.message ?? s.tool_info?.output ?? '').slice(0, TOOL_OUTPUT_MAX) })
        }
      }
      // user_input, checkpoint, system_message, error_message: no event (the result says why)
    } else if (ev.event === 'result') {
      const r = ev.result ?? {}
      for (const id of this.open) out.push({ type: 'tool_end', id, ok: false })
      this.open.clear()
      const u = r.usage ?? {} // cumulative per process = per turn with one -p turn per process
      out.push({ type: 'usage', inputTokens: u.input_tokens ?? 0,
        outputTokens: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0), costUnknown: true })
      if (r.status !== 'SUCCESS') out.push({ type: 'error', code: classifyError(String(r.error ?? r.status)),
        message: String(r.error ?? r.status) })
    }
    return out
  }
}
```

Output of the check run (`bun agy-parse.ts <captured>.stdout`):

```text
a.stdout      | session text usage
s2.stdout     | session tool_start(agy:run_command) tool_end(true) text text usage
s3.stdout     | session tool_start(agy:run_command) tool_end(false) text text usage
sw.stdout     | session tool_start(agy:search_web) tool_end(true) text usage
sb.stdout     | session tool_start(agy:invoke_subagent) tool_end(true) text text usage
sbx-x5.stdout | session tool_start(mcp__team__file_read) tool_end(true) text usage
```

## Other entry points

- **ACP (`agy acp`)** also works with the API key provider. `session/new` takes the MCP server list from the client,
  `_meta.antigravity.systemPrompt.append` is offered, and a tool that needs approval comes to the client as
  `session/request_permission` (we answered "deny", nothing ran). This is a cleaner way for Trina to decide
  permissions, but it is a long-lived JSON-RPC session, not the one-process-per-turn model of Claude and Codex. Keep
  `-p` for the first build.
- **`--input-format stream-json`**: two prompts in one process both ended with `SUCCESS`.

## Risks

| Risk | Level | Mitigation |
|---|---|---|
| Deny-list only: a new `agy` version adds a tool with no permission action | High | Pin the version; lock-down test on every update (C2); sandbox stays the boundary |
| Someone runs the engine with `--dangerously-skip-permissions` or without the deny set | High | Builder always adds the set; test asserts it in the argv |
| Soft-deny ends the turn with an empty answer | Medium | Explicit deny rules (the model then gets an error and continues) |
| `listen()` must be allowed | Medium | Per-engine `--allow-listen`; per-turn network namespace |
| Context files in the chat folder change the model's instructions | Medium | Read-only empty binds (C4) |
| #318 hang (seen in account mode; not shown with a mock in API key mode; not known with a real model) | High until the real-key run | One real-key run before the build; `--print-timeout`; turn timeout |
| Embedded Python (68 MB) unpacks into every chat folder that calls `run_workflow` | Low | Landlock stops the unpack and the exec; disk use only if a later version unpacks in a different way |
| Closed source, 257–274 MB binary, Google can change behaviour | Medium | Pin, checksum, test per version |
| Web search through `googleSearch` grounding | Low | Model proxy keeps or removes the tool per team setting |
| Not tested: real Gemini API (thought signatures, real model choices), amd64, macOS (Seatbelt `engine.sb`) | Unknown | One short real-key run (with an approved key, through the proxy) and a macOS run before the build starts |

## Build estimate

About **15–20 developer days (3–4 weeks)** for Linux and macOS, plus one security review round:

| Part | Days |
|---|---|
| Engine builder (`server/src/engine/agy.ts`): args, per-turn HOME, `settings.json` with the deny set, `mcp_config.json` | 2 |
| Parser + tests on captured streams | 1 |
| Model proxy Gemini path: key swap, SSE pass-through, model allow-list, `googleSearch` control, pricing | 3–4 |
| Launcher Linux: per-engine `--allow-listen`, lock binds (C4), engine folder; macOS `engine.sb` profile and test | 3–4 |
| Installer and `versions.json` pin, both arches, checksum | 1–2 |
| AI connection type "Gemini API key", engine picker, admin UI | 2 |
| Lock-down test (mock model, forced tools), QA, security review fixes | 3–4 |

If the goal is only "Gemini models in Trina": configure the existing `api` engine with Google's OpenAI-compatible
endpoint. That is a QA task of about 1–2 days, not a new engine.

## Google subscription sign-in (Google AI Pro / Ultra)

Owner request (2026-11-23): teams sign in with a Google subscription, like Trina's Claude and ChatGPT subscription
engines, not with an API key. We checked this path with no real account: the `agy` binary (1.5.15), its log, one run
with no login, one run with a made-up token, the docs, the terms, and the Google forum.

**Short answer: do not build this.** The Antigravity terms name this use as a breach, Google has suspended paying
subscribers for it, and the technical path is not proven. The team path that Google allows is an API key (AI Studio)
or a Google Cloud account (Gemini Enterprise or pay-as-you-go).

### 1. How `agy` keeps the account login

| Item | What we found | Evidence |
|---|---|---|
| Sign-in | Google OAuth 2.0 with PKCE, `access_type=offline` (so a refresh token), client `1071006060591-tmhss…apps.googleusercontent.com`. Headless shows a URL; the person pastes back a code from `antigravity.google/oauth-callback`. | stderr of a run with no login |
| Scopes | `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`, `aicode`, `openid` | the same URL |
| Where | OS keyring (Keychain, Secret Service, Credential Manager) by default. In a container: file `~/.gemini/antigravity-cli/antigravity-oauth-token` ("Using file-based token storage because container environment detected"). Also `~/.config/antigravity/credential-user-scope` and `plugin-secrets.json`. | log + `strace openat` |
| Model API | Cloud Code API (`cloudcode-pa.googleapis.com`: `loadCodeAssist`, `onboardUser`, `streamGenerateContent`), not the Gemini API. Refresh at `oauth2.googleapis.com/token`. Other calls with the same token: user info, people info, experiments, `play.googleapis.com/log`. | strings in the binary, log |
| Endpoint override | `CLOUD_CODE_URL` works ("Overriding CloudCodeServerURL via CLOUD_CODE_URL"). | log |
| No login, no TTY | The run does **not** stop at once (the docs say it does): it waits for the sign-in until the outer timeout (60 s here), then `status: ERROR`, "authentication failed or timed out". | run t0 |

**Can a headless run in the sandbox use it?** Yes in principle: HOME is the chat folder, the container check picks the
file store, and no keyring or D-Bus is needed. Not tested with a real login.

**Can the model proxy keep the real token and give the engine a placeholder (like D9 for Codex)?** Possible, not
proven:

- For: `CLOUD_CODE_URL` sends the model calls to an address we choose, so the proxy can put the real `Authorization`
  on them, as it does for Codex (`codexManagedArgs`, `credentials/codex-home.ts`). The refresh can stay in the server
  (D10), with a placeholder refresh token like `teamax-no-refresh`.
- Against: we wrote a token file with a placeholder access token and a far expiry. `agy` read it and refused it
  ("keyringAuth: failed to get oauth params: unknown auth method"). The file format has more fields than an OAuth
  token, and we can only learn them from one real sign-in. The proxy must also answer the Cloud Code setup calls
  (`loadCodeAssist`, tier, project), and the user-info, experiments and refresh calls go to fixed Google hosts, which
  the sandbox blocks. We do not know if a turn still works when they fail.
- So the engine would depend on an undocumented file format and an internal API (Cloud Code `v1internal`). Each
  `agy` update can break it. This is weaker than Claude (`setup-token`, documented) and Codex (`auth.json`, open
  source).

### 2. Terms

- Antigravity Terms of Service (primary source, [antigravity.google/terms](https://antigravity.google/terms), read
  2026-11-23): "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with
  Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your
  Antigravity and/or Gemini CLI accounts." The same section forbids "using the Service in connection with products
  not provided by us".
- Official FAQ ([docs/faq](https://antigravity.google/docs/faq)): "Antigravity CLI headless mode (`agy -p`) is
  intended for direct scripting and CI workflows. Wrapping `agy` inside third-party coding agents or applications, or
  automating account rotation, is not supported under consumer plans." And: "To use a third-party coding agent with
  Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key."
- Plans ([docs/plans](https://antigravity.google/docs/plans)): Pro and Ultra are for personal Google Accounts.
  Workspace accounts do not include Antigravity plans.
- Google AI Developers Forum: [#190447](https://discuss.ai.google.dev/t/can-a-third-party-desktop-app-run-the-official-antigravity-cli-with-the-user-s-own-google-ai-pro-ultra-subscription/190447)
  (2026-10-19) asks our exact case (an app runs the unmodified `agy` with the user's own Pro/Ultra login, never
  touches tokens). Reply: not permitted, and it "can trigger automated account bans". In
  [#191689](https://discuss.ai.google.dev/t/paying-google-ai-pro-subscriber-allow-subscription-use-with-third-party-agents-like-openclaw/191689)
  a forum moderator says an earlier "yes" (5–7 Oct) was replaced when the FAQ was updated in mid-October 2026. These
  replies come from forum regulars, not a Google legal statement, but they match the terms and the FAQ.
- Enforcement: reports of paying Pro and Ultra subscribers suspended for third-party tools, with no refund
  ([WinBuzzer, 2026-02-23](https://winbuzzer.com/2026/02/23/google-bans-ai-subscribers-openclaw-no-refunds-xcxwbn/),
  [Enterprise DNA, 2026-09-03](https://enterprisedna.co/resources/ai-pulse/ai-pulse-2026-09-03-google-suspends-paying-antigravity-subscribers-for-using-thi/)).
  Secondary sources.
- Trina makes it worse: a server runs `agy`, for many people of a team, with the proxy changing the traffic. This is
  further from "direct scripting" than the forum cases. The risk falls on the customer's own Google account (Gmail,
  Drive, and so on), not only on the Antigravity plan.

This is the same type of decision as D22 (Anthropic does not allow third-party operators to broker consumer Claude
credentials), but here the provider's own terms name the use as a breach.

### 3. Quotas and limits (subscription)

- Google publishes no numbers. Each model group (Gemini Flash, Gemini Pro, third-party models) has a five-hour limit
  and a weekly limit. Ultra gets the highest, Pro high, free "a meaningful quota, refreshed weekly". Limits "correlate
  with the amount of work done by the agent" and can change ([plans](https://antigravity.google/docs/plans),
  [/usage](https://antigravity.google/docs/cli/commands/usage)).
- Above the quota: Pro/Ultra can spend purchased AI credits (setting `useG1Credits` / "AI Credit Overages": Never or
  Always), at Gemini Enterprise prices.
- Headless use draws on the same quota as the person's own use of the app and the IDE. A team that shares one login
  shares one five-hour budget.
- On the limit (from the CLI changelog in the binary): when the quota is used up and credits cannot cover it, the CLI
  now stops at once with an error (before: about 2.5 minutes of retries). It waits for a server retry delay only up to
  30 seconds, and stops at once for a daily or longer quota. Errors such as `RESOURCE_EXHAUSTED` /
  `MODEL_CAPACITY_EXHAUSTED` end the turn with `status: ERROR`. Trina would map this to `rate_limited` (D14/D15). The
  remaining quota can be read with `agy -p "/usage"` (JSON with `--json`).

### 4. A real-account test: what it needs, and the risks

Only if the owner accepts the terms risk in writing. Needs from Dion:

1. A **throwaway personal Google account** with Google AI Pro (not his main account, not a Workspace account, no
   other data on it). A ban must cost nothing.
2. One sign-in on a test box (a throwaway OrbStack container on this Mac or a Lightsail test VM, never a team server
   or the control plane): `agy` prints a URL, he opens it, signs in, pastes back the code. About 5 minutes.
3. Approval for 2–3 short prompts (quota only, no money).

What the test answers: the file format (field names only, values never printed or copied off the box), whether
`CLOUD_CODE_URL` + a placeholder token + a refresh held by the server works, whether a turn survives with the side
calls blocked, and whether #318 (hang) shows. After the test: `/logout`, revoke the app at
myaccount.google.com/permissions, delete the box.

Risks of the test: the account can be suspended (the terms allow it); the token on the box is a full
`cloud-platform`-scope Google credential (keep the box offline except Google, delete it after); a "pass" does not make
the product use allowed.

## Recommendation

1. Now: offer Gemini through the existing `api` engine. Measure if teams use it.
   Do not offer a Google AI Pro/Ultra sign-in. For teams that want Google billing, the allowed path is an AI Studio
   API key or a Google Cloud account (Gemini Enterprise or pay-as-you-go); a later spike can check `agy`'s
   enterprise sign-in (ADC, `AGY_LLM_GATEWAY_*`) for that.
2. Before any build: one real-key run (approved key, through a local proxy, cost of cents) to close check 1, and
   one macOS run under `engine.sb`.
3. Build the `agy` engine only if teams need agy's own agent behaviour. Then build it under C1–C6 and start with
   `-p --output-format stream-json`.
4. Keep Gemini CLI as the fallback if the security review refuses a deny-list-only engine.
