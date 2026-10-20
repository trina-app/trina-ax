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
