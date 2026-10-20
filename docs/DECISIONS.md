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
- **이어가기 실패 처리**: 보관본이 없으면 새 세션 + DB 대화 기록을 메시지 앞에 붙인다(e2e T5로 확인). 보관본이 있는데 엔진이 "No conversation found"를 내면 같은 방식으로 1회 재시작한다.
- **사용량**: 프록시 모드에서는 프록시가 센 값이 기준이고, 엔진이 보고한 값은 프록시 기록이 없을 때만 적는다. 가격표는 대략값(코드에 표시).

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
