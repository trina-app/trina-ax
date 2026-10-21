# 결정 기록 (Stage 1 "권한 바닥 공사")

설계서 v3(팀 AX 플랫폼 구현 설계서)를 기준으로, 설계서에 없거나 애매한 부분을 구현하면서 정한 것들이다.
형식: **결정** — 이유. (날짜는 모두 2026-10-21)

## 저장소·구성

- **이름 `mycel`은 `shared/src/product.ts`의 `PRODUCT` 한 곳에만 둔다.** 소켓·임시 파일 접두사·폴더 이름은 모두 여기서 나온다. 이름이 바뀌면 이 파일과 패키지 이름만 고친다.
- **AGPL-3.0, `ee/`는 비워 둔다.** 소유자 결정.
- **Bun 워크스페이스는 `shared`, `server`, `tests` 셋만.** `web/ desktop/ relay/ menubar/`는 README만 두었다(Stage 1 범위 밖). 버전은 `versions.json`에 고정했다.
- **ORM(Drizzle)은 아직 쓰지 않는다.** 번호 붙은 SQL 마이그레이션(`server/migrations/001_init.sql`) + `bun:sqlite`. 1번 탭의 테이블을 전부 만들어 두었다. Postgres로 옮길 일이 생기면 그때 Drizzle 스키마를 이 SQL에서 만든다.
- **Python은 어디에도 없다.** 테스트 픽스처도 TypeScript(`tests/lib/fixtures.ts`): docx/pptx는 pandoc, xlsx는 SheetJS, PDF는 직접 쓴 작은 PDF 생성기.

## 데이터

- **`folders.path`는 끝 슬래시 없이, 팀 루트는 `''`.** 디스크의 실제 이름 그대로 저장한다(설계서 예시의 `finance/` 대신 `finance`).
- **`users.id`는 바뀌지 않는 짧은 슬러그이고, 개인 폴더 이름(`users/<id>/`)과 같다.** 표시 이름(`name`)은 바뀔 수 있다.
- **세션 파일 보관본은 DB가 아니라 `<데이터>/sessions/<chatId>/<세션id>.jsonl`(600).** `turns.engine_session_blob`에는 그 경로만 적는다. 세션 파일은 8턴에 110KB 정도라 DB를 키우지 않으려고.

## 권한 함수 (2번 탭)

- **경로 단계 맞추기: 정확히 같은 이름 → 같은 이름의 다른 유니코드 정규화(NFC/NFD) → (대소문자 무시 파일 시스템에서만) 대소문자만 다른 이름.** 후보가 둘 이상이면 "애매한 이름"으로 거부. 권한은 이렇게 찾은 실제 이름으로 비교하고 절대 접어서 비교하지 않는다. 리눅스에서 `Marketing/`은 `marketing/`과 다른 폴더로 취급된다(옛 버그 재현 케이스가 퍼저에 들어 있음).
- **새로 만드는 이름의 충돌 검사는 NFKC + 소문자 키로 한다.** 대소문자·NFC/NFD·전각만 다른 형제가 있으면 쓰기·폴더 만들기를 거부한다(`ｔｏｄｏ.md` 같은 전각 흉내도 막음).
- **이름 규칙은 모든 OS에서, 읽기에도 적용한다.** 윈도우 예약 이름(CON/NUL/COM1…), `:`(대체 데이터 스트림), 8.3 짧은 이름(`ABC~1`), 끝 점·공백, 제어·방향·폭 없는 문자, 흉내 슬래시(`／ ∕ ⁄`), `< > " | ? * \`를 거부한다. 규칙에 걸리는 기존 파일은 도구에서 보이지 않는다(실패하면 닫히는 쪽). 팀 폴더를 다른 OS 서버로 옮겨도 안전하게.
- **"권한 없음"과 "없는 파일"은 같은 문구를 쓴다**(`not found or no access`). 숨긴 폴더의 존재가 드러나지 않게.
- **경로 깊이 64, 경로 1024자, 이름 255바이트 상한.**
- **owner/admin 규칙은 1번 탭 그대로**: owner는 전부 쓰기, admin은 다른 사람 `users/<id>/`를 뺀 전부 쓰기. `.system/`은 owner도 도구로 접근 불가.

## 파일 도구

- **입력 형식은 Claude Code 내장 도구와 같다**(`file_path`, `old_string`, `output_mode`, `-i`, `-A/-B/-C`, `head_limit`…). grep 기본 `output_mode`도 Claude Code처럼 `files_with_matches`, 결과 한도 기본 200(최대 5000). glob은 Claude Code처럼 수정 시각 순, 100개에서 자른다.
- **기존 파일을 `write`로 덮어쓸 때도 그 턴에 먼저 `read`해야 한다**(Claude Code와 같음). 새 파일은 바로 만들 수 있고, 없는 상위 폴더도 이름 규칙·충돌 검사를 거쳐 만든다.
- **`edit` 충돌 사본**: 읽은 뒤 누가 바꿨으면, `old_string`이 지금 파일에 그대로 적용될 때만 "지금 파일 + 이 수정"을 충돌 사본으로 저장한다. 적용이 안 되면 사본 없이 "다시 읽어라" 오류를 주고 `file_events`에 `conflict`를 남긴다(읽을 때의 내용 전체를 턴마다 들고 있지 않으려고).
- **충돌 사본 이름은 설계서의 한국어 형식 그대로**: `이름 (충돌 사본 - 사람 날짜 HH.mm).확장자`. 이름 규칙상 `:`를 쓸 수 없어 시각은 `HH.mm`.
- **충돌 알림은 Stage 1에서는 서버 안 이벤트(`FileService.events`)와 `file_events`까지.** 화면·사람 알림은 Stage 2(WebSocket).
- **턴당 쓰기 한도 50MB·200파일**(디스크 채우기 방지, 7번 탭).
- **오피스 파일은 `write`로 쓸 수 없다**(`make_file`은 나중). 사람의 파일 화면 저장(`humanSave`)은 같은 규칙(해시 기준 충돌)을 쓴다.
- **삭제 도구는 AI에게 주지 않았다.** 서버 함수 `deleteFile`/`restoreTrash`만 있고(휴지통 30일, 되돌리기는 원래 경로에 쓰기 권한이 있을 때만) 테스트로 확인했다. AI용 삭제를 줄지는 Stage 2에서 정한다.

## grep / glob

- **설계대로 ripgrep에 허용 루트만 넘기고, 허용 루트 안의 숨긴 하위 폴더는 `--glob '!경로'` + `'!경로/**'`로 뺀다.** 슬래시가 든 glob이 rg의 작업 폴더(팀 루트) 기준으로 고정되고 다른 곳의 같은 이름을 잘못 빼지 않는 것을 직접 시험했다. 이름 속 glob 특수문자는 이스케이프한다.
- **그래도 모든 결과 경로를 다시 확인한다**(권한·이름 규칙·일반 파일·nlink==1). rg에 파일을 직접 위치 인자로 주면 glob이 무시되는 것을 시험 중 발견해서, 루트는 폴더로만 넘기고 결과 재확인을 최종 방어선으로 둔다.
- **오피스 파일은 원본 바이트로 검색하지 않는다**(`--glob '!*.{docx,…}'`). 추출한 글자를 `<데이터>/textcache/<경로>.txt`에 두고 같은 rg로 찾은 뒤 원래 경로로 바꾼다. Stage 1은 검색할 때 오래된 캐시를 최대 40개까지 바로 갱신하고 나머지는 뒤에서 돈다("아직 색인 중" 안내). 업로드·변경 때 미리 추출하는 것은 파일 API가 생기는 Stage 2에서.
- **rg 오류 문구의 "--pcre2를 켜라" 안내는 지운다.** 모델이 그 옵션을 찾게 만들지 않으려고. 대신 "look-around·역참조는 지원하지 않음"을 붙인다.

## 글자 추출

- **docx/pptx/odt = pandoc(`--sandbox`, 입력은 stdin), xlsx/xls/ods = SheetJS 0.20.3, PDF = `pdftotext`(poppler).** pdf.js 대신 pdftotext를 고른 이유: 맥(Homebrew)·데비안에 이미 있고, 표 레이아웃 보존이 낫고, 빠르다. 서명·번들은 Stage 3에서 pandoc과 같이 처리한다. SheetJS는 npm 레지스트리 판(0.18.5)이 오래돼 공식 CDN tarball로 고정했다.
- **변환기는 경로를 열지 않는다.** 서버가 `O_NOFOLLOW`로 열고 `nlink==1`을 확인한 fd에서 읽은 바이트를 stdin으로 넘긴다.

## 도구 관문·턴 토큰·실행기 (native/, Go)

- **Bun에는 상대 프로세스(SO_PEERCRED/LOCAL_PEERPID)를 읽는 API가 없어서 Go 관문(`mycel-gate`)을 둔다.** 엔진 쪽 공개 소켓 `tools.sock`을 관문이 받고, 상대 pid·uid·gid·프로세스 그룹·세션을 읽어 서버의 비공개 소켓(700 폴더)으로 넘기며 첫 줄에 붙인다. 관문은 서버가 띄우고 stdin으로 비밀값을 받는다. 그래서 비공개 소켓에 직접 붙어 상대 정보를 위조해도 거부된다(테스트 있음).
- **턴 확인은 프로세스 그룹이 아니라 세션 id로 한다.** 실행기가 엔진을 `setsid`로 띄우므로 세션 id = 엔진 pid. Codex는 MCP 서버를 자기 프로세스 그룹으로 옮기지만 세션은 그대로라는 것을 실제 실행에서 발견했다. 세션은 `setsid`로만 바꿀 수 있고 그러면 새 id가 되므로, 다른 턴이나 탈출한 프로세스는 남의 턴 토큰을 써도 거부된다(리눅스 Docker 테스트에서 확인).
- **실행기 프로토콜은 Unix 소켓 위 JSON 줄.** 설계서는 stdin/stdout/토큰 파이프를 SCM_RIGHTS fd로 넘긴다고 했지만 Bun이 fd 전달을 못 한다. 대신 엔진 stdout/stderr를 이벤트로 흘려 보내고, 토큰·지침·세션 보관본은 요청 메시지로 보내 실행기가 600 파일로 쓴다. 인자·환경 변수에 비밀값이 안 들어간다는 성질은 같다.
- **실행기가 채팅 폴더·`.tmp`·`.turn`을 만든다. 서버는 엔진 계정 영역에 아무것도 쓰지 않는다.** 실행기는 허용된 엔진 실행 파일만(`--allow-cmd`), 에이전트 루트 바로 아래 채팅 폴더에서만 띄운다. 요청은 서버 uid만 보낼 수 있다(사람 계정 mallory도 거부 확인).
- **macOS 스파이크 반영**: 엔진 환경에 `TMPDIR`와 `CLAUDE_CODE_TMPDIR`를 둘 다 채팅 폴더 `.tmp`로 둔다(TMPDIR만으로는 `/tmp/claude-<uid>`가 생김). 모델 프록시의 TCP→pid 조회는 서버 uid에서 EPERM이라 실행기 요청(`tcp-peer`)으로 만들었다.
- **고아 프로세스 정리(`kill(-1)` + 턴 사이 정리)는 `--dedicated-account`일 때만 켠다.** Stage 1에서는 실행기가 소유자 본인 계정으로 돌기 때문에 `kill(-1)`이 소유자의 모든 프로세스를 죽인다. 그래서 root·서버 uid·사람 uid(맥 450–499 밖, 리눅스 1000 이상)에서는 이 옵션을 거부한다. 리눅스 Docker 테스트에서 시스템 계정으로 켜서, `setsid`로 탈출한 프로세스가 턴 뒤에 정리되는 것을 확인했다.
- **턴이 끝나면 실행기가 엔진 프로세스 그룹 전체를 죽이고 `.turn/`을 지운다.** 토큰 파일은 다리가 시작하자마자 지우고, 지침 파일은 엔진의 첫 출력 뒤 실행기가 지운다(테스트 있음).

## 엔진: Claude Code

- **인증은 지금 로컬 구독 로그인("local-login")** (소유자 결정). 이 모드에서는 `CLAUDE_CONFIG_DIR`를 쓰지 않는다: 바꾸면 맥 키체인의 로그인을 못 찾아 "Not logged in"이 난다(직접 시험, 비용 0). 그래서 HOME은 실제 홈, 세션 파일은 `~/.claude/projects/<채팅폴더 슬러그>/`에 생기고, 실행기가 턴 뒤에 회수해 서버에 넘기고 그 폴더를 지운다(`--session-root`로 그 경로만 허용).
- **회사 키/구독 토큰 프록시 모드("proxy")는 코드와 가짜 상위 서버 테스트까지.** 기본값이 아니다. 엔진은 `CLAUDE_CONFIG_DIR=<채팅>/.claude`, `ANTHROPIC_BASE_URL=프록시`, 턴 토큰은 상위가 API 키면 `ANTHROPIC_API_KEY`, 구독 OAuth면 `CLAUDE_CODE_OAUTH_TOKEN`으로 받는다(스파이크 3). 프록시는 진짜 키를 `x-api-key`로, 또는 진짜 장기 OAuth 토큰을 `Authorization: Bearer`로 바꿔 넣고 `anthropic-beta: oauth-2025-04-20`을 더한다. 빈 키(apiKeyHelper 실패 시 빈 Bearer)·모르는 키·폐기된 키는 401.
- **잠금 구성은 설계서 그대로 + 세 가지**: ① 소유자 결정으로 내장 `WebSearch`만 허용(`--tools WebSearch`, 허용 목록 = 우리 도구 6개 + WebSearch). ② 잠금 회귀 시험에서 Claude Code 2.1.304가 `--setting-sources ""`에서도 내장 플러그인 2개(`cc-plugin-agents-md`, `cc-plugin-plugin-authoring`)를 싣는 것을 발견 → `--settings`의 `enabledPlugins`로 끈다. agents-md는 AGENTS.md를 맥락에 넣는 경로라 막아야 한다. ③ `--include-hook-events`를 붙여 훅이 돌면 스트림에 보이게 한다.
- **지침은 `--append-system-prompt-file`**(파일, 인자 아님). Claude Code 기본 지침(도구 사용법)은 유지한다. 서버가 `skills/`의 팀 규칙을 넣고, 실제로 e2e 답변이 팀 규칙대로 한국어로 나왔다.
- **거절(`refused`) 재시도는 다른 모델로 1회**(지정 없으면 sonnet↔opus). 정상 요청이 실제로 거절되는 경우를 만들 수 없어 스트림 파서 단위 테스트로만 확인했다.
- **이어가기 실패 처리**: 보관본이 없으면 새 세션 + DB 대화 기록을 지침의 `<previous_conversation>`에 넣는다(제품의 `chat/prompt.ts`와 같음; e2e T5로 확인. 처음 stage 1에서는 메시지 앞에 붙였다). 보관본이 있는데 엔진이 "No conversation found"를 내면 같은 방식으로 1회 재시작한다.
- **사용량**: 프록시 모드에서는 프록시가 센 값이 기준이고, 엔진이 보고한 값은 프록시 기록이 없을 때만 적는다. 가격표는 대략값(코드에 표시).

- **git 맥락 차단(`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`, 설정 `includeGitInstructions: false`)** — 잠금 회귀를 다시 돌리다 세션 기록에서 찾았다: 채팅 폴더가 git 저장소 안에 있으면 Claude Code가 그 저장소의 `git status`·브랜치·최근 커밋 메시지를 모델 맥락에 넣는다(시험의 `tests/.work`는 저장소 안). 잠금 회귀가 이제 서버가 보관한 세션 기록에 git 블록이 없는지 확인한다.
- **로컬 로그인(DEV)에서는 로그인한 계정의 이메일이 모델 맥락에 들어간다** — Claude Code가 `~/.claude.json`의 계정 정보로 "The user's email address is …"를 붙이고, 이를 끄는 스위치가 없다(2.1.305 확인; HOME을 바꾸면 키체인 로그인을 못 찾는다). 그래서 DEV 모드에서는 팀원의 AI가 owner의 Claude 계정 이메일을 알 수 있다. 역할 계정 설치(엔진 고유 토큰·HOME)에는 그 계정 정보가 없다. 잠금 회귀는 이 상태를 `ownerEmailInContext`로 보고만 한다(실패로 치지 않음).

## 엔진: Codex CLI (소유자 결정: API가 아니라 `codex exec`)

설계서 3번 탭은 "Codex CLI는 셸을 꺼도 실행 도구가 남는다 → API 어댑터"였다. 소유자 결정으로 CLI를 쓰되 최대한 잠갔다. codex-cli 0.163.0에서 확인한 것:

- **기본 `CODEX_HOME`/`HOME`을 쓰면 전역 AGENTS.md와 설치된 스킬 100여 개가 맥락에 들어간다** → 엔진 전용 빈 `CODEX_HOME`과 빈 `HOME`.
- **`--disable <기능>`은 exec에서 도구를 없애지 못했다. `-c features.<기능>=false`는 됐다.**
- **치명: 기능을 다 꺼도 서버가 내려주는 모델 카탈로그가 `tool_mode: code_mode_only`, `shell_type: unified_exec`를 지정해서 exec 도구가 남았고, 실제로 `id`를 실행하고 팀 폴더 밖 표식 파일을 읽었다**(read-only 샌드박스는 쓰기만 막는다). → 로컬 카탈로그(`model_catalog_json`)를 만들어 `shell_type: "disabled"`, `tool_mode: "direct"`, `node_repl_disabled`, 실험 도구 없음, `apply_patch` 없음으로 바꾼다. 그 뒤 남는 도구: 우리 `mcp__team__*` 6개, `web.run`(OpenAI 쪽 웹 검색, 로컬에 닿지 않음 — Claude의 WebSearch와 같은 취급), MCP 리소스 조회 3개(우리 서버는 리소스가 없음), `request_user_input`(Plan 모드 전용).
- **카탈로그에 없는 모델을 고르면 codex가 기본 메타데이터로 돌아가므로 모델은 항상 카탈로그에서 골라 `-c model=`로 고정한다.**
- **MCP 도구는 codex가 "승인 필요"로 막는다(approval never와 충돌)** → `mcp_servers.team.default_tools_approval_mode="approve"`, `enabled_tools`는 우리 6개. 권한은 우리 서버가 매번 판단한다.
- **대화 이어가기는 `--ephemeral` + DB 대화 기록**(codex 세션 파일을 남기지 않음). 지침은 codex에 파일 옵션이 없어 stdin으로 메시지 앞에 넣는다(인자·환경 변수에는 넣지 않음).
- **인증**: 제품 코드의 기본은 `agent-own`(엔진 계정이 `codex login --device-auth`로 따로 로그인, Stage 3). Stage 1 테스트만 `dev-owner-symlink`: 엔진 CODEX_HOME의 auth.json을 소유자 로그인으로 심볼릭 링크하고, codex가 갱신하면서 링크를 파일로 바꾸면 턴 뒤 원래 자리로 되돌린다(새 refresh 토큰을 잃지 않게). 소유자 auth.json을 복사하지 않는다.
- **위험**: 이 잠금은 카탈로그 형식과 기능 이름에 기대므로, codex 버전을 올릴 때마다 `tests/engine/lockdown-codex.ts`를 반드시 돌린다(버전 0.163.0 고정).

## 도구 목록

- **`web_search` 스키마는 넣지 않았다**(Brave 없음, 엔진 내장 검색 사용). `web_fetch`는 스키마만(Stage 1 범위 밖). 밖으로 보내는 도구는 없다.

## 테스트

- **리눅스 Docker 테스트의 계정은 `useradd --system`**(axserver, axagent, 사람 계정 mallory). Debian pandoc 2.17은 pptx를 못 읽어서 이미지에는 맥과 같은 pandoc 3.9.0.2 릴리스를 깐다.
- **실제 엔진 호출 수(이번 단계)**: Claude 15회 이하, Codex 15회 이하(탐색 포함).
- **설계 확인 사항 중 Stage 3로 넘긴 것(맥 스파이크)**: 역할 계정 uid 450–499(`sysadminctl -roleAccount`), 홈은 `/var/empty`, `_axagent`를 `cron.deny`·`at.deny`에, 실행기는 launchd로만 시작(사용자 세션에서 sudo로 띄우지 않음).

# 결정 기록 (Stage 2 기반: 계약·서버 골격, 2026-10-21)

- **표시 이름 "Team AX", 코드 id `mycel` 유지.** 운영 폴더는 표시 이름이 아니라 id로(`/Library/Application Support/mycel`). 표시 이름을 바꿔도 데이터가 옮겨지지 않게.
- **id는 UUIDv7, `users.id`만 예외(슬러그).** `users.id`는 개인 폴더 이름(`users/<id>/`)이라 사람이 팀 폴더에서 보게 되므로 읽을 수 있는 슬러그로 둔다. 턴·메시지·파일 버전·휴지통 id도 UUIDv7로 바꿨다(UUID는 실행기의 턴 id 규칙 `[A-Za-z0-9_-]`에 맞음).
- **계약은 엔드포인트 객체 하나씩**(`shared/src/api`): 메서드·경로·인증 수준·주인 컴포넌트·query/body/response 스키마. 서버 `RouteKit`이 같은 객체로 검증하고, 클라이언트 `ApiClient`가 같은 객체로 부른다. OpenAPI 생성기는 쓰지 않았다(zod 4 스키마가 곧 문서).
- **설계서 4번 탭 표에 없는 엔드포인트를 더했다**(화면에 필요해서): `GET/POST /api/setup`(첫 설정), `PATCH /api/me`·`/api/me/sessions`, `GET /api/invites/:token`, `GET /api/chats/:id`, 다시 생성·수정·가지 선택, 프로젝트 하나 조회, `PUT /api/files/content`(파일 화면 저장), `POST /api/files/mkdir`, 이전 버전 다운로드, 휴지통 목록·되돌리기, 첨부 썸네일, 조각 업로드 취소, `GET /api/artifacts/:id`, 메모리 하나 지우기, 관리자 초대·폴더·엔진 계정·예산 개별 조작, 백업 목록, 내보내기, 연결 방식, 브라우저 롱폴링(`/api/browser/*`). 설계서의 `/api/admin/folder-rules`는 `/api/admin/folders`(+`/:id/rules`)와 `/api/admin/folder-rules/preview`로 나눴다.
- **대화는 트리**: 수정·다시 생성은 같은 부모의 형제 메시지를 만들고 `chats.active_leaf_id`가 보이는 길을 정한다. 메시지마다 `branch {index, count, siblingIds}`. 팀 폴더 파일 변경은 되돌리지 않는다(화면에 안내).
- **보내기는 멱등**: `clientMessageId`(클라이언트가 만든 id). 재연결 뒤 같은 요청을 다시 보내도 메시지가 두 번 생기지 않는다(`messages_client_id` 유일 인덱스).
- **CSRF는 사용자 정의 헤더 `x-mycel-csrf` + Origin/Sec-Fetch-Site 검사.** 토큰 방식 대신: 다른 사이트는 사용자 정의 헤더를 붙일 수 없고(사전 요청을 서버가 허락하지 않음), 중계·사무실 직접 연결 모두 같은 규칙. 로그인·초대 수락·첫 설정 같은 공개 양식에도 적용(로그인 CSRF 방지). Bearer 요청은 예외.
- **개발 서버(http)는 `__Host-` 쿠키를 쓸 수 없다**(Secure 필요) → 개발용 쿠키 이름 `mycel-dev-sid`를 상수로 둠. 운영은 항상 `__Host-sid`.
- **WebSocket 이어받기에 epoch**: 서버가 시작할 때마다 새 epoch. 스파이크에서 seq만으로는 서버 재시작 뒤 seq가 1부터 다시 시작해 위험했다 → epoch가 다르면 `reset`, 버퍼에서 밀려났으면 `resync`. 창마다 `windowId`(브라우저 도구가 턴을 보낸 창으로 가게).
- **실제 IP는 `app.fetch`를 부른 쪽만 정한다**(Bun.serve는 소켓 상대 주소, 중계 클라이언트는 OPEN 프레임 메타데이터). 클라이언트가 보낸 `X-Forwarded-For`·`CF-Connecting-IP`는 어디서도 읽지 않는다(시험 있음).
- **마이그레이션 번호를 컴포넌트별 범위로 나눴다**(001–099 기반, 100 A, 200 B, 300 C, 600 F, 700 G). 파일 이름에 컴포넌트 문자를 넣는 방식(`0A1_…`) 대신 정수 버전을 지켜 `schema_migrations.version` 정렬이 그대로 되게. 전방 호환 규칙과 `min_compatible_reader`는 스파이크 B 결과 그대로.
- **개발 모드에서는 모든 JSON 응답을 계약으로 검사**(어긋나면 500 + 로그). 운영에서는 끈다(큰 목록 비용).
- **엔진 코어(도구 관문·실행기)는 처음 쓸 때 시작**(`ctx.core()`). 웹·파일 화면만 개발할 때 Go 빌드가 없어도 서버가 뜬다.
- **Bun.serve `maxRequestBodySize` = 51MB**(작은 업로드 50MB + 여유). 큰 파일은 조각 업로드(8MB)만.
- **불안정하던 실행기 시험의 원인**: 실행기가 `.turn` 폴더를 `defer`로 지워서 "exit" 이벤트를 보낸 뒤에 지워졌다. exit 전에 지우도록 고쳤다(시험도 고정 대기 대신 이벤트 기준).

## A server-auth-admin (2026-10-21)

- **다른 사람의 `users/<id>/`는 owner에게도 none이다(2번 탭 해석 규칙 2·3).** Stage 1의 권한 함수는 owner에게 모든 폴더 쓰기를 주고, `users/` 아래 규칙도 읽었다. 설계서 v3(2번 탭)대로 바꿨다: 본인 폴더는 항상 쓰기, 남의 개인 폴더는 역할과 규칙에 상관없이 none, `users/` 아래 규칙은 해석할 때도 무시한다(폴더 이동·백업 복원으로 들어온 규칙 포함). owner·admin은 그 밖의 모든 폴더 쓰기. `users/` 폴더 자체는 모두에게 읽기(목록)만: 거기에 파일을 두거나, 아직 없는 사람의 개인 폴더를 미리 만들거나, `users/` 전체를 옮기거나 지우는 일은 owner도 못 한다. 시험 기대표(`tests/lib/fixtures.ts`)의 owner 줄도 고쳤다.
- **세션**: 무작위 32바이트 토큰, DB에는 SHA-256만, 30일 고정(사용해도 늘지 않음). 쿠키 이름은 요청 주소로 정한다: https면 `__Host-sid`(Secure·HttpOnly·SameSite=Lax·Path=/·Domain 없음), http(개발·`*.localhost`)면 `mycel-dev-sid`. 읽을 때도 그 방식의 이름만 받는다: https에서 `mycel-dev-sid`를 받으면 다른 `*.treesoop.com` 주소가 심은 쿠키로 세션 고정이 되므로(7번 탭) 무시한다. 중계 클라이언트는 요청 주소를 `https://<팀 주소>`로 만들어야 한다. 앱·스크립트는 `Authorization: Bearer`, 모바일 껍데기 WebSocket은 subprotocol `mycel.bearer.<token>`도 받는다(둘 다 bearer라 CSRF 헤더 면제). `last_seen_at`은 1분에 한 번만 쓴다.
- **로그인 횟수 제한**(DB `login_attempts`, 재시작해도 유지): 15분 창에서 계정당 실패 10회, 실제 IP당 30회(여러 계정 합산), 로그인한 사람의 비밀번호 재확인·현재 비밀번호 확인 5회, 초대·재설정·첫 설정 토큰 추측은 IP당 30회. 넘으면 429 + `Retry-After`. 막힌 동안에는 비밀번호를 확인하지 않는다(맞는 비밀번호도 429). 시도는 비밀번호를 확인하기 *전에* 센다(성공하면 그 기록을 지운다): 확인이 느려서, 먼저 확인하고 나중에 세면 동시에 보낸 40개가 모두 한도 검사를 통과했다. argon2id는 동시에 4개까지만 돌리고 200개까지 기다리게 하며 그 이상은 429(메모리 64MiB씩). 막힌 시도의 `auth.rate_limited` 감사 기록은 IP(모르면 계정)당 1분에 한 번만 남긴다(디스크 채우기 방지). 초대·재설정 링크의 토큰은 로그의 요청 경로에서 `***`로 바꾼다. 로그인에 성공하면 그 계정의 실패만 지운다. IP는 `info.ip`(소켓 상대 또는 중계 OPEN 메타데이터)만 쓰고, 모르면 계정 제한만 건다. 감사 기록에는 IP와 경로(direct/relay)만, 시도한 비밀번호는 절대 남기지 않는다.
- **없는 아이디와 틀린 비밀번호는 같은 문구·같은 시간**(없는 계정도 더미 argon2id 해시로 확인). 비활성 계정은 비밀번호가 맞았을 때만 "사용할 수 없는 계정"이라고 알린다.
- **비밀번호 규칙**: 10~256자, 흔한 비밀번호 목록(ko/en/id 흔한 것 포함), 서로 다른 문자 4개 이상, 짧은 반복 금지, 아이디 포함 금지. 임시 비밀번호는 헷갈리는 글자(0/O, 1/l/I)를 뺀 `xxxx-xxxx-xxxx-xxxx`.
- **비밀번호 재설정은 두 가지를 다 둔다.** 설계(1·4·5번 탭)는 1회용 재설정 링크(24시간, 메일 없이 관리자가 전달)이고, 기반 계약에는 임시 비밀번호(첫 로그인 때 변경 강제)가 있었다. 둘 다 구현했다: `POST /api/admin/users/:id/reset-link`, 공개 `GET/POST /api/password-resets/:token`. 새 링크를 만들면 이전 링크는 무효. 링크를 쓰면 그 사람의 다른 세션이 모두 끝나고 바로 로그인된다. owner 본인 복구는 서버 맥에서 `bun run admin reset-link`(메뉴바 앱이 이 CLI를 부르면 된다). "마지막 초기화: 누가·언제"는 `/api/me`의 `passwordReset`(누가 = null이면 서버 맥 복구). 화면 알림 테이블(notifications)은 아직 주인이 없어 만들지 않았다.
- **링크 주소**: 초대 `<origin>/invite/<token>`, 재설정 `<origin>/reset-password/<token>`(D가 이 경로를 쓴다). origin은 요청의 Origin이 이 서버·`publicOrigins`일 때 그것, 아니면 `publicOrigins[0]`, 아니면 요청 주소.
- **초대 기본 유효 기간 7일**(1·5번 탭; 계약 기본값 72시간을 168시간으로). 1회용(동시 수락도 한 번만), 사용한 초대는 취소할 수 없다. 취소한 초대는 목록에서 뺀다. admin 역할 초대는 owner만.
- **첫 owner 만들기**: `POST /api/setup`(설정 토큰, 사용자가 0명일 때만, 즉시 트랜잭션 안에서 다시 확인)과 CLI `bun run admin create-owner --username … --name … --team … < 비밀번호`(비밀번호는 stdin으로만). 성공하면 설정 토큰 파일을 지운다. 기본 폴더 `shared/`(everyone 쓰기)·`skills/`(everyone 읽기, admin 역할 쓰기)와 `groups/`·`projects/`·`users/<owner>/`를 만든다.
- **역할 규칙**: admin을 만들고·바꾸고·지우고·초기화하는 것은 owner만. owner 계정은 관리 API로 바꾸거나 지울 수 없고(넘기기만, 비밀번호 재확인), 자기 역할·상태는 바꿀 수 없다. 아이디는 대소문자 구분 없이 유일.
- **계정 삭제는 묘비(tombstone)**: 바로 비활성 + 세션 종료 + 엔진 세션 초기화, 아이디(username)는 풀어서 다시 쓸 수 있게 하고 `users.id`(개인 폴더 이름)는 다시 쓰지 않는다. 채팅·메모리는 `chatTrashRetentionDays`(기본 7일) 뒤 정리하고, 사용량(turns)과 감사 기록의 이름은 남긴다. 개인 폴더는 `transfer`(기본)면 owner 개인 폴더 아래 `보관된 계정/<id>/`(팀 기본 언어)로 옮기고 `.attachments/`는 지운다. `delete`면 함께 지운다. 2번 탭의 "`보관/<이름>/` + owner만 쓰기 규칙"은 admin이 규칙과 상관없이 `users/` 밖 전부 쓰기라 owner 전용이 되지 않으므로, owner 개인 폴더 안에 두는 쪽을 골랐다.
- **그룹 폴더 이름은 그룹 이름 그대로**(`groups/마케팅`), 이름 규칙에 걸리면 `groups/group-<id 끝 8자리>`. 그룹 이름을 바꿔도 폴더 이름은 그대로다(폴더 이름 바꾸기는 파일 API가 `folders.path`를 고친다). 그룹을 지우면 그 그룹 규칙과 예산이 지워지고 폴더는 남는다. 그래서 새 그룹은 이미 있는 폴더(디스크나 `folders`, 대소문자·유니코드 형태 무시)를 쓰지 않고 `<이름>-2`처럼 새 폴더를 만든다: 옛 그룹 폴더의 파일을 새 그룹이 이어받지 않게.
- **폴더 경로는 디스크의 실제 이름으로 저장**: 관리자가 `PROJECTS/Apollo`라고 써도 권한 함수와 같은 걷기로 `projects/apollo`를 찾는다. `users/`·`users/**`·`.system`, 파일, 심볼릭 링크, 이름 규칙 위반은 거부. 같은 대상 규칙 두 번, 없는 그룹·사람은 400. 규칙 전부 지우기(`DELETE /api/admin/folders/:id`)는 `folders` 행까지 지우고 디스크 폴더는 남긴다.
- **H7(권한 회수)**: 규칙·그룹 구성원·역할이 바뀌면 바뀌기 전후의 실효 권한을 팀 폴더 맨 위와 규칙이 있는 모든 폴더에서 비교한다(어느 경로의 권한은 그 위에서 가장 가까운 규칙 폴더, 없으면 맨 위의 권한과 같으므로 이것으로 충분. 맨 위를 빼먹으면 admin이 member가 될 때 규칙 없는 폴더를 잃은 것을 놓친다). 읽기를 잃은 사람은 *모든* 채팅의 엔진 세션을 초기화한다(`chats.engine_session_id = NULL` + `<data>/sessions/<chatId>/` 삭제 → 다음 턴은 DB 기록으로 시작). 어떤 채팅이 그 폴더를 읽었는지는 아직 기록되지 않기 때문(`session_read_scope`는 B 몫). 권한이 바뀐 사람에게는 WebSocket `notice {code:'access_changed'}`를 보낸다(설계의 `access.changed`가 ws 계약에 없어 기존 `notice`를 썼다). 잃은 사람·경로·초기화한 채팅 수는 원인(규칙·그룹·역할·삭제)과 상관없이 `folder.access_lost` 감사 기록으로 남는다. 미리보기의 `chatsReset`은 엔진 세션이 있는 채팅 수.
- **엔진 상태는 모델을 부르지 않는다**(10분 캐시, `POST …/check`는 바로 다시). local-login: `claude --version` + `claude auth status --json`, `codex --version` + `codex login status`. 전용 엔진 계정 모드(prod): `<data>/secrets/claude-setup-token`이 없으면 "owner가 `claude setup-token`을 실행해 붙여 넣어야 함"(이번 실행에서는 막힘). 회사 키 모드: 회사 키가 있는지. `versions.json`의 고정 버전과 다르면 `version_unsupported`, `<data>/engine/lockdown-<engine>.json`이 `{ok:false}`면 `lockdown_failed`. Claude 모델은 별칭 opus/sonnet/haiku, Codex 모델은 `<data>/engine/codex-catalog.json` → `$CODEX_HOME/models_cache.json` 순서로 읽고 `visibility: hide`는 뺀다.
- **회사 키**(코드만): `<data>/secrets/<id>.key`(600, 폴더 700), DB에는 파일 이름과 끝 4자리만.
- **예산은 계약대로 day/month · USD/토큰을 저장하고 지금 사용액을 보여 준다.** 집행은 회사 키(proxy) 모드에서만 하며, 턴을 시작하는 쪽·모델 프록시가 `checkBudgets(db, userId)`(server/src/admin/budgets.ts)를 부른다. 설계 1번 탭의 5시간·주 단위와 턴 수 한도(구독 모드 기본 "5시간에 20턴")는 계약에 아직 없다(후속).
- **팀 설정 키 = TeamSettings 필드 이름**(값은 JSON), 엔진 켜기/끄기는 `engines.enabled`. 읽기는 `getTeamSettings(db)`(다른 컴포넌트도 이것만 쓴다). 기본값: 동시 실행 3, 감사 90일, 파일 버전 30일, 휴지통 30일, 채팅 휴지통 7일. 팀 이름 변경은 owner만(중계 주소가 바뀜).
- **감사 목록**은 `audit_log`(`auth.*` 동작은 source `auth`) + `file_events` + `tool_events`를 시각 역순으로 합치고 `(at, id)` 커서로 나눈다. `path` 필터는 그 경로 아래 파일 이벤트만. 남의 개인 폴더 안은 owner·admin에게도 none이므로 감사 목록에서도 `users/<id>/…`로만 보인다(파일 이름·크기·해시·도구 요약 속 경로를 가림, 보는 사람 자기 폴더는 그대로). 남의 개인 폴더 경로로 거르면 빈 목록. 보관 기간 정리는 `audit_log`만 한다(파일·도구 이벤트는 각 주인 규칙).
- **`RealtimeHub.disconnectSession`(선택 메서드)을 더했다.** 로그아웃·"이 기기 로그아웃"·비밀번호 변경 뒤의 다른 세션은 그 세션의 소켓만 닫아야 한다(`disconnectUser`는 지금 창까지 4401로 닫아 재연결하지 않는다). B가 구현하기 전에는 세션이 DB에서 지워진 것으로 끝난다.
- **열린 초대는 만든 사람의 권한을 따른다**: 만든 사람이 삭제·비활성화되거나 admin에서 member가 되면 아직 안 쓴 초대는 취소된다. 동시에 같은 아이디로 만들거나 비슷한 아이디(`a.b`·`a-b`)로 가입해도 500이 나지 않게 `users.id`는 쓰기 트랜잭션 안에서 정한다.
- **주기 정리**(1시간마다, 시작 5초 뒤 한 번): 만료 세션, 지난 로그인 시도, 지난 재설정 링크, 보관 기간 지난 감사 기록, 삭제한 계정의 채팅·메모리.

## C — 파일 화면·업로드·작업·도구 (server-files-tools, 2026-10-21)

코드: `server/src/team-files/*`(파일 화면 서비스, 다운로드, files.changed, 컴포넌트 허브 `componentC(ctx)`), `server/src/uploads/*`, `server/src/jobs/*`, `server/src/tools/*`(make_file·share_file·artifact·web_fetch·변환기 격리·도구 등록), 라우트 `files.ts`·`artifacts.ts`·`jobs.ts`, 마이그레이션 `301_c_files.sql`.

- **변환기 격리(3번 탭)는 이번에는 서버 프로세스 안에서 sandbox-exec(맥)·bwrap(리눅스)로 한다**(`tools/isolate.ts`). 네트워크 금지, 변환기 자신 외 exec·fork 금지, 빈 작업 폴더에만 쓰기, /Users·임시 폴더·팀 폴더·서버 데이터의 *내용* 읽기 금지(메타데이터는 허용: typst·pandoc이 cwd의 상위 폴더를 stat한다), 시간·출력 한도. 설계의 "실행기가 _axagent로 실행"은 실행기 프로토콜 확장이 필요해 뒤로 미뤘다(G/실행기). 리눅스에 bwrap이 없으면 격리 없이 돌고 pandoc `--sandbox`·typst `--root`만 남는다(`isolation()`이 'none'을 알려 줌). Stage 1의 글자 추출(read·grep)도 이 경로로 바꿨다.
- **whisper.cpp는 Metal 셰이더 캐시(`DARWIN_USER_CACHE_DIR/com.apple.metal`) 읽기·쓰기를 허용해야 한다.** 막으면 매번 셰이더를 다시 컴파일해 0.4초 걸릴 일이 15초 걸린다(실측).
- **pandoc `--sandbox`는 명령줄의 입력 파일 말고는 아무것도 못 읽어서 docx·pptx에 그림을 넣을 수 없다.** 그래서 그림은 우리가 검사한다: 마크다운을 먼저 `pandoc --sandbox -t json`으로 문서 트리로 바꾸고, 트리의 **모든 Image 노드**(인라인·참조식·`<꺾쇠>`·속성 붙은 것·링크 안 그림 어느 문법이든)를 검사해 팀 폴더 상대 경로 + 읽기 권한이 있는 그림만 작업 폴더에 복사하고 노드를 그 사본으로 바꾼다(그림 200개·합계 100MB까지). 웹 주소·`data:`·절대 경로·숨긴 파일은 변환 전에 오류, HTML `<img>` 등은 안내 오류. 그다음 `-f json`으로 문서를 만든다. 그림이 없으면 `--sandbox`, 있으면 트리에 남은 그림 경로가 사본뿐이라 `--sandbox` 없이 돌린다(OS 샌드박스가 있으면 그 안에서). `--fail-if-warnings`는 항상. (리뷰: 처음의 정규식 방식은 참조식 그림·공백 있는 꺾쇠 경로를 놓쳐 pandoc이 OS 샌드박스가 허용하는 아무 파일이나 읽을 수 있었다.)
- **사람·AI가 고른 입력을 다루는 코드에는 되짚는(backtracking) 정규식을 쓰지 않는다.** 서버는 프로세스 하나라 정규식 하나가 몇 시간 돌면 팀 전체가 멈춘다. 리뷰에서 찾은 것: web_fetch의 HTML→글자(60KB 열린 태그 3.7초, 5MB면 수 시간 → 한 번 훑는 토크나이저로 교체), 파일 내용 응답의 끝 `\uFFFD+$`(잘못된 UTF-8로 가득한 파일 → 바이트에서 경계 계산), make_file의 표 감지 `^\s*\|`(줄바꿈만 10MB → `[ \t]`만 쓰는 패턴). 시험: `tests/unit/c-review.test.ts`.
- **휴지통에 간 폴더는 폴더 규칙을 가지고 간다**: 규칙은 경로로 저장되므로, 지울 때 그 폴더와 하위의 `folders` 행을 휴지통 경로(`.system/trash/<월>/<id>/…`)로 옮겨 두고, 되돌릴 때 되돌린 경로(" (복원됨)" 이름이어도)로 다시 옮긴다. 휴지통·버전 열람 권한은 옮겨 둔 규칙을 원래 자리에 있는 것처럼 읽는다. 영구 삭제하면 그 규칙과 그 아래에서 저장된 버전도 같이 지운다. (전에는 규칙이 원래 경로에 남아 같은 이름으로 새로 만든 폴더가 규칙을 물려받고, 다른 이름으로 되돌린 비밀 폴더는 규칙 없이 돌아왔다.)
- **make_file이 기존 파일을 만나면**: 이 턴에 그 버전을 read했으면 덮어쓰고(이전 내용은 버전), 아니면 충돌 사본 이름으로 저장한다(설계 "있으면 충돌 사본").
- **web_fetch는 Bun fetch·node:http를 쓰지 않고 net/tls 소켓 위의 작은 HTTP/1.1 GET**이다. 둘 다 `HTTP(S)_PROXY` 환경 변수를 따르고 끌 수 없으며(실측), IP를 고정할 수 없다. 한 번 푼 주소(전역 유니캐스트 허용 목록, IPv4-mapped는 안의 IPv4로 검사, 서버 자신의 주소 거부)로 직접 연결하고 Host·SNI는 원래 이름. 이름 규칙: localhost·*.local·*.internal·*.home.arpa·*.lan·한 단어 이름 거부. 압축 해제는 스트리밍으로 5MB에서 끊는다(Bun 1.3.12의 `gunzipSync({maxOutputLength})` 경로가 테스트 중 프로세스를 죽였다). 결과는 `<external_data>`로 감싸고 tool_events에 URL 전체를 남긴다. 성공하면 `ctx.files.events`에 `'external'`을 내보낸다(B의 remember 보호용).
- **Bun 1.3.12 함정 두 개와 대응**: ① Hono의 `c.header()`는 끝난 응답을 `new Response(res.body, res)`로 다시 감싼다 → 파일 응답이 JS 스트림이 되어 배압 없이 메모리에 쌓인다. 기반 미들웨어를 헤더 직접 설정으로 고쳤다. ② `Bun.file().slice()` 본문을 스트림으로 읽으면 끝을 무시하고 파일 끝까지 나오고, `slice().stream()`은 끝나지 않는다. 그래서 전체 파일은 `Bun.file`(sendfile), Range는 우리 pull 스트림으로 한 응답에 최대 8MB(Content-Range로 알림, 미디어·PDF 뷰어는 다음 부분을 다시 요청). 중계(F)가 `res.body`를 읽어도 정확하고 메모리는 요청당 8MB 이하.
- **휴지통 목록은 원래 경로에 쓰기 권한이 있는 항목만**(4번 탭; 계약 요약도 그렇게 고침). 영구 삭제 `DELETE /api/files/trash/:id`(admin 이상)를 계약에 더했다. 폴더 삭제는 폴더째 `.system/trash/`로 rename(읽지 않음), 되돌리기도 폴더째.
- **버전·휴지통의 folder_id·path_at_save는 트리거로 채운다**(stage 1 도구 쓰기도 같이). `file_versions.path`는 *지금* 경로(이동 API가 고침), `path_at_save`는 그대로. 열람은 folder_id 폴더의 지금 경로와 파일의 지금 경로 둘 다 읽기 권한(폴더 행이 없으면 path_at_save) — 비밀 폴더에서 공용으로 옮긴 파일의 옛 버전은 계속 숨는다(시험 있음).
- **폴더 이동·삭제는 그 안의 규칙 폴더 전부에 쓰기 권한이 있어야 한다.** 아니면 users/<나>/ 아래로 옮겨(규칙 무시 구역) 숨은 하위 폴더를 손에 넣을 수 있다. 루트·users/·users/<id>/·.system/은 옮기거나 지울 수 없다. 대소문자만 바꾸는 이름 변경은 대소문자 무시 볼륨에서 그대로 된다.
- **조각 업로드**: 조각은 희소 파일 `<data>/uploads/<id>.part`의 제자리(offset)에 바로 쓴다(조립 단계 없음). 조각이 순서대로 오면 sha256을 오는 길에 계산(Hash.copy로 실패한 조각은 버림)해 complete가 즉시 끝난다. complete 재시도는 같은 답(`upload_sessions.result`). sha 불일치면 받은 조각 목록을 비운다. 열린 세션은 사람당 10개, 디스크 여유(크기+1GB) 확인. 대상 폴더는 미리 있어야 한다.
- **첨부**: `attachments` 테이블(id로 찾음, B는 `componentC(ctx).attachments.byIds()`), 썸네일은 격리된 ffmpeg(sips는 사용자 임시 폴더에 써야 해서 샌드박스 안에서 실패), ffmpeg가 없으면 2MB 이하 png/jpg/gif/webp 원본.
- **작업은 본인 것만 본다**(4번 탭 "본인 작업만"): 받아쓰기 결과는 그 사람의 말이라 owner도 남의 작업은 404. 사람이 없는 작업(user_id NULL: 시스템 백업·업데이트)만 owner가 본다. 영구 삭제도 휴지통 열람과 같은 조건(원래 경로 쓰기 권한)을 더 요구한다: admin이라도 남의 users/<id>/ 휴지통 항목은 못 지운다.
- **조각 업로드 complete가 겹치면**(큰 파일 해시 중 클라이언트가 시간 초과로 다시 부름) 두 번째는 첫 번째 결과를 기다려 같은 답을 받는다. 그동안 조각·취소는 409. 디스크 여유 확인은 끝나지 않은 세션들이 앞으로 쓸 크기까지 더한다(희소 파일).
- **작업(JobService)**: 무거운 종류(transcribe·backup·restore·update·export)는 종류별 한 번에 하나. 진행 이벤트는 0.5초에 한 번. 실패 문구는 그 사람의 언어(ko/en/id), 예상 못 한 오류는 일반 문구만. 재시작 시 queued/running → failed("서버가 다시 시작되어…").
- **받아쓰기 모델 기본값은 `small`(다국어, 488MB, sha256 고정)**, 처음 쓸 때 `<data>/models/whisper/`로 내려받는다. `MYCEL_WHISPER_MODEL=tiny|base|small`, `MYCEL_WHISPER_MODEL_DIR`, `MYCEL_WHISPER_BIN`으로 바꿀 수 있다. 시험은 tiny를 `tests/.cache/whisper`(git 무시)에 한 번 받아 쓰고, `say`로 만든 음성을 실제로 받아쓴다(맥).
- **share_file 링크**: preview = 웹 화면 경로 `/files/view?path=`(D가 구현), download = `/api/files/download?...`. 둘 다 여는 사람의 세션으로 다시 권한 확인.
- **보관 기간 설정**: `trashRetentionDays`(기본 30), `fileHistoryRetentionDays`(기본 7, 1번 탭)는 관리자 화면과 같은 `getTeamSettings()`(`admin/settings.ts`의 `DEFAULT_SETTINGS` + 저장값) 하나에서만 읽는다. 정리는 1시간마다. (보안 검토 r1: 전에는 정리 코드가 따로 기본값 7을 갖고 화면은 30을 보여, 관리자가 30일이라고 믿는 동안 7일 지난 버전이 지워졌다. 기본값은 1번 탭대로 7.)

다른 컴포넌트가 알아야 할 것:
- **B**: 비파일 도구는 `toolRegistry(ctx.files).register({...})`로 등록한다(`server/src/tools/registry.ts`, MCP 목록·호출·감사가 자동). **엔진 허용 목록(Claude `--allowedTools`, Codex `enabled_tools`)은 아직 파일 도구 6개뿐이라 make_file 등 새 도구를 엔진이 부르려면 `engine/claude.ts`·`codex.ts`에 이름을 더하고 잠금 회귀 시험을 돌려야 한다**(B 몫). 아티팩트 저장은 `componentC(ctx).artifacts.apply()`(도구가 이미 부름), "writing" 미리보기 이벤트는 B. web_fetch 뒤 remember 확인은 `ctx.files.events.on('external')`.
- **D**: `/files/view?path=` 화면, 내용 응답 헤더 `x-content-sha256`(저장 시 baseSha256), 썸네일 `/api/uploads/:id/thumbnail`, 받아쓰기 `POST /api/transcribe` → `job.done`.
- **F**: 다운로드 응답 본문을 그대로 창 단위로 읽으면 된다(전체 파일은 지연 읽기, Range는 8MB 이하 스트림).
- **G**: `ctx.services.jobs`가 설치돼 있다(`jobs` 모듈 init). 진단에 `isolation()`(sandbox-exec / bwrap / none)과 whisper·typst·ffmpeg 유무를 보여 주면 좋다.

# B — server-chat-realtime (채팅·대기열·엔진 통합·실시간·브라우저 중계, 2026-10-21)

## 대기열·턴
- **같은 채팅에 대기·실행 중인 턴이 있으면 보내기·수정·다시 생성은 409 `conflict`**(문구 "답변이 아직 진행 중"). 3번 탭(claude.ai처럼 [중지]만)을 따랐다. 4번 탭의 "거절하지 않고 대기열에 넣는다"와 다르다. 같은 `clientMessageId` 재전송은 409가 아니라 처음 결과를 돌려준다.
- **`queuePosition`/`queue.position`: 0 = 실행 중, 1 = 다음 차례, n = n번째.** 자리는 팀 전체 동시 실행 수(`settings.concurrency`, 기본 3) 안에서 먼저 온 순서. 공정 분배(한 사람 40% 넘으면 뒤로)는 아직 없다.
- **B가 읽는 `settings` 키(값은 JSON)**: `concurrency`(1–16, 기본 3), `ask_user_timeout_sec`(30–900, 기본 600), `chatTrashRetentionDays`(기본 7), `defaultEngine`, `defaultModel`(기본 엔진에만 적용), `engine.fallbackModel`. 이름은 `TeamSettings` 필드 이름과 같다 — A가 같은 키로 저장하면 바로 반영된다(턴을 배정할 때마다 읽음).
- **시간 제한 20분은 서버가 활성 시간으로 잰다**: 사람 답(ask_user, 사내망 확인)을 기다리는 동안 시계가 멈춘다. 실행기의 시간 제한은 3시간짜리 비상 장치로만 둔다(실행기는 멈춤을 모르므로).
- **재시도**: ① 거절(`refused`) → 다른 모델로 1회(설정 `engine.fallbackModel`, 없으면 sonnet↔opus), 새 엔진 세션 + 기록으로. 이미 내보낸 글자는 지울 수 없어서(offset 규칙) 빈 줄 뒤에 이어 쓰고, 단계("다른 모델로 다시 답합니다")와 `notice`를 남긴다. ② 엔진이 멈춤(crash) → **글자·도구 호출이 하나도 없었을 때만** 1회(도구가 이미 파일을 썼을 수 있어서). ③ 이어가기 실패("No conversation found") → 새 세션 + 기록으로 1회.
- **오류 코드는 공통 `ErrorCode`에 새 값을 더하지 않고 매핑했다**(공유 파일 충돌을 피하려고), 문구는 사용자 언어: auth→`engine_unavailable`, rate_limit→`rate_limited`, context→`payload_too_large`, timeout→`busy`, refused→`forbidden`, crash→`internal`, 서버 재시작으로 중단→`unavailable`("서버가 다시 시작되어 답변이 중단되었습니다"). 화면은 `message`를 그대로 보여 주면 된다.
- **서버 시작 때**: running이던 턴 → interrupted + 답변 `error`(위 `unavailable`), 그 턴의 프록시 토큰 폐기. queued 턴은 순서대로 다시 돈다(같은 채팅에 둘이면 뒤의 것은 stopped). 실행기 reap은 실행기 수명과 같이 끝나는 개발 모드에서는 필요 없고, LaunchDaemon 실행기(G)에서 할 일이다.

## 엔진 세션·지침
- **엔진 세션은 대화 트리의 한 가지를 따른다**: `chats.engine_session_leaf_id` = 세션 대화가 끝나는 메시지. 새 턴의 부모가 그것과 같을 때만 `--resume`, 아니면(수정·다시 생성·다른 가지·엔진 바꿈) 새 세션 + 그 가지의 DB 기록. 그래서 가지를 바꿔도 모델이 다른 가지의 내용을 기억하지 않는다.
- **기록은 지침 끝 `<previous_conversation>`**(3번 탭)에 최근 것부터 40,000자, 나머지는 "(N earlier messages omitted)". Stage 1 실행기는 메시지 앞에 붙였었다.
- **Codex는 이어가기 없이 매 턴 기록으로**(Stage 1 그대로 `--ephemeral`). 설계서의 `codex exec resume` + rollout 파일 보관은 하지 않았다: 고정 버전에서 잠금 구성과 함께 시험되지 않았고, 매 턴 기록 방식이 엔진 바꾸기·가지와도 자연스럽게 맞는다.
- **세션 보관본은 채팅마다 파일 하나** `<data>/sessions/<chatId>/<세션id>.jsonl`(600, 임시 파일 → rename). 설계서의 `<engine>.tar.gz` 대신 Stage 1 형식을 유지했다. 20MB가 넘으면 버리고 다음 턴은 기록으로 새로 시작. 중지된 턴의 세션도 보관한다(실행기가 중지 뒤에도 회수).
- **지침 구성**(3번 탭 1–7): 기본 규칙(도구 있는 것만 설명: make_file·artifact·ask_user·remember), 사람(이름·역할·그룹 이름·개인 폴더·쓰기/읽기 폴더), 현지 시각·시간대, 답변 언어(`users.prefs.answerLocale` → `users.locale`), 메모리(사실 블록, 항목 300자·전체 4KB, id 포함 — forget용), `skills/*.md`(읽을 수 있는 것만, 10개·4KB씩), 프로젝트 이름·폴더·지침, 데스크톱이면 브라우저 규칙. 지침 파일은 이어가기 때도 매 턴 새로 쓴다. 이어간 세션이 바뀐 지침(새 메모리)을 보는지는 e2e T8로 확인하게 해 두었으나 이번 실행의 호출 예산 안에서 돌리지 못했다(후속). 새 세션·프로젝트 지침 반영은 실제 e2e T6에서 확인.
- **remember 보호의 "외부 내용을 봤다" 판정**: 웹 검색(엔진 내장), web_fetch, 브라우저 도구, 본인 폴더(`users/<나>/`) 밖에 대한 read/grep/glob/list, 다른 사람이 쓴 프로젝트 지침. 판정은 엔진 스트림과 도구 소켓 양쪽에서 한다(둘의 도착 순서가 바뀔 수 있어서). **표시를 지우는 것은 기록이 없는 새 세션(새 채팅, 첫 메시지 수정)뿐**: 기록을 넣고 새로 시작한 세션은 기록 속에 본 내용이 남아 있으므로 그대로 둔다(설계서보다 보수적).
- **메모리는 300자를 넘으면 자르지 않고 거절**(모델에게 줄이라고 돌려준다). 확인 카드를 거친 것은 `source='user'`, 그 밖은 `'ai'`.

## 단계(steps)·파일 요약
- 단계 이름은 사람 말로(사용자 언어): `Read · shared/notes.md`, `Search "invoice" · finance/`, `Web search: …`, `Open page · https://…`. 도구 입력 원문은 넣지 않는다. 생각(thinking)은 연속 구간마다 단계 하나.
- **도구가 자기 단계에 덧붙이는 정보**: remember → `label "기억함: …"`, `detail "memory:<id>"`(화면의 [취소] = `DELETE /api/memories/:id`). ask_user → `detail` = 고른 답(없으면 "답하지 않음"). 공유 스크린샷 → `images[]`. 엔진의 tool_start 줄(stdout)과 도구 호출(소켓)은 순서가 바뀔 수 있어, 단계가 아직 없으면 덧붙일 내용을 기다렸다가 붙인다.
- 웹 검색 카드는 Claude WebSearch 결과의 `Links: [...]`에서 만든다.
- **"이 턴에 바뀐 파일"에서 `users/<id>/.attachments/` 아래는 뺀다**(첨부·공유 스크린샷).
- `files.changed`: 턴의 도구 호출이 끝날 때마다 새 `file_events`를 모아, 그 경로를 읽을 수 있는 사람에게만 보낸다(`publishEach`).

## 실시간
- **연결 직후 항상 `hello`가 먼저**, 이어받기가 안 되면 그다음에 `reset`(다른 epoch) 또는 `resync`(버퍼에서 밀려남·미래 seq). 클라이언트는 hello의 seq부터 이어 간다.
- **인증은 업그레이드 뒤에** 한다: 브라우저 WebSocket은 HTTP 상태를 볼 수 없으므로 닫기 코드(4401·4403·4400)로 알린다. 쿠키 세션은 Origin이 같은 서버이거나 `publicOrigins`일 때만, 없으면 4403. Bearer는 subprotocol `mycel.bearer.<token>`(응답은 항상 `mycel.v1`, 토큰 프로토콜은 되돌려 보내지 않음). 설계서의 `ws-ticket`은 만들지 않았다(WORKPLAN 결정).
- **버퍼**: 사람마다 최소 2000개·5분(계약 상수), 상한 20,000개·16MB. 같은 답변의 연속 delta는 한 항목(마지막 seq)으로 합친다 — 이어받으면 겹친 부분은 offset으로 버린다. 창 지정 이벤트(browser.call, 사내망 확인 카드)는 그 창에만, 이어받을 때도 그 창에만. ack된 browser.call은 다시 보내지 않는다.
- 중계(F)의 가상 WebSocket은 `ctx.services.realtime.attach(conn, req, info)`로 붙인다(직접 연결과 같은 인증).

## 브라우저 중계
- 브라우저 도구는 파일 도구와 같은 MCP 서버의 도구다(`mcp__team__navigate` 등, 이름은 계약 `BrowserToolName`). **엔진에 보여 줄 설명·입력 스키마는 `server/src/realtime/browser-tools.ts`(Saram d315378 포팅)**. E의 `shared/src/browser-tools.ts`가 생기면 그 스키마로 합친다(후속).
- 도구는 **데스크톱 세션(`session.client === 'desktop'`)이 보낸 메시지이고, 그 창(`X-Mycel-Window`)이 지금 연결돼 있을 때만**(WebSocket 또는 45초 안의 롱폴링, 턴 시작 때 3초 기다림).
- **사내망 판정**(서버에서 할 수 있는 만큼): 사설·예약 IP, `localhost`·점 없는 이름·`.local/.internal/.lan/.corp/.home.arpa…`, 서버에서 사설 IP로 풀리는 이름. 해당하면 그 창에만 `browser_site` 카드 → once(이 턴만)/always(`browser_site_grants`)/deny.
- 결과 POST(`/api/browser/results`)의 JSON 한도는 25MB(스크린샷). Bun WebSocket 메시지 기본 한도가 16MB이므로 아주 큰 결과는 POST로 보내야 한다(E에 전달할 것).
- 롱폴링: 결과가 아직 없는 호출은 15초가 지나면 다시 돌려준다(응답 유실 대비). 창이 60초 안에 돌아오지 않으면 `browser_unavailable`.
- 공유 스크린샷(`shareToChat`)은 `users/<id>/.attachments/<chatId>/screenshot-*.png`에 저장하고 단계의 `images`에 넣는다(답변 본문에 넣지 않음).

## 계약·다른 컴포넌트와의 경계
- **새 엔드포인트 `GET /api/chats/:id/requests`**: 진행 중인 턴의 열린 카드(창을 새로 열거나 resync 뒤 다시 보이기). `browser_site`는 그 창에만.
- `AskUserRequest.expiresAt`(선택) 추가.
- `services.ts`에 추가: `RealtimeHub.attach`, `RealtimeConn`, `AttachmentStore`(C: 첨부 id → `Attachment`), `TurnTool`/`turnTools`(C의 make_file·share_file·artifact·web_fetch를 `init()`에서 `(ctx.services.turnTools ??= []).push(tool)`). 첨부 저장소가 아직 없으면 첨부가 붙은 메시지는 `validation` 오류.
- A용: `resetEngineSessions(ctx, userId)`(`server/src/chat/runtime.ts`) — 읽기 권한이 줄었거나 계정이 비활성화되면 그 사람 채팅의 엔진 세션을 버린다(H7).
- G용: `getChatRuntime(ctx).drain(ms)`(새 턴을 멈추고 실행 중인 턴을 기다림, 계획된 재시작)과 `resume()`.
- **채팅 휴지통 정리**(1시간마다, 기본 7일): 메시지·아티팩트·세션 보관본·엔진 작업 폴더를 지운다. `turns` 행은 사용량 기록이라 남기고, `.attachments/` 파일은 파일 쪽 규칙(C)에 맡긴다.

## Stage 1 코드에서 고친 것
- **도구 소켓의 부분 쓰기**: Bun `socket.write`는 큰 응답(긴 파일 읽기, 브라우저 도구가 든 도구 목록)의 일부만 쓸 수 있는데 나머지를 버리고 있었다 → 엔진이 영원히 기다림. 연결마다 못 쓴 바이트를 모아 drain 때 순서대로 보낸다(400KB 읽기 회귀 시험).
- `EngineEvent`의 tool_start에 `input`, tool_end에 `output`(최대 20,000자)을 더했다(단계 이름·검색 카드). Claude `MCP_TOOL_TIMEOUT=1800000`, Codex `tool_timeout_sec=1800`(사람 답 기다림). 턴 레지스트리는 대기열이 만든 턴 행을 그대로 쓴다.

## 검수에서 고친 것 (B 리뷰)
- **브라우저 창에 여는 주소는 http·https와 `about:blank`만**: `file:`·`javascript:`·`data:` 등은 서버가 도구 오류로 돌려주고 창에 보내지 않는다(사람 컴퓨터의 파일을 읽는 길). 스킴 없는 `localhost:3000`은 `https://localhost:3000`으로 본다. `url`이 있는 모든 브라우저 도구를 검사한다.
- **사내망 판정은 "전역 유니캐스트만 공개"**: IPv6 안의 IPv4(`::ffff:7f00:1` 같은 16진 표기 포함)는 안의 IPv4로, 2000::/3 밖·문서용·6to4·Teredo는 사내망으로 본다. 끝에 점이 붙은 이름(`printer.local.`)도 같다. 단, 페이지 안 링크·`javascript_tool`로 가는 이동은 서버가 볼 수 없다 — 창(E)이 탐색 단계에서 막아야 한다(후속).
- **모델 이름은 엔진 인자로 가므로** 글자·숫자·`. _ - : / [ ]`만, `-`로 시작 못 함(채팅 만들기·바꾸기·보내기·수정·다시 생성, 설정 `defaultModel`·`engine.fallbackModel`).
- **프로젝트는 그 폴더를 읽을 수 있는 동안만 AI에게 간다**: 채팅에 붙은 채 권한을 잃으면 이름·폴더·지침을 지침에 넣지 않는다.
- **remember 보호**: 첨부가 붙은 메시지와 `users/<나>/.attachments/` 아래 읽기도 외부 내용으로 본다. 사람이 거절하면 단계 이름이 "기억하지 않음: …"으로 바뀐다.
- **지침 블록 안 글자(메모리·기록·프로젝트 지침)는 블록을 닫거나 열 수 없다**: `<memories_about_the_user`·`</previous_conversation` 등의 `<`를 `‹`로 바꾼다. 심볼릭 링크인 `skills/`는 읽지 않는다.
- **WebSocket**: 세션을 찾는 사이에 닫힌 연결은 열린 창으로 남지 않는다(`RealtimeConn.onClose`는 이미 닫혔으면 바로 부른다 — F의 가상 소켓도 같은 규칙). 사람별 seq는 epoch 동안 계속 이어진다(하루 쉬면 1부터 다시 세던 문제). 사람마다 열린 창 50개·롱폴링 창 50개까지.
- 서버 시작 때 휴지통·정리된 채팅의 queued 턴은 stopped. 잘못된 목록 커서는 400. 단계 id는 100자 안(계약). 없던 엔진은 30초마다 다시 찾는다(설치 뒤 재시작 없이).
- **이어간 Claude 세션에는 매 턴 `<turn_context>`를 메시지 앞에 붙인다**(3번 탭 "snapshot을 끌 수 없으면"): Claude Code는 `--resume` 때 처음 지침을 그대로 쓰므로, 그 뒤에 저장한 메모리·바뀐 날짜·프로젝트·폴더 권한이 모델에 닿지 않았다(실제 엔진 e2e T8 실패로 확인). 블록에는 2·3·4·6번 항목(사람·폴더, 시각·언어, 메모리, 프로젝트)과 이번 턴에 브라우저가 있으면 브라우저 규칙을 넣는다. 지침 본문은 이 블록이 서버가 쓴 것이고 앞의 값을 대신한다고 알린다. 새 세션·Codex는 지침에 이미 최신 값이 있어 붙이지 않는다.

## F 중계 (relay, 2026-10-21)

- **프레임은 스파이크 REPORT 그대로**: `[type u8][streamId u32][flags u8][len u32]`, payload 최대 64KB, type 1 OPEN·2 DATA·3 END·4 RST·5 WINDOW·6 PING·7 PONG·8 GOAWAY·9 RESPONSE·10 EVENT, RST 코드 1 CANCEL·2 CONN_LOST·3 FLOW_CONTROL·4 PROTOCOL·5 TEAM_OFFLINE·6 REFUSED·7 TIMEOUT·8 REPLACED, 제어 연결 닫기 코드 4003·4004·4008·4009. 설계서 6번 탭 "세부 규약"의 다른 번호표(2 HEAD, FIN 비트, opcode 바이트)는 따르지 않았다 — 작업 지시가 REPORT 기준이고 시험(t1–t8)이 이 형식으로 통과했기 때문. 설계서 표는 나중에 이 형식으로 맞춘다.
- **REPORT에 없던 것 몇 가지를 더했다**: ① DATA 플래그 `WS_CLOSE`(4): WebSocket 닫기 코드를 실어 나른다(B의 4401 "재연결 금지"·4409·1012가 브라우저까지 가야 해서). 창을 쓰지 않고, 뒤에 END. ② 닫기 코드 4005(공통 버전 없음 → 팀 서버는 다시 붙지 않고 "업데이트 필요"), 4010(운영자가 팀 차단). ③ 브라우저 쪽 닫기 코드 4408(느림 → 이어받기). ④ OPEN/RESPONSE 헤더는 `[이름, 값]` 쌍 목록(Set-Cookie 여러 개를 보존). OPEN에 `host`·`proto`를 넣어 팀 서버가 공개 주소로 Request를 만든다(Origin 검사가 그대로 동작).
- **핸드셰이크**: 중계가 `{t:'challenge', vs:[2], nonce, ts}`, 팀 서버가 `{t:'auth', v, team, instance, conn, ts, sig}`, 서명 문자열은 `mycel-relay-v2\n팀id\n인스턴스\nnonce\nts`(설계서의 버전 협상 + REPORT의 인스턴스). 팀은 이름이 아니라 등록 때 받은 팀 id로 붙는다(이름은 바뀔 수 있음).
- **WebSocket은 팀 서버가 받아들인 뒤에 브라우저 핸드셰이크를 끝낸다**: 중계가 OPEN(kind ws)을 보내고 RESPONSE 101(+고른 subprotocol)을 받은 다음 `handleUpgrade`. 브라우저가 subprotocol을 보냈는데 서버가 하나를 고르지 않으면 Chrome이 연결을 끊기 때문. 팀 서버는 `mycel.v1`이 있으면 그것을, 없으면 첫 번째를 고른다. 팀이 꺼져 있으면 핸드셰이크를 끝낸 뒤 1013으로 닫는다(브라우저는 실패한 업그레이드의 상태 코드를 못 읽음).
- **큰 WebSocket 메시지는 중계가 조립하지 않는다**: 팀 서버가 보낸 조각(WS_CONT)을 도착하는 대로 브라우저에 WebSocket 조각(fin=false)으로 내보내고, 다른 바이트처럼 브라우저 소켓이 받아 간 뒤에 창을 돌려준다. 처음 구현은 조각마다 창을 바로 돌려주고 16MB 조립 버퍼를 썼는데, 그러면 팀 서버 하나가 스트림 512개 × 16MB를 중계 메모리에 쌓을 수 있었다(검수에서 수정). Bun 내장 `ws`는 `fin`을 무시하므로 Bun 안에서 도는 단위 시험에서만 16MB 상한 조립을 쓴다. 팀 서버 쪽 가상 소켓은 브라우저 메시지(중계가 4MB로 제한)를 조립한다.
- **중계 경유 WebSocket과 실시간 허브의 이음매**: 중계로 온 브라우저 WebSocket은 `VirtualWebSocket`(services.ts, `relay-client/virtual-ws.ts`)이다. 통합(main)에서 B의 `RealtimeHub.attach(conn, req, info)` 하나로 합쳤다: 중계 클라이언트가 `relay-client/realtime-conn.ts`의 `relayConn()`으로 `RealtimeConn`을 만들어 넘기므로, 중계로 온 `/api/ws`도 직접 연결과 같은 인증(쿠키 + Origin, ticket)·이어받기 규칙으로 붙는다(처음 쓰인 `attachVirtual`은 없앴다). 늦게 등록된 onClose는 바로 불린다(B의 규칙). 가상 소켓은 `bufferedAmount`(스트림에 쌓인 바이트)를 주므로 B의 4408 규칙이 그대로 쓰이고, 그보다 256KB 위에서 스트림을 RST하는 안전장치가 있다.
- **중계 기록**: 로그 필드는 팀 id, 바이트 수, 스트림 수, 시각, 지속 시간뿐(`relay/src/log.ts`가 ip·path·host·url·headers 이름의 필드를 버리고, 시험이 로그 전체에서 IP·경로·호스트가 없는지 확인). 레지스트리에도 IP·이메일 열이 없다. 등록 횟수 제한(IP당 시간당 10회)은 메모리에만.
- **재시작 보류(hold)**: 팀이 붙어 있지 않을 때 요청은 최대 5초 기다린다 — 중계가 시작한 지 5초 안이거나, 팀이 끊긴 지 5초 안이거나, 붙어 있지만 모든 연결이 점검 중일 때만. 한 번도 안 붙은 팀은 바로 503.
- **멈춘 스트림 점검(stall probe)**: 응답 머리를 5초 넘게 기다리는 스트림이 있고 그 연결에서 5초 동안 아무것도 안 왔으면 PING, 10초 안에 아무 것도 안 오면 그 연결을 4008로 끊고(그 위 스트림은 502) 새 스트림을 주지 않는다. 45초 무응답 감지보다 훨씬 빨리 멈춘 팀 서버를 알아챈다(t5b: 약 4초).
- **응답 시간 제한 100초는 요청 본문이 끝난 뒤부터**(느린 업로드가 504가 되지 않게). Cloudflare 524(100초)와 맞췄다.
- **새 인스턴스 알림은 진짜 다른 서버가 살아 있었을 때만**: 같은 키로 새 인스턴스가 붙을 때 이전 인스턴스가 최근 25초 안에 무언가 보냈으면(살아 있는 다른 서버) 양쪽에 EVENT `instance_replaced`를 보내 owner·관리자에게 알린다. 팀 서버가 재시작하면서 남은 반쯤 죽은 연결을 대체하는 평범한 경우에는 알리지 않는다. 다른 키로 붙으려는 시도는 4003 + 연결된 팀에 `key_rejected`(1분에 한 번).
- **팀 서버 쪽 상태 저장**: 개인 키는 `<data>/relay/team-key.pem`(600, 폴더 700), 등록 정보는 마이그레이션 `600_f_relay.sql`의 `relay_registrations`(중계 API 주소별), 연결 기록은 `relay_events`(30일, 진단 화면용). 복구 코드는 한 번만: `<data>/relay/recovery-code.txt`(600)와 로그 — 화면에 보여 주고 지우는 일은 G/A의 관리 화면 몫.
- **등록은 처음 시작할 때 자동**(설정 `relay.url` + `relay.teamName`, 환경 변수 `MYCEL_RELAY_URL`·`MYCEL_RELAY_TEAM`). 이름이 이미 있음·예약어·형식 오류는 다시 시도하지 않고 상태 `not_registered`(+detail)로 보여 준다. 중계에 닿지 않으면 5초부터 최대 5분 간격으로 다시 시도. 개발 모드에서 이름을 안 주면 `myteam`.
- **레지스트리 API의 서명**: `Authorization: MycelRelay team=<id>, ts=<ms>, sig=<b64>`, 서명 문자열 `mycel-relay-api-v1\nMETHOD\npath\nts\nsha256(body)`(±60초). 등록은 키 소유 서명 + 작업 증명(기본 20비트, 개발 8비트). 키를 잃었을 때는 복구 코드로 키만 바꿀 수 있다(새 키가 회전 문자열에 서명해야 함). 바꾸면 옛 키의 연결은 4003으로 끊긴다.
- **예약어**: 지금 treesoop.com에 있는 레코드(www, 확인함) + relay·releases·api·mail 등 서비스 이름 + 공식처럼 보이는 이름(admin, support, treesoop, mycel, claude, openai …). 운영자가 `RELAY_RESERVED`로 더하거나 `node relay/src/main.ts block <이름>`으로 막는다.
- **중계 실행 환경**: Node 25(`node:http` + `ws` 8.18.0, 레지스트리는 `node:sqlite`). 같은 코드가 Bun에서도 돌아서 단위 시험은 Bun 안에서(bun:sqlite) 돌리고, 실제 런타임 차이가 중요한 시험(t1–t9)은 Node 프로세스로 띄운다. 공용 프로토콜 파일은 Node가 바로 읽도록 `.ts` 확장자 import와 지울 수 있는 TypeScript만 쓴다.
- **Bun 쪽 팀 서버의 송신 버퍼**: Bun 클라이언트 WebSocket은 `bufferedAmount`가 늘 0이라(REPORT) 팀 서버 쪽 다중화기는 스트림 창(256KB)으로만 메모리가 묶인다. 스트림마다 최대 창 하나 + 앱이 내놓은 조각 하나.
- **검수에서 고친 것(2026-10-21)**: 이 아래는 모두 시험(`tests/relay/f-hardening.test.ts`, `tests/unit/f-mux.test.ts` "Mux hardening", `f-relay-pages`, `f-relay-app` 복구)이 있다.
  - 팀 서버가 받을 수 없는 요청(절대 형식·`*` 대상, 헤더 257개 이상, 32KB 넘는 머리)은 중계가 OPEN 전에 검사해 400으로 답한다. 이전에는 요청 하나로 팀의 제어 연결이 4004로 끊겨 그 위의 모든 대화·다운로드가 같이 끊겼다(누구나 반복 가능). 팀 서버 쪽도 잘못된 OPEN은 그 스트림만 RST한다.
  - 중계가 큐에 쌓는 제어 프레임에 상한: PING에는 보내지 않은 PONG이 하나 있으면 더 답하지 않고, 읽지 않는 상대 때문에 제어 큐가 24MB를 넘으면 연결을 끊는다. 팀 서버 하나가 읽지 않으면서 PING을 쏟아 중계를 1.6GB까지 키울 수 있었다. 팀 서버가 보낸 OPEN은 연결 오류. RESPONSE 전에 온 DATA, WebSocket 닫기 조각 뒤의 DATA는 그 스트림을 RST.
  - 요청 본문이 60초(`RELAY_BODY_IDLE_MS`) 동안 오지 않으면 408로 끊는다(느린 업로드가 팀 스트림을 영원히 잡지 않게. 팀 서버 창을 기다리는 시간은 세지 않음). 팀 서버가 본문을 다 읽기 전에 답하면(401·413 등) 답을 끝까지 보낸 뒤 그 연결은 keep-alive를 끊고, 팀 서버는 END 뒤에 RST로 남은 업로드를 멈춘다. 이전에는 스트림이 남고, 업로드를 멈춘 클라이언트(Bun fetch)가 같은 연결로 보낸 다음 요청이 멈췄다.
  - 팀 서버의 Set-Cookie에서 Domain 속성을 지운다(모든 팀 주소가 같은 상위 도메인을 쓰므로 한 팀이 다른 팀들의 쿠키를 심지 못하게. 앱 쿠키는 원래 `__Host-`). 1xx 응답 머리는 HTTP 스트림에서 프로토콜 오류(502).
  - 제어 연결은 메시지 256KB 상한의 별도 WebSocket 서버로 받는다(인증 전 연결이 4MB 메시지를 버퍼링하지 못하게). 요청·업그레이드 처리기의 예외는 잡아서 기록(오류 코드만)하고, 처리되지 않은 rejection으로 중계가 죽지 않는다. 등록 횟수 제한 표는 IP 5만 개까지.
  - 팀 서버 런타임이 거부하는 헤더(비ASCII 값)는 500 대신 400.
  - 복구 코드 흐름: DB에 다른 키로 한 등록이 있으면(다른 맥으로 복원, 키 파일 분실) 이름을 다시 등록하려다 "name taken"이 되지 않고 `not_registered` + detail `recovery_needed`로 멈춘다. `ctx.services.relay.recover(code, teamId?)`가 복구 코드로 키를 바꾸고 바로 연결한다(`RelayStatusProvider`에 선택 메서드로 추가, G의 owner 화면용).

## G installer-ops (설치·업데이트·백업·진단·메뉴바, 2026-10-21)

- **설치 스크립트 = .pkg postinstall이 할 일**(`scripts/install-macos.sh`, 다시 실행해도 같은 결과). 서명된 .pkg로 감싸는 것은 Apple 인증서가 생긴 뒤(막힘 목록). 시험 설치는 `--id mycel-test`로 실제 설치와 폴더·계정·LaunchDaemon 이름이 겹치지 않는다(`tests/install/g-macos-install.ts`, root로 실행, 가짜 엔진).
- **역할 계정은 `sysadminctl -roleAccount`가 아니라 `dscl`로 만든다.** macOS 26.3.1에서 root가 무인으로 sysadminctl을 부르니 `-UID 450`을 무시하고 502(사진·암호 정책이 있는 일반 사용자)로 만들었고, 이어진 변경이 아무도 답할 수 없는 승인을 기다리며 270초씩 멈췄다. 새 레코드에 한 번에 속성을 넣는 dscl은 즉시 끝난다.
- **이미 있는 계정은 읽어서 확인만 하고 고치지 않는다.** macOS 26은 기존 사용자 레코드의 변경·삭제를 로그인한 관리자에게 승인받는다. 무인으로 하면 약 5분 멈춘 뒤 실패하고(-14987), 그 레코드는 재시동 전까지 바뀌지 않는다. LaunchDaemon 안에서 하면 바로 권한 오류. 그래서 제거 스크립트는 계정을 먼저 잠그고(셸 /usr/bin/false, 암호 없음, `;DisabledUser;`) 시간 제한을 두고 삭제를 시도하며, 못 지운 계정은 남은 항목으로 알려 준다. 실제 제품에서는 메뉴바 앱이 "설치 되돌리기"를 관리자 권한으로 실행하므로 owner가 승인 창을 본다.
- **Full Disk Access가 필요한 단계**: `/var/at/cron.deny`·`at.deny` 쓰기와 `tmutil addexclusion -p`. .pkg의 postinstall은 이 권한을 가진 설치기에서 돌지만 터미널에서는 승인 창(무인이면 멈춤) 또는 거부가 된다. 설치 스크립트는 이 단계에 시간 제한을 두고 경고로 남기며, 진단 화면이 cron.deny·at.deny와 Time Machine 제외를 따로 확인한다. crontab·at 실행은 엔진 샌드박스(실행 파일은 엔진 폴더만)가 이미 막는다.
- **실행기는 launchd 소켓 활성화 대신 스스로 `run-launcher/launcher.sock`을 만든다**(폴더 `_axagent:_axserver 750`, 소켓 0660 그룹 `_axserver`). 설계의 root 소유 폴더 + `launch_activate_socket`은 cgo가 필요해 다음 단계로 미뤘다. 엔진은 샌드박스 때문에 이 폴더에 닿지 못한다. 실행기는 서버 uid가 아닌 연결을 거부한다(root·엔진 계정으로 시험).
- **실행기 시작 때 `kill(-1, SIGKILL)`을 쓰지 않는다.** macOS에서는 자기 자신도 죽어서 LaunchDaemon이 매번 시작 직후 SIGKILL로 끝났다(설치 시험에서 발견). 같은 uid의 다른 프로세스를 목록으로 찾아 하나씩 죽인다.
- **엔진 샌드박스(`scripts/macos/engine.sb`)**: 기본 거부, 그 턴의 채팅 폴더(HOME·TMPDIR 포함)·엔진 폴더·다리·시스템 라이브러리·도구 소켓·`localhost:<프록시 포트>`만 허용. `/tmp`·`/private/var/tmp`·`/Users`·`/Volumes`·다른 채팅 폴더·셸 실행은 거부. 실행기 `--sandbox-profile`이 `sandbox-exec`로 감싼다(exec하므로 pid·세션 id 그대로). `LOCAL_LOGIN=1`(개발·owner 로그인)이면 `~/.claude`·`~/.codex`·로그인 키체인·직접 HTTPS를 더 연다. 이 구성에서 실제 `claude -p` 1턴과 `claude auth status`가 동작했다.
- **pf**: `com.apple/250.<id>` anchor에 `pass out quick proto tcp to 127.0.0.1 port <proxy> user <engine>` + `block drop out quick user <engine>`. 루프백에서도 user 매치가 동작했다(다른 localhost 포트·서버 API·사무실 게이트웨이·1.1.1.1 모두 차단, 서버 계정은 영향 없음). **IPv6 루프백은 연결 직후부터만 막힌다**: 맥 pf가 IPv6 SYN에서는 소켓 주인을 못 찾아 `connect()`는 성공하지만 그 뒤 패킷이 모두 버려져 데이터가 오가지 않는다(시험은 연결이 아니라 데이터 왕복으로 판정). 샌드박스가 ::1도 막으므로 두 겹 모두 유지된다. pf-load는 부팅마다 참조 하나를 잡고 토큰을 `run/pf.token`에 적어 제거 때 그 참조만 푼다(시험 전후 pf 상태 동일 확인).
- **부트스트랩(Go, `native/cmd/mycel-bootstrap`)**: 서버 LaunchDaemon은 서버가 아니라 이것을 띄운다. `app/current`의 manifest(sha256)를 확인하고(릴리스 키가 생기면 Ed25519 서명도, 그전에는 `--allow-unsigned`로 무결성만), 대기 중 업데이트가 120초 안에 `/api/health`에 그 버전으로 답하지 않거나 3번 죽으면 이전 버전으로 되돌린다. 평소 5분 안에 5번 넘게 죽으면 1→2→…60초 간격.
- **번들 형식은 tar.gz 대신 tar.zst**(우리 스트리밍 tar + node:zlib zstd, 설치·업데이트 모두 우리 코드로 푼다). 서버는 `bun build`로 한 파일(`server/src/main.js`)과 관리 CLI(`admin.js`), 버전은 빌드 때 넣는다.
- **백업**: DB는 VACUUM INTO(자식 bun 프로세스에서, 서버 이벤트 루프를 막지 않게) → `data/backups/<id>.sqlite`, 팀 폴더는 `.system/backups/<id>/team.tar.zst` + manifest + deleted 목록 + 폴더 목록(`dirs.json`). 7일마다 전체, 그 사이는 크기·수정 시각이 바뀐 파일만(폴더 항목은 매번 모두 넣는다: 빈 새 폴더가 복원에서 빠지지 않게. 복원은 `dirs.json`에 없는 폴더를 지우고 있어야 할 폴더가 없으면 실패). 14일 보관, 남는 백업이 기대는 이전 백업은 지우지 않는다. 설계서의 "날짜별 cp -c 사본" 대신 이 방식을 쓴 이유: 작업 지시(목록 비교 tar+zstd)와 스파이크 B 결과, APFS가 아닌 볼륨에서도 같은 동작.
- **API 복원은 DB만**(설계 6번 탭). 확인한 사본을 `data/restore-staged.db`에 두고 서버가 다음 시작 때 DB를 열기 전에 바꾼다(`main.ts`의 `applyPendingRestore`). 이전 DB는 `data/backups/before-restore-*`에 남긴다. 다른 맥으로 옮기기·외장 디스크 보관은 관리 CLI의 암호 걸린 archive(age) → `restore-archive`(임시 폴더에 풀고 전부 성공했을 때만 새 폴더로).
- **내보내기**: 대화·메모리는 요청한 owner 본인 것만(관리자도 남의 대화를 볼 수 없다는 원칙), 파일은 팀 폴더에서 `.system/`·이전 내보내기·**다른 사람의 `users/<id>/`**를 뺀 것(6번 탭 '내보내기'; owner 본인 폴더는 넣는다). 항목은 쓰는 동안 하나씩 만들어 대화가 많아도 메모리에 한꺼번에 올리지 않는다. 결과 위치는 공유 계약(`shared/src/api/system.ts`)대로 `users/<owner>/exports/`이다(설계서는 `data/exports/<jobId>.zip` + 24시간 삭제 + `GET /api/jobs/:id/download`; C의 다운로드 엔드포인트가 생기면 옮긴다).
- **진단 문구는 ko/en/id**(요청자 언어). 메뉴바용 `status/status.json`은 30초마다 쓰고 개인정보(이름·대화)를 넣지 않는다. 엔진 로그인 확인은 local-login이면 `claude auth status`·`codex login status`(이메일은 버림), 역할 계정 모드면 `secrets/claude-oauth-token` 유무.
- **로그 폴더**: `/Library/Logs/<id>`와 `crash/`는 root:wheel 755(launchd·newsyslog가 root로 일하는 경로에 역할 계정 소유 폴더가 끼면 링크를 심어 root 쓰기를 돌릴 수 있다; 755인 이유는 실행기의 launchd 출력 파일을 엔진 계정 권한으로 열기 때문, 750이면 EX_CONFIG). 서버 로그와 update.log는 `server/`(server:admin 750). 메뉴바 앱은 로그 폴더를 status.json이 아니라 고정 경로로 Finder에 보여 준다(열지 않는다).
- **root가 역할 계정 폴더를 다루는 규칙**(검수에서 고침): 설치 스크립트는 다시 실행(복구)할 때 먼저 서버·실행기 데몬을 내리고 두 계정의 프로세스를 모두 끝낸다. 설치 폴더 아래 경로는 모든 구성 요소가 심볼릭 링크가 아닌지 확인하고(`nolink`), 서버 소유 폴더에 놓는 파일은 root 전용 `$BASE/.install-tmp`에서 소유자·모드를 정한 뒤 `mv -h`로 바꿔 넣는다(심은 링크·하드 링크를 따라가지 않음, `scripts/macos/safe-fs.sh`). 설정 파일을 쓰는 bun은 `app/current`(서버가 바꿀 수 있음)가 아니라 설치하는 번들의 bun이다. 버전 폴더는 늘 새로 복사한 뒤에만 `chown -R`한다(서버가 넣은 하드 링크가 root chown으로 넘어가지 않게). 제거 스크립트는 남기는 데이터에서 폴더와 링크 수 1인 파일만 root로 바꾼다. pf-load는 `run/pf.json`(root 폴더)에 임시 파일 + rename으로 쓰고, 서버 소유 `status/`에는 쓰지 않는다.
- **메뉴바 앱은 status.json을 믿지 않는다**: 서버 계정이 쓰는 파일이고 앱은 로그인한 관리자로 돈다. 웹 주소는 http(s)만 열고, 상태 확인 주소는 127.0.0.1/localhost만 쓰며, 로그 폴더는 고정 경로.
- **아직 강제하지 않는 것은 화면에서 약속하지 않는다**: 방화벽이 꺼졌을 때 새 질문 거부, 디스크 '읽기 전용' 단계는 턴·파일 쓰기 경로(B·A)에 아직 없다. 진단·메뉴바 문구는 "실패할 수 있음/복구 필요"로만 말한다(후속 작업 목록).
- **연결 방식 변경**은 server.json의 `relay.url`에 저장하고 재시작 뒤 적용. Cloudflare·Tailscale은 이번 버전에서 고를 수 없다(409와 안내).

# D web (웹 클라이언트, 2026-10-21)

- **Saram `web/`(d315378)과 chat-proto에서 코드를 복사해 가져왔다**(마크다운 보정·KaTeX·Mermaid, 아티팩트 패널, 파일 미리보기, 녹음, 브라우저 패널). Supabase·Saram 팀 기능(업무·회의·승인·코드 변경 모드)은 버렸고, 문구는 모두 번역 키(ko 원본, en, id)로 옮겼다. 상태 관리는 zustand.
- **아티팩트·HTML/SVG 미리보기는 설계서대로 `sandbox="allow-scripts"` 프레임이 팀 서버의 고정 받개 문서 `GET /sandbox/frame?v=<빌드>`를 연다**(srcdoc·blob: 아님: 둘 다 앱 CSP를 물려받아 앱 CSP를 풀어야 했다). 받개 응답 CSP는 `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' data: blob: <서버>/vendor/; … connect-src 'none'; … frame-ancestors <서버>`이고 `<서버>`는 요청의 Host(https·http 둘 다 적음: TLS가 서버 앞에서 끝날 수 있음). 받개는 "ready"를 보내고 부모(event.source === parent)가 postMessage로 넘긴 문서 하나를 `document.open/write`로 자기 위에 쓴다(문서는 응답 CSP를 그대로 가짐). 부모도 그 프레임 창에서 온 메시지만 받는다. 화면이 AI가 쓴 문서를 통째로 다시 감싸서(`<!doctype><html><head>CSP…</head><body>원문`) 같은 정책의 meta CSP가 두 번째 겹으로 맨 앞에 오고, AI의 `<head>`·CSP·`<base>`는 body 안으로 밀려나 무시된다. 모든 페이지에 붙는 `X-Frame-Options: DENY`(기반 미들웨어)는 `frame-ancestors`가 있으면 브라우저가 무시한다(Chromium·WebKit에서 확인, e2e 목 서버도 같은 헤더를 붙임). React 아티팩트는 부모 화면에서 sucrase로 변환하고 `data:` 모듈로 실행('unsafe-eval' 없음). 라이브러리는 `web/scripts/build-vendor.ts`가 `dist/vendor/`에 번들(React 하나를 모든 항목이 공유)하고 서버가 `/vendor/`에서 CORS `*`로 준다(불투명 출처 프레임의 모듈 스크립트는 CORS가 필요). XML 미리보기는 문서로 그리지 않고 색칠한 텍스트로만 보인다(더 안전).
- **앱 화면 CSP는 설계서대로 `script-src 'self'`(+ `'wasm-unsafe-eval'`)**: 인라인·data:·blob: 스크립트와 eval 없음, `frame-src 'self'`, `worker-src 'self'`, `base-uri 'none'`. 답변·파일 이름·Office 미리보기가 그려지는 본 화면의 XSS 마지막 방어선이다. `'wasm-unsafe-eval'`은 큰 업로드의 sha256(hash-wasm, JavaScript eval은 아님), `connect-src blob:`은 pdf.js 워커가 미리보기 blob을 읽는 데 필요(둘 다 e2e에서 CSP 위반으로 발견). `img-src 'self' data: blob:`이라 답변 속 외부 이미지는 브라우저 수준에서도 막히고, 화면은 "외부 이미지 · 호스트" 카드(누르면 새 탭)로 보인다. 프레임이 다른 곳으로 이동하면(`frame-src 'self'`가 막음) 세 번째 load 또는 쓰인 문서의 pagehide "leaving" 신호로 알아채 about:blank로 되돌리고 안내한다.
- **Office 미리보기는 본 화면에 그려지므로**: docx-preview의 `renderAltChunks`를 끈다(기본값은 문서 속 HTML 조각을 sandbox 없는 srcdoc iframe으로 그려 같은 출처에서 스크립트가 돈다). 그려진 문서(docx·pptx·xlsx) 안의 링크는 절대 http(s)만 남기고(javascript:·data:·상대 경로는 링크에서 뺌, `#책갈피`는 미리보기 안에서 스크롤) 누르면 묻고 새 창(noopener)으로 연다(`web/src/lib/safeLinks.ts`, 라이브러리가 나중에 그리는 것도 MutationObserver로). 웹 검색 결과 출처도 http(s)만 링크로 만든다. 미리보기 한도는 PDF·Office 50MB, 이미지 20MB, 텍스트류는 앞 2MB만 읽는다(Content-Length가 없어도 읽는 도중 끊음).
- **정적 제공 코드는 `server/src/routes/web-static.ts`로 분리**(라우트 모듈 `web.ts`가 다시 내보냄). 웹 목 서버가 서버 컨텍스트 없이 같은 함수로 빌드를 제공해, e2e가 실제 운영 헤더(CSP 등)로 돈다. `<data>/downloads/`(index.json + 설치 파일)를 `/downloads/`로 제공한다(설정 > 앱의 데스크톱 앱 내려받기). 계약 밖 경로는 모두 `GET *` 안에서 처리하므로 레지스트리 규칙은 그대로다.
- **서비스 워커는 해시 붙은 파일(`/assets/*`, `/vendor/chunk-*`)만 캐시**한다. `/vendor/react.js` 같은 진입 파일은 이름이 고정이라 캐시하지 않고(서버도 `no-cache`) 버전이 바뀌면 바로 따라간다.
- **버전 불일치**: 계약의 `hello`에 `webBuild`·`bootId`가 아직 없어서, 처음 받은 `serverVersion`과 다른 값이 오면 "새 버전이 준비됐어요 [새로 고침]"을 띄우고, 스트리밍·업로드·녹음·입력 중인 글이 없을 때 60초마다 확인해 스스로 새로 고친다. epoch가 바뀌면 `after`를 믿지 않고 REST로 다시 불러온다.
- **WebSocket 클라이언트**: `hello` 전에는 열림으로 치지 않고, 끊긴 동안 보낸 `browser.ack/result`는 보관했다 다시 보낸다. 20초마다 앱 수준 ping, 10초 안에 pong이 없으면 죽은 연결로 보고 다시 붙는다(중계 연결이 조용히 멈추는 경우). 4409(같은 창 id가 다른 곳에서 연결: 탭 복제 시 sessionStorage가 복사됨)는 새 창 id로 다시 붙는다.
- **보내기**: 메시지를 바로 "보내는 중"으로 보이고, 보이는 마지막 메시지를 parentId로 보낸다(아직 불러오지 않은 채팅이면 parentId를 빼서 서버의 활성 끝에 붙인다. null은 맨 위 새 대화). 네트워크 오류면 같은 `clientMessageId`로 30초까지 다시 보낸다(서버가 중복을 막음). 실패하면 "보내지 못했어요 [다시 보내기]". POST 응답보다 먼저 온 `message.delta/step/done`은 보관했다가 메시지가 생기면 적용한다(이 경우 대기열 위치는 표시하지 않음). 보관은 메시지 50개·메시지당 2000개까지, 넘으면 REST로 다시 불러온다. 끊긴 동안 쌓는 WebSocket 프레임도 200개·16MB까지.
- **이 브라우저에 남기는 것**: 보내지 않은 글(사람별 키 `mycel.draft:<user>:<채팅>`, 같은 컴퓨터의 다음 사람에게 보이지 않음), 끝나지 않은 조각 업로드 세션(최대 50개). 로그아웃하면 둘 다 지운다.
- **첨부는 고르는 즉시 올린다**(새 채팅이면 그때 채팅을 만든다). 8MB 이하는 한 번에, 넘으면 조각 업로드(8MB, 브라우저에서 sha256을 조각씩 계산). 조각 세션은 파일 지문(이름·크기·수정 시각·대상)으로 localStorage에 기억해 새로 고침 뒤 같은 파일을 다시 고르면 서버에 없는 조각부터 이어 보낸다. 5xx·네트워크 오류는 재시도하고, 네트워크가 끊겼던 조각은 다시 보내기 전에 서버에 받았는지 묻는다.
- **계약에 없는 기능은 계약으로 대신했다**: 채팅 검색은 `GET /api/chats?q=`(설계서의 `/api/search` 없음), 아티팩트 "팀 폴더에 저장"은 `PUT /api/files/content`(baseSha256 null → 같은 파일이 있으면 서버가 충돌 사본), "이 파일로 채팅 시작"은 새 채팅 입력창에 `` `경로` 파일을 읽고 `` 를 미리 채움(팀 파일을 첨부로 넘기는 필드가 없음). 모델 목록은 관리자만 볼 수 있는 `/api/admin/engines`에서만 오므로 팀원은 엔진만 고르고 모델은 기본값.
- **데스크톱 다리(component E와의 약속)**: `window.mycelDesktop = { version, pane: {...}, browser: { call(chatId, tool, input, callId), cancel(callId), endTurn(chatId) } }`(Saram `saramDesktop`과 같은 모양 + callId·cancel). 웹은 `browser.call`을 받으면 `browser.ack`를 보내고 이 함수로 실행해 `browser.result`를 돌려준다. 앱 안 브라우저가 없는 창(웹·PWA)은 바로 "이 창에는 앱 안 브라우저가 없다" 오류 결과를 돌려줘 턴이 시간 초과까지 기다리지 않게 한다. 형식은 `web/src/lib/desktop.ts`.
- **접근성**: 모달은 초점을 가두고(겹친 모달은 맨 위만 Esc·Tab·초점 처리), 닫으면 원래 자리로. 스트리밍 글자에는 aria-live를 달지 않고 숨은 status 영역이 "답변을 만드는 중 → 답변 완료"만 알린다. e2e에서 axe-core(WCAG 2.2 AA 태그)로 로그인·홈·채팅·파일·관리자·설정을 라이트·다크 둘 다 검사한다.
- **휴대폰**: 768px 미만에서 사이드바는 서랍, 오른쪽 패널은 전체 화면 시트. iOS Safari는 키보드가 열려도 레이아웃 뷰포트를 줄이지 않아 `visualViewport` 높이를 `--app-h`로 따라간다.
- **시험**: `web/test/unit`(bun test, 90개: 스트림 리듀서·WebSocket 클라이언트(가짜 소켓·타이머)·업로드·마크다운 규칙·아티팩트 CSP·번역 키·스토어), `tests/unit/d-web.test.ts`(서버 정적 제공 헤더·경로 탈출), `web/test/e2e`(Playwright 40개 남짓, 계약을 그대로 검사하는 목 서버 + 실제 `serveWeb`). 목 서버 포트 19143.

## E — 데스크톱 앱 (2026-10-21)

- **브라우저 명령은 웹 화면의 WebSocket으로 받아 preload 다리로 넘긴다.** `browser.call`은 그 턴을 보낸 창(windowId)으로 오고, 그 창의 WebSocket은 웹 화면(D)이 연다. 데스크톱 메인 프로세스가 따로 WebSocket을 열면 같은 windowId가 둘이 되어 4409로 서로 밀어낸다. 그래서 웹 화면은 `shared/src/desktop-bridge.ts`의 `createBrowserRelay`로 `browser.ack` → `window.mycelDesktop.browser.run(call)` → `browser.result`만 하면 된다. 같은 callId는 웹 쪽 relay와 데스크톱 pane 양쪽에서 한 번만 실행한다(재연결 뒤 재전송 대비).
- **사이트 허용·사내망 확인 창, "AI가 사용 중" 표시는 데스크톱 자체 화면(브라우저 패널 도구 막대)에 둔다.** 웹 화면에 두면 중계·Cloudflare에서 바뀐 화면이 사람 대신 "허용"을 누를 수 있다(5번 탭: 변조된 화면이 보내는 명령은 못 막는다). 명령은 보낼 수 있어도 허용은 사람만 한다. 그래서 브라우저 패널은 데스크톱이 직접 배치하는 오른쪽 분할 영역이다(웹 화면이 자리를 알려 주는 Saram 방식 대신). 웹은 `pane.open/close/toggle/onState`만 쓴다.
- **"이번만 허용"은 턴 단위(`turnId`)다.** Saram은 채팅 단위로 턴이 끝날 때 지웠는데, 이제 모든 호출에 turnId가 있어 그대로 키로 쓴다. "항상"은 팀마다 `<userData>/teams/<id>/permissions.json`.
- **사내망(사설·링크로컬·CGNAT·ULA·멀티캐스트, IPv4 매핑·NAT64·6to4·Teredo 안의 IPv4 포함, `*.local`·`*.localhost`·점 없는 이름 등)은 사이트 허용과 따로 묻는다**(루프백·팀 주소는 묻지 않고 늘 막는다, 아래). example.com을 공개 사이트로 허용했어도 DNS가 사내 주소를 가리키면 다시 묻는다. 주 프레임 이동(리다이렉트 포함)은 묻고, 하위 요청(fetch·이미지·WebSocket·iframe)은 그 페이지 자체가 허용된 사내 페이지가 아니면 막는다. 사람이 주소창에 직접 친 주소는 묻지 않는다. 남는 위험: Chromium이 연결할 때 DNS를 다시 풀기 때문에 그 사이 답이 바뀌는 재바인딩은 미리 못 막는다 → 문서 응답의 실제 IP(CDP `remoteIPAddress`)가 사내 주소이면 탭을 멈추는 사후 차단만 한다.
- **비밀번호 입력란 차단은 페이지가 바꿀 수 없는 격리 world에서 확인한다**(`executeJavaScriptInIsolatedWorld`). 클릭 지점·포커스 확인. ref로 가리키는 form_input은 페이지 world의 ref 표를 써야 해서 페이지가 속일 수 있다(그 페이지는 어차피 입력값을 읽을 수 있으므로 같은 등급의 남는 위험). 포커스가 교차 출처 iframe 안이면 하위 프레임을 각각 확인한다. Tab·Enter·Esc·화살표 키는 비밀번호 칸에서도 허용(입력이 아님).
- **AI가 운전 중일 때 페이지 대화상자(alert/confirm/prompt)는 자동 처리**: alert는 닫고 confirm·prompt는 취소, 내용은 콘솔 기록으로 AI가 읽는다. 대화상자가 열리면 CDP가 멈추기 때문. 사람이 쓸 때는 그대로 사람이 답한다.
- **아티팩트·미리보기 프레임의 RTCPeerConnection 제거는 CDP `Page.addScriptToEvaluateOnNewDocument` + 자동 연결(OOPIF)로 한다.** 프레임 단위 preload는 nodeIntegrationInSubFrames를 켜야 해서 쓰지 않는다. 최상위 프레임은 건드리지 않는다. 하위 프레임의 http(s) 이동은 팀 출처가 아니면 `will-frame-navigate`에서 막는다(srcdoc·blob·data는 허용).
- **사무실 직접 연결은 6번 탭 방식(쿠키 옮기기)을 따른다.** 5번 탭은 Bearer 토큰 + `onBeforeSendHeaders`, 6번 탭은 메인 프로세스가 세션 쿠키를 다른 출처에 넣는 방식이라 서로 다르다. 6번 탭 방식은 웹 코드 변경이 없고(토큰을 웹이 보지 않음) 이미지·다운로드·WebSocket이 그대로 쿠키로 인증된다. 쿠키는 팀 전용 partition의 쿠키 저장소에만 있어 safeStorage에 따로 두지 않는다. 디스크의 쿠키 암호화는 Electron 기본값이 꺼져 있으므로 패키징 때 `enableCookieEncryption` 퓨즈를 켠다(아래 퓨즈 항목; 서명 없는 빌드는 업데이트 뒤 macOS가 키체인 접근을 한 번 물을 수 있다). 직접 연결 정보는 `GET /api/connect-info`(중계 경로, 정식 TLS)로 받아 고정하고, LAN 주소마다 1초 안에 지문 고정 health 확인이 되면 직접, 아니면 팀 주소. 시작·창 포커스(30초 간격)·60초마다 다시 확인하고, 직접 주소에서 페이지 읽기가 실패하면(와이파이가 바뀜) 오프라인 화면 대신 바로 팀 주소로 다시 연다. 지문이 다르면 직접 연결을 멈추고 알림을 띄운 뒤 팀 주소로 돌아간다. Bonjour 탐색은 하지 않고 connect-info의 `lanHosts`를 쓴다(Node에 mDNS가 없어 의존성을 늘리지 않으려고).
- **앱 안 브라우저는 팀 주소·이 컴퓨터를 절대 열지 않는다**(5번 탭 "앱 안 브라우저 분리"). 이 앱이 아는 모든 팀의 주소(중계 주소, connect-info의 사무실 이름·IP), `localhost`·`*.localhost`·127.0.0.0/8·0.0.0.0/8·`::1`(IPv6 매핑 포함), DNS가 루프백을 답하는 이름, http(s)·ws(s)가 아닌 스킴은 사람이 묻는 창에서 허용해도 열 수 없다. AI 이동, 사람의 주소창, 리다이렉트, 하위 요청(net guard) 모두 같은 검사(`common/browser-block.ts`)이고, 문서 응답이 루프백에서 오면 탭을 멈춘다. AI가 `data:` 페이지를 여는 것도 막는다(사이트 허용 없이 다른 사이트를 iframe으로 띄워 찍을 수 있었다). 두 번째 방어선으로 앱 안 브라우저의 User-Agent 끝에 `IN_APP_BROWSER_UA_MARK`(`MycelBrowser/1`, shared)를 붙인다: 서버(A)는 이 표식이 있는 요청을 401로 거부한다. 표식 말고는 일반 Chrome처럼 보이게 둔다(Electron·앱 이름은 지움).
- **허용·거부 답은 `browser.result`에 실린다**("The user allowed shop.example for this turn." 같은 문장이 결과 맨 앞에). 서버 tool_events에 그대로 남는다. 읽기·스크린샷·스크립트 결과는, 도구가 도는 동안 페이지가 사람이 허용하지 않은 사이트로 옮겨 갔으면 버리고 오류로 돌려준다.
- **호출 마감(`deadline`)은 서버 시계로 읽는다.** 창이 팀 페이지를 열 때마다 `/api/health`의 `time`으로 시계 차이를 재서(2초 미만은 0) 마감을 비교한다. 컴퓨터 시계가 빠른 사람의 호출이 모두 "마감 지남"으로 버려지는 것을 막는다. 한 호출은 최대 30분.
- **재전송 대비로 기억하는 결과는 개수·크기·시간으로 제한한다**: 데스크톱 300개·64MB·15분, 웹 relay 200개·32MB(스크린샷이 커서).
- **"사무실 직접 연결/원격 연결" 표시는 창 제목과 다리(`connection.get/onChange`)로 준다.** 화면 오른쪽 아래에 데스크톱이 겹쳐 그리면 웹 화면의 버튼을 가린다. 웹(D)이 다리 값으로 오른쪽 아래에 보이면 된다.
- **팀마다 session partition 두 개**: `persist:team-<id>`(팀 화면), `persist:team-<id>-browser`(앱 안 브라우저). 팀 id는 주소가 아니라 무작위 값이라, 팀을 지웠다가 다시 추가하면 새 저장소로 시작한다. 지울 때 두 partition의 저장소·캐시와 허용 목록 파일을 지운다.
- **팀 주소 입력 규칙**: 점 없는 이름은 `<이름>.treesoop.com`(https), 주소에서 경로는 버리고 출처만 쓴다. http는 `localhost`·`*.localhost`·`127.x`·`[::1]`(개발)만. 추가하기 전에 `/api/health`가 계약 모양인지 확인한다. 이름은 로그인 뒤 `/api/me`의 팀 이름으로 바뀐다.
- **데스크톱 자체 화면은 `mycel-ui://app/`(표준·보안 스킴, CSP `script-src 'self'`)로 제공**하고 메모리 전용 partition을 쓴다. IPC는 채널마다 보낸 view를 확인한다(환영 화면 채널은 환영 view에서만, 패널 채널은 패널 view에서만, 다리 채널은 팀 화면 최상위 프레임 + 팀 출처에서만).
- **빌드는 Bun 번들러**(esbuild 의존성 없이). Bun이 Electron의 postinstall을 돌리지 않으므로(신뢰 목록 밖) 데스크톱의 build·test 스크립트가 처음 쓸 때 Electron 바이너리를 받는다. 저장소 전체 `bun install`은 Electron을 내려받지 않는다.
- **패키징된 앱은 Electron 퓨즈를 켠다**(`build.electronFuses`): `ELECTRON_RUN_AS_NODE`·`NODE_OPTIONS`·`--inspect` 무시, 쿠키 디스크 암호화, `app.asar`에서만 코드 읽기, file:// 특권 없음. 같은 사용자 권한의 다른 프로그램이 이 앱(마이크 권한을 가진)을 Node로 띄우거나 디버거를 붙이는 길을 막는다. 그래서 패키징 앱 시험은 Playwright 대신 프로세스로 띄우고 가짜 서버로 확인한다. Info.plist에 `NSLocalNetworkUsageDescription`(macOS 15+ 로컬 네트워크 권한, 사무실 직접 연결용)을 넣는다.
- **맥 빌드는 서명 없는 arm64 dmg**(`identity: null`). 서명·공증은 owner의 Apple 인증서가 필요하다. 껍데기 자동 업데이트(electron-updater)도 맥에서는 서명된 빌드가 필요해서 이번에는 넣지 않았다. 윈도우는 NSIS x64 설정만(서명 없음, `signAndEditExecutable: false`로 rcedit·wine 불필요).

## 통합 (main, 2026-10-21)

컴포넌트 A–G 브랜치를 A → C → B → F → G → D → E 순서로 main에 합쳤다. 합치면서 고친 이음매:

- **턴 도구**: C의 도구(make_file, share_file, artifact, web_fetch)는 C의 레지스트리(`tools/registry.ts`)에만 있었고, B의 채팅 턴은 `ctx.services.turnTools`만 본다. `registerCTools`가 각 C 도구를 `turnTools`에도 넣는다(레지스트리를 거쳐 입력 검사·오류 변환·감사 요약이 같다). 턴 도구 결과에 `summary`를 더해 C의 감사 문구가 `tool_events`에 남는다. 도구 묶음이 없는 stage 1 턴은 MCP 처리기가 레지스트리를 그대로 쓴다.
- **첨부**: C의 `Attachments`를 `ctx.services.attachments`로 설치했다(전에는 첨부가 있는 메시지가 모두 거절됐다).
- **files.changed는 C가 주인**: B와 C가 같은 쓰기를 두 번 알렸다. B의 발행은 C가 없을 때만 쓰는 대체 경로다.
- **disconnectSession**: 인터페이스는 `(sessionId, reason)`(A), B 구현은 `(userId, sessionId)`라 기기 하나 로그아웃이 아무 소켓도 닫지 않았다. 허브가 세션 id로 모든 사람에서 찾는다.
- **중계 WebSocket**: F의 `attachVirtual`과 B의 `attach`를 B의 `attach` 하나로 합쳤다(위 F 절).
- **Codex 실행 파일**: 실행기 허용 목록(context.ts)과 채팅 런타임(chat/engines.ts)이 Codex를 다르게 찾아 "is not allowed"로 모든 Codex 턴이 실패했다. `findCodexBin()` 하나로 찾는다. 실패한 엔진 시도는 실행기 종료 정보와 stderr 끝을 로그에 남긴다.
- **데스크톱 다리**: 웹은 Saram식 `window.mycelDesktop`(pane.setBounds 등)을 썼지만 E는 `shared/src/desktop-bridge.ts`의 `DesktopBridge`(창은 데스크톱이 그림, 사이트 질문도 데스크톱 UI)를 구현했다. 웹이 공유 계약을 쓰도록 바꿨다: 호출은 공유 `createBrowserRelay`로(재연결 뒤 다시 온 호출에 보관한 결과를 다시 보냄), 채팅 머리글의 브라우저 단추는 `pane.toggle()`, 데스크톱 안에서는 로그인·초대·재설정을 `client: 'desktop'`으로 보낸다(B는 desktop 세션의 턴에만 브라우저 도구를 준다).
- **웹 경로**: C의 공유 링크 `/files/view?path=…`와 A의 재설정 링크 `/reset-password/<token>` 화면을 웹에 더했다.
- **앱 안 브라우저 UA**: User-Agent에 `MycelBrowser/1`이 있으면 세션 미들웨어가 401(5번 탭 이중 방어, E가 요청).
- **X-Frame-Options**: CSP `frame-ancestors`로 액자 규칙을 정한 응답(`/sandbox/frame`)에는 DENY를 붙이지 않는다. `'none'`이거나 없으면 그대로 DENY.
- **시험 하네스**: 가짜 세션 서비스를 실제 모듈 *뒤에* 둔다(`init()`이 순서대로 돌아 A의 실제 서비스가 가짜를 덮었다).
- **@types/node**: 데스크톱이 Electron용 @types/node 24를 고정해 루트 typecheck가 두 판을 읽었다. 루트에 26.6.5를 고정했다.
- **개발 실행**: `bun run dev` = 서버(19100, 빌드된 웹 제공, local-login 엔진) + Node 25 중계(`http://demo.localhost:19161`), 데이터 `~/.team-ax-dev`. 개발 중계(`--dev`)는 `RELAY_DEV_NAMES`(기본 demo)를 내장 예약어에서 풀어 준다(운영 중계에는 없음).
- **Claude Code 2.1.305 고정**: 설치된 CLI가 스스로 올라갔고, 잠금 회귀 시험(실제 호출 1회)이 통과해 고정 버전을 올렸다.

## 통합 검증 (e2e-ui, 2026-10-21)

`tests/e2e-ui`(`bun run e2e:ui`)가 `bun run dev`(새 데이터 폴더 `tests/.work/e2e-ui/devhome`)를 띄우고 실제 브라우저와 실제 Electron 앱으로 시나리오 전체를 돈다: 첫 owner·언어·그룹·초대/직접 추가·폴더 규칙 → 업로드와 미리보기 → Alice(중계 경유)의 Claude 채팅(검색·요약, 스트리밍을 프레임 단위로 확인, KaTeX·Mermaid, make_file docx, HTML 아티팩트, finance 거부와 감사 기록, 수정·다시 생성·중지) → Bob의 Codex → 같은 파일 동시 수정(사람끼리, AI와 사람) → 중계를 죽였다 살리기 → 200MB 조각 업로드·다운로드 → 관리자 화면 → 데스크톱 앱의 브라우저 패널. 실제 엔진 호출은 실행 사이에도 세어(`engine-calls.json`) 한도를 넘지 않게 했다.

- **`bun run dev`는 중계가 죽으면 1.5초 뒤 다시 띄운다**(운영에서는 서비스 관리자가 하는 일). 그래야 "중계가 끊겼다가 돌아오는" 길을 dev에서 시험할 수 있다. 다른 프로세스가 죽으면 전처럼 모두 멈춘다.
- **파일 미리보기 패널에서 텍스트 파일을 고친다**(5번 탭 "텍스트 파일 고치기"). 웹에 편집 화면이 없어 `PUT /api/files/content`(기준 해시·충돌 사본)가 화면에서 닿지 않았다. 불러올 때의 sha256을 baseSha256으로 보내고, 충돌이면 사본을 패널에 연다. 2MB(미리보기 한도)를 넘는 파일은 고치지 않는다.
- **감사 화면의 AI 도구 항목에 결과를 보인다**: 실패면 "거부됨"(요약이 `-> denied`) 또는 "실패" 표시와 한 줄 요약. 전에는 다른 그룹 폴더를 읽으려다 거부된 것이 "read"로만 보였다. 개인 폴더 안 파일 이름은 감사에서 계속 `users/<id>/…`로 가린다(시험이 확인).
- **진단의 Claude 로그인 확인**: `claude auth status`를 최소 환경으로 돌릴 때 USER·LOGNAME이 없으면 macOS 키체인 항목을 못 찾아 "로그인되어 있지 않음"이라고 답했다(채팅은 잘 됨). 두 값을 넘긴다.
- **사용량 날짜는 서버 맥의 시간대**: 화면의 기간 입력이 UTC 날짜(toISOString)라 한국에서는 오전 9시 전까지 오늘 사용량이 빠졌다. 화면은 로컬 날짜, 서버의 날짜별 묶음도 UTC 날짜가 아니라 서버 시간대의 날짜로 JS에서 묶는다(SQLite `localtime`은 C 라이브러리의 시간대를 써서 `bun test`(JS는 UTC)와 달라질 수 있음).
- **비밀번호 거절 이유를 그 사람의 언어로**: 서버가 이유를 ko/en/id로 말하고, 웹은 서버의 구체적인 검증 문구를 그대로 보인다(전에는 일반 문구 + 영어 필드 설명).
- **메모리 상한 측정**: 200MB 다운로드를 중계로 최고 속도로 받으면 RSS가 잠깐 100MB 안팎 오른다(대부분 아직 거두지 않은 버퍼). 느린 수신자(초당 8MB)로 48MB를 읽는 동안에는 서버·중계 모두 10MB 안쪽으로만 늘어 역압이 실제로 걸린다. 시험은 둘 다 확인한다(빠를 때 200MB 미만, 느릴 때 64MB 미만).

## 보안 검토 (polish/0, 2026-10-21)

인증·세션·CSRF, 권한 함수와 파일 경로 입구(REST·도구), web_fetch, 아티팩트·CSP, 데스크톱, 중계, 설치, 비밀값을 다시 봤다. 고친 것:

- **공개 범위 확대 확인**(7번 탭 "공용 폴더를 거친 유출"): `chats.session_read_scope`(마이그레이션 202)에 모델 문맥에 들어간 출처를 모은다. read·grep 결과 파일마다 가장 가까운 규칙 폴더(`folders.id`, 없으면 `{type:'root'}`), `users/<id>/`(첨부 포함)는 `{type:'user'}`, 앱 안 브라우저 결과는 요청한 사람, 프로젝트 지침은 그 폴더. write·edit·make_file(source 파일 포함) 앞에서 대상 폴더를 읽을 수 있는 사람이 출처마다의 읽을 수 있는 사람보다 많으면 서버가 도구 호출 안에서 카드를 띄운다. 거절하면 쓰지 않고 감사 기록. 허용한 폴더는 그 턴에서 다시 묻지 않는다. 확인 자체가 실패하면 저장하지 않는다. **설계와 다른 점**: 다시 생성·수정으로 만든 가지도 채팅의 C를 그대로 쓴다(메시지별 `read_scope_snapshot` 없음, 더 묻는 쪽). 관리자의 '표시만' 설정과 파일 요약의 '공개 범위 넓어짐' 표시는 아직 없다.
- **서버가 띄운 확인 카드 표시**: web_fetch 주소·공개 범위·remember 확인은 `AskUserRequest.origin = 'server'`이고 화면은 "팀 서버의 안전 확인" 머리글로 그린다. AI의 ask_user는 이 값을 넣을 수 없다(입력 스키마에 없음).
- **API 응답에 `Cross-Origin-Resource-Policy: same-origin`**: 팀 주소는 모두 같은 사이트(`*.treesoop.com`)라 다른 팀 페이지의 `<img>`·`<video>`가 SameSite=Lax 쿠키를 싣고 이 팀의 API·다운로드를 불러올 수 있었다(내용은 못 읽어도 존재·크기·이미지 치수가 샌다).
- **사무실 공인 출구 IP**(7번 탭 "내부망 공격"): 중계의 핸드셰이크 응답 `AuthOk.seenIp`(제어 연결이 온 주소, 운영은 CF-Connecting-IP, 기록하지 않음)를 서버가 최근 8개까지 기억하고(`server/src/tools/egress.ts`) web_fetch가 모든 홉에서 거부한다. 서버가 시작된 뒤 아직 받은 적이 없으면(중계 없음·연결 전) 모든 web_fetch 주소에 확인 카드.
- **모델 프록시 전달 규칙**(7번 탭 "모델 프록시를 통한 외부 전송"): POST `/v1/messages`·`/v1/messages/count_tokens`(쿼리 `beta=true`만), `claude-*` 모델, 사용자 정의 도구 + `web_search_*` 서버 도구, 데이터가 본문에 든 블록만(이미지·문서의 url·file 출처, mcp_servers, container, 모르는 블록은 403 + `proxy.refused` 감사). 허용 모양은 Claude Code 2.1.305가 실제로 보내는 요청을 기록용 가짜 상위 서버로 잡아 정했다. 엔진 버전 피드 policy로 옮기는 것은 후속.
- 앞서 같은 가지에서: web_fetch URL 출처 규칙 ①②③(이 대화에 나온 주소만 바로, 그 밖은 카드, 쿼리 200자 초과는 카드), 서버 인터페이스의 on-link 대역 거부, 초대·재설정 웹 경로의 토큰을 요청 기록에서 가림.

확인했지만 고칠 것이 없던 것: 다른 팀원의 채팅·메시지·카드·아티팩트·메모리·프로젝트·업로드 세션을 id로 부르는 모든 엔드포인트(`tests/unit/p0-cross-user.test.ts`로 남김), CSRF(사용자 정의 헤더 + Origin), WebSocket Origin, 세션 쿠키 이름(https는 `__Host-sid`만), 다운로드의 inline 활성 형식 차단과 CSP sandbox, 아티팩트 수신 프레임 CSP, 데스크톱 IPC 발신자 확인·이동 차단·앱 안 브라우저 분리, 중계의 위조 가능 헤더 제거, 설치 스크립트의 링크 검사·계정 생성, 턴 토큰 전달(파일, argv·env 아님).

남은 것: web_fetch ③의 "이 채팅에서 읽은 파일 내용과 32자 겹침"과 ④ 관리자 허용 도메인, pf의 프록시 포트 선점 방어(받는 소켓 주인이 _axserver가 아니면 버림, root·pf로 시험 필요).

## 화면·UX 검수 (polish/2, 2026-10-21)

실제 dev 서버(local-login)와 목 서버에서 ko/en/id, 390px·1280px로 모든 화면을 돌려 보며 고친 것.

- **개발 모드 배너**(5번 탭): `/api/me`의 `server.dev`면 모든 화면 위에 닫을 수 없는 "개발 모드: OS 격리 없음" 배너. hello에 mode가 없어서 Me를 쓴다. 엔진의 샌드박스 여부("· 샌드박스 꺼짐")는 계약에 없어 넣지 않았다(dev에서는 늘 꺼짐이라 배너 문구가 이미 그 뜻).
- **주의가 필요한 채팅**: AI가 ask_user·사이트 카드로 답을 기다리는 채팅은 사이드바에 "답변 필요", 창이 숨어 있으면 탭 제목에 "(N) "(기다리는 질문 + 그사이 끝난 답변). 데이터는 웹이 WebSocket으로 받은 열린 요청이다(`GET /api/chats`에 pendingRequest·unread가 아직 없어 새로 고친 뒤에는 그 채팅을 열기 전까지 표시되지 않음, 후속).
- **사용 한도는 모든 모드에서 집행한다**(A의 "proxy 모드에서만" 결정을 바꿈): 관리자 화면이 구독 모드에서도 토큰 한도와 "사용 막기"를 보여 주는데 아무것도 막지 않았다. 다 쓴 block 한도는 보내기·수정·다시 생성을 대기열에 넣기 전에 `budget_exceeded`(429)로 막고, 다시 쓸 수 있는 시각을 그 사람의 언어로 말한다. USD 한도 0은 "금액 한도 없음"(전에는 0 ≥ 0이라 늘 초과였다). 설계 1번 탭의 5시간·주 단위와 턴 수 한도, 80% 안내, 설정 > 사용량은 아직 없다(후속).
- **복원은 로그인을 모두 끝낸다**: DB 복원이 백업 당시의 sessions를 되살려, 그 뒤 로그아웃·기기 해제·비활성화된 사람이 다시 로그인된 상태가 됐다. 바꿔 넣기 전에 준비된 사본의 sessions를 지운다. 복원 확인 문구는 DB만 되돌린다는 것(파일은 그대로, 버전 기록·휴지통에서)을 말한다.
- **서버가 데이터로 보내는 것은 웹이 문장으로 만든다**: access_changed 알림(폴더 목록), 감사 기록의 action id(`auth.login_failed` → "로그인 실패", 서버가 쓰는 action마다 문구가 있는지 단위 시험이 확인), 시스템 작업 진행 단계(`team folder` → "팀 폴더 보관 중", 서버 `stepText`).
- **보내지 못한 메시지에는 서버의 이유를 보인다**(ApiError의 message는 이미 그 사람의 언어). 네트워크 실패는 브라우저의 영어 문구라 보이지 않는다.
- **AI가 보는 시각**: 도구 결과의 시각은 UTC ISO라 모델이 그대로 옮겼다("2026-10-20 23:09 수정" → 서울 08:09). 지침의 시간 줄에 "도구 결과 시각은 UTC, 사람에게는 이 시간대로"를 더했다(실제 호출로 확인).
- 남은 것(후속): 알림(종 아이콘)·알림 목록은 계약에 없다. 삭제한 채팅·휴지통 보관 기간 문구("7일", "30일")는 설정값을 바꿔도 고정 숫자다(채팅에는 purgeAt이 없음). 비밀번호 규칙(10자) 위반은 아직 브라우저 기본 말풍선(브라우저 언어)으로 알린다.

## polish 가지 병합 (main, 2026-10-21)

polish/0(보안)·1(정확성)·2(화면·UX)·3(계약·데드 코드)을 이 순서로 main에 합쳤다.

- **충돌 정리**: 채팅 도구의 파일 문맥은 polish/1의 `livePrincipal()`(도구 호출마다 사람 정보를 다시 읽음)과 polish/0의 `person`(서버 확인 카드)을 함께 쓴다. polish/0의 공개 범위 확인(`confirmWidening`)도 저장할 때의 최신 사람 정보로 판단한다(비활성 계정이면 예외 → 저장하지 않음). polish/3이 옮긴 `tests/lib/stage1-runner.ts`는 polish/1의 UTF-8 줄 읽기(`Utf8Lines`)를 그대로 쓴다. 목 서버와 웹 e2e는 서버 안전 확인 카드(polish/0)와 새로고침 뒤 열린 카드 복구(polish/3)를 모두 가진다.
- **병합 뒤 고친 것**: polish/0이 더한 감사 action `proxy.refused`에 ko/en/id 문구가 없어 polish/2의 "모든 감사 action에 문구" 시험이 실패했다. 문구를 넣었다.
- 검증: typecheck, unit 917, web unit 99, relay(Node 25) 17, stage 1 fast, 웹 e2e(목) 56, 데스크톱 e2e 18, 실제 엔진 e2e-ui 14단계(Claude 8회·Codex 1회).
