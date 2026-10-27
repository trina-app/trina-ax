# 작업 분담 (Stage 2+ 병렬 작업)

여러 에이전트가 같은 저장소(`main`)에서 동시에 일한다. 충돌을 없애는 원칙은 하나: **파일마다 주인이 하나**다.
남의 파일을 고쳐야 하면 고치지 말고, 자기 파일에 새로 만들거나(새 스키마 파일, 새 마이그레이션) 주인에게 맡긴다.
설계 기준은 설계서(Claude Docs, 탭 1–8)이고, 설계서에 없는 결정은 `docs/DECISIONS.md`에 적는다.

제품 표시 이름은 **Team AX**(`PRODUCT.displayName`), 코드 id는 `mycel`(`PRODUCT.id`, 폴더·소켓·환경 변수 `MYCEL_*`)이다.

## 1. 개발 서버 실행

```sh
bun install
bun run build:native        # Go 필요. 엔진 턴(도구 관문·실행기)을 쓸 때만
bun run dev:server          # http://127.0.0.1:19100, 파일 바뀌면 재시작 (bun --watch server/src/main.ts)
bun run dev                 # 통합 개발 실행: 서버(19100, 빌드된 웹 제공) + Node 25 중계(http://demo.localhost:19161), 데이터 ~/.team-ax-dev, --vite로 Vite 19140
```

- `bun run dev`의 데이터는 `~/.team-ax-dev`(`TEAM_AX_DEV_DIR`로 바꿈). `dev:server` 하나만 띄우면 데이터는 `.dev/`(git 무시): 팀 폴더 `.dev/team`, DB·세션 등 `.dev/data`. 지우면 처음 상태.
- 설정 파일은 선택: `.dev/server.json`(형식은 `server/src/app-config.ts`의 `AppConfigFile`). 환경 변수가 이긴다:
  `MYCEL_PORT`, `MYCEL_HOST`, `MYCEL_TEAM_ROOT`, `MYCEL_DATA_DIR`, `MYCEL_LOG_DIR`, `MYCEL_LOG_LEVEL`, `MYCEL_PUBLIC_ORIGINS`, `MYCEL_CONFIG`, `MYCEL_MODE`, `MYCEL_SETUP_TOKEN`, `MYCEL_WEB_DIST`.
- 사용자가 없으면 서버가 첫 설정 토큰을 만들고(`.dev/data/setup-token`) 로그에 찍는다. `POST /api/setup`(A가 구현)으로 팀과 owner를 만든다.
- 개발 모드 = 로컬 로그인(`engine.authMode: 'local-login'`): 엔진은 현재 사용자로, owner의 Claude Code 로그인·Codex 로그인으로 돈다. 모델 프록시 없음.
- 개발 모드에서는 모든 JSON 응답을 계약으로 검사한다(`validateResponses`). 계약과 다른 응답은 500 + 로그 `response does not match the contract`.

시험:

```sh
bun run typecheck
bun run test:unit           # tests/unit 전부 (엔진 실제 호출 없음)
bun run test:fuzz:fast      # 경로 퍼저(직접·소켓) + ReDoS
bun run test:stage1:fast    # 위 + 2만 파일 벤치 (도커·실제 엔진 제외)
bun run tests/linux/run.ts  # 리눅스 도커 작업 (native/bin/linux-<arch> 먼저 빌드)
```

CI(`.github/workflows/ci.yml`): typecheck(웹·데스크톱 포함), native 빌드 + go vet, unit, fast fuzz, 웹 단위 시험·빌드, Node 25 중계 시험, 리눅스 도커 작업. 실제 엔진 시험은 CI에서 돌지 않는다. 2026-10-21 현재 GitHub Actions 작업이 결제 문제로 아예 시작되지 않는다(README "Build and test").

## 2. 계약 (shared/src/api)

서버와 클라이언트가 같은 zod 스키마를 쓴다. `import { API, ApiClient, ... } from '@mycel/shared/api'`.

| 파일 | 내용 | 주인 |
|---|---|---|
| `common.ts` | 상수(쿠키 `__Host-sid`, CSRF 헤더 `x-mycel-csrf`, 창 헤더 `x-mycel-window`, 업로드 한도), `RelPath`, `Role`, `Locale`, `ErrorCode`/`ErrorStatus`, 오류 형식, 페이지(`?cursor=&limit=` → `{items, nextCursor}`) | 기반(공유) |
| `entities.ts` | 1번 탭 테이블의 API 모양: User, Group, Folder/FolderRule, Session, Invite, Project, Chat, Message(트리·branch), Attachment, Step, FileChangeSummary, Artifact, Memory, Turn, Job(+결과), FileEntry, FileVersion, TrashItem, UploadSession, EngineAccount, Budget, AuditEntry, TeamSettings | 기반(공유) |
| `endpoint.ts` | `endpoint()` 정의, 인증 수준, 타입 도우미, `buildPath` | 기반(공유) |
| `client.ts` | `ApiClient` (웹·데스크톱·시험용 타입 있는 호출, CSRF·창 헤더 자동) | 기반(공유) |
| `errors.ts` | 오류 코드별 기본 문구(ko/en/id), `Accept-Language` → 언어 | 기반(공유) |
| `auth.ts` | AUTH: setup, login/logout/password, me, 내 세션, 초대 정보·수락 | A |
| `admin.ts` | ADMIN: 사용자·초대·그룹·폴더 규칙(+미리보기)·엔진·예산·설정·사용량·감사 | A |
| `chats.ts` | CHATS: 채팅·메시지·중지·다시 생성·수정·가지 선택·ask_user 답·프로젝트 | B |
| `memories.ts` | MEMORIES | B |
| `ws.ts` | WebSocket 프로토콜 전부 | B |
| `browser.ts` | 브라우저 도구 이름, browser.call/result 모양, 롱폴링 대체 경로 | B (도구 입력 스키마는 E, 아래) |
| `files.ts` | FILES: 트리·내용·저장·다운로드·업로드·폴더·이동·삭제·기록·되돌리기·휴지통·첨부·조각 업로드 | C |
| `artifacts.ts` | ARTIFACTS | C |
| `jobs.ts` | JOBS: 조회·취소·받아쓰기 | C |
| `system.ts` | SYSTEM: health, 진단, 업데이트, 백업·복원·내보내기, 연결 방식 | G |
| `index.ts` | `API` 레지스트리(모든 그룹 합침) | 기반 — 새 그룹 파일을 만들 때만 한 줄 추가 |

규칙:
- 엔드포인트 하나 = `endpoint({ method, path, auth, owner, query?, body?, response, status?, summary })` 객체 하나. 키 이름으로 부른다(`API.sendMessage`).
- 인증 수준: `public` / `user` / `admin`(admin·owner) / `owner` / `owner-reauth`(owner + 본문 `password` 재확인: 업데이트·복원·연결 변경).
  `must_change_password`인 사람은 `allowWhilePasswordChange: true`인 엔드포인트만 쓸 수 있다.
- 오류는 항상 `{ error: { code, message, fields?, retryAfter?, requestId? } }`, `message`는 사용자 언어. "권한 없음"과 "없음"은 같은 `not_found`.
- 상태를 바꾸는 요청(쿠키 세션, 로그인·초대·설정 포함)은 `x-mycel-csrf: 1` 헤더 필수 + 다른 사이트 Origin 거부. Bearer 요청은 예외.
- id는 UUIDv7(`uuidv7()`), 단 `users.id`는 개인 폴더 이름과 같은 슬러그(`UserId`).
- 긴 작업은 `202 { jobId }` + WebSocket `job.progress`/`job.done`. 일반 요청은 100초 안에 끝나야 한다(`API_DEADLINE_MS` 90초).
- 자기 그룹 파일은 주인이 자유롭게 고친다(엔드포인트 추가·필드 추가). 단 이미 다른 컴포넌트가 쓰는 필드를 지우거나 뜻을 바꾸지 말 것.
  공유 파일(`common.ts`, `entities.ts`, `endpoint.ts`, `client.ts`, `errors.ts`)은 **추가만**, 꼭 필요할 때만. 새 모양은 가능하면 자기 그룹 파일이나 새 파일(`shared/src/api/<영역>-<이름>.ts`)에 둔다.
- 계약 시험: `tests/unit/contracts.test.ts`(경로 중복·주인·204/202 규칙 등). 새 엔드포인트를 넣으면 이 시험이 지나야 한다.

### WebSocket 요약 (`GET /api/ws`, 자세히는 `ws.ts` 머리말)

- 연결: `/api/ws?windowId=<창 id>[&epoch=<E>&after=<N>]`, 쿠키 세션(모바일 껍데기는 subprotocol `mycel.bearer.<token>`, 기본 `mycel.v1`). 서버는 Origin을 확인한다.
- 서버 → `hello {epoch, seq, resumed}`; epoch가 다르면 `reset`, 버퍼에서 밀려났으면 `resync` → 클라이언트는 REST로 다시 받는다.
- 이벤트 `{type, seq, at, data}`: `message.created/delta/step/done`, `queue.position`, `artifact.updated`, `chat.updated`, `files.changed`, `turn.request`, `turn.request.closed`, `job.progress/done`, `browser.call/cancel`, `memory.changed`, `notice`, `session.ended`.
- `message.delta.offset`은 답변 본문의 글자 위치. REST로 받은 본문 길이보다 앞이면 버린다(0.3초마다 DB 저장).
- 클라이언트 → `ping`, `browser.ack`, `browser.result`. 닫기 코드 `WsClose`(4401 로그인 필요 → 재연결 금지, 4409 다른 곳에서 같은 창 연결, 1012 서버 재시작 → 재연결).
- 재연결: 0–1초 무작위 후 1·2·4…초, 최대 약 10초.

## 3. 서버 골격 (server/src)

```
app.ts            buildApp(ctx, modules): 미들웨어 → 모듈 init() 전부 → register() 전부 → ctx.appFetch 설정
main.ts           설정 읽기, DB 열기(마이그레이션), 컨텍스트, Bun.serve(+TLS 8443 선택), 첫 설정 토큰, 종료 처리
context.ts        AppContext: config, db, log, files(FileService), services, core()(도구 관문+실행기, 처음 쓸 때 시작), onClose, appFetch
services.ts       컴포넌트 사이 인터페이스: SessionService(A), RealtimeHub(B), JobService(C), RelayStatusProvider(F) + 기본값
app-config.ts     설정 파일 + MYCEL_* 환경 변수
log.ts            JSON 줄 로그, 비밀 키 이름 가림, 날짜별 파일(14일)
db.ts             openDb / 마이그레이션 / min_compatible_reader 확인 / newId()=UUIDv7
http/route.ts     RouteKit: kit.handle(API.x, handler) — 검증·인증 수준·본문 한도·응답 검사
http/errors.ts    HttpError / fail(code, message?)
http/middleware.ts 요청 id·실제 IP·로그 → 보안 헤더 → 세션 → CSRF
routes/*.ts       영역별 모듈 (아래 표). routes/index.ts에 이미 전부 등록돼 있다 — 고치지 말 것
```

라우트 모듈 쓰는 법:

```ts
// server/src/routes/chats.ts (B)
import { API } from '@mycel/shared/api'
import { fail } from '../http/errors'
import type { RouteModule } from './module'

export const chatsRoutes: RouteModule = {
  name: 'chats', owner: 'B',
  init(ctx) { ctx.services.realtime = new RealtimeHubImpl(ctx) },            // 서비스 설치 (선택)
  register(kit, ctx) {
    kit.handle(API.getChat, async ({ params, auth }) => {                     // params/query/body는 이미 검증됨
      const row = ctx.db.query('SELECT ... WHERE id = ? AND user_id = ?').get(params.id, auth.user.id)
      if (!row) fail('not_found')
      return toChat(row)                                                      // 반환 타입 = 계약의 응답 타입
    })
  },
}
```

- 핸들러 입력: `{ c, params, query, body, auth }`. `auth`는 public이 아니면 항상 있다. 실제 IP는 `c.get('info').ip`(클라이언트가 보낸 `X-Forwarded-For` 등은 절대 읽지 않는다). 언어는 `c.get('locale')`, 로그는 `c.get('log')`.
- 본문: JSON 기본 1MB(`kit.handle(ep, h, { jsonLimit })`로 늘림), multipart는 `{ fields, file }`(파일 하나, 엔드포인트 한도), binary는 `AsyncIterable<Uint8Array>`(한도를 넘으면 413). 다운로드는 `Response`를 직접 돌려준다.
- **Bun.serve는 큰 스트리밍 본문에 배압이 없다**(스파이크 REPORT): 다운로드는 파일을 통째로 읽지 말고 조각으로(가능하면 `Bun.file(path).slice()`), 업로드는 조각 업로드로. `maxRequestBodySize`는 51MB로 잡혀 있다.
- 계약 밖 경로(WebSocket 업그레이드, 정적 파일)는 `kit.raw(method, path, handler)`. 레지스트리 시험이 계약 밖 경로를 `GET *`, `GET /api/ws`만 허용한다.
- 같은 엔드포인트를 두 번 구현하면 시작할 때 오류. 주인이 아닌 모듈이 구현하면 `tests/unit/server-app.test.ts`가 실패한다.
- 서비스 기본값: 세션 서비스가 없으면 아무도 로그인되지 않은 상태(401), 실시간 허브가 없으면 이벤트를 버린다. 각 주인이 `init()`에서 바꿔 끼운다.
- 엔진 턴: `await ctx.core()` → stage 1의 `Running`(턴 등록·도구 관문·실행기·FileService). 네이티브가 빌드되지 않았으면 `CoreUnavailableError`(문구에 `bun run build:native`).
- 다른 컴포넌트에 보낼 이벤트: `ctx.services.realtime.publish(userId, { type: 'files.changed', data })`, 작업: `ctx.services.jobs?.start({ kind, userId, run })`.

## 4. 마이그레이션

- 파일: `server/migrations/NNN_<컴포넌트>_<이름>.sql`, 숫자 순서로 한 번씩 적용. 번호 범위:

| 범위 | 주인 |
|---|---|
| 001–099 | 기반(001 init, 002 foundation) |
| 100–199 | A |
| 200–299 | B |
| 300–399 | C |
| 600–699 | F |
| 700–799 | G |

  D·E는 서버 DB를 쓰지 않는다. 범위 안에서 다음 번호를 쓴다(예: `101_a_login_attempts.sql`, `201_b_queue.sql`).
- 자기 범위와 001–099의 테이블에만 기대고, **추가만** 한다: 새 테이블, 기본값 있거나 NULL 가능한 새 열, 인덱스. 이름 바꾸기·테이블 다시 만들기·열 삭제 금지. SQL은 항상 열 이름을 적는다(`SELECT *`·위치 INSERT 금지). 새 테이블의 FK는 `ON DELETE CASCADE`.
- 이전 버전이 읽을 수 없는 변경을 꼭 해야 하면 파일 첫 줄들에 `-- min_compatible_reader: N`을 쓰고 `db.ts`의 `SCHEMA_READER_LEVEL`을 N으로 올린다(기반과 상의). 서버는 더 새 reader가 필요한 DB를 열지 않는다(복원 안내).
- 데이터가 있는 DB에 새 마이그레이션을 적용하기 전에 `<data>/backups/pre-migrate-*.db`(VACUUM INTO)가 생긴다.

## 5. 컴포넌트와 소유

포트 범위는 시험·개발 서버용이다. 기반 개발 서버는 19100, 기반 시험은 19101–19109.
작업 폴더(시험용 임시 파일)는 `tests/.work/<컴포넌트 문자>-*`(`MYCEL_WORK`로 바꿀 수 있음). 시험 파일 이름도 `tests/unit/<a|b|c…>-*.test.ts`처럼 컴포넌트 문자로 시작한다.

### A — server-auth-admin (포트 19110–19119)
- 소유: `server/src/routes/auth.ts`, `server/src/routes/admin.ts`, `server/src/routes/credentials.ts`(admin 모듈이 등록), `server/src/auth/*`, `server/src/admin/*`, `server/src/credentials/*`(AI 연결: 보관·봉인·해석·브로커·ChatGPT 갱신·로그인·옮기기), `server/src/proxy/*`(모델 프록시, Codex 경로, CONNECT), `shared/src/api/auth.ts`, `shared/src/api/admin.ts`, `shared/src/api/credentials.ts`, 마이그레이션 100–199(106: AI 연결), `tests/unit/a-*.test.ts`.
- 구현: AUTH + ADMIN 엔드포인트 전부. `SessionService`(쿠키 `__Host-sid`, 개발 http에서는 `DEV_SESSION_COOKIE`; Bearer; 토큰은 해시만 저장; 30일; 비밀번호 변경·비활성화 시 그 사람 세션 전부 폐기 + `realtime.disconnectUser`), argon2id(`Bun.password`), 로그인 횟수 제한(IP·계정별, IP는 `info.ip`만), 첫 설정(`config.setupToken`, 사용자가 없을 때만), 초대 링크(메일 없음, 링크 복사), 폴더 규칙 저장·"누가 무엇을 보나" 미리보기(권한 계산은 `server/src/policy`), 규칙으로 접근을 잃은 사람의 채팅 엔진 세션 초기화 표시(H7), 엔진 상태(설치·로그인·버전·잠금 시험 결과), 예산·설정·사용량·감사 기록.
- 엔진 상태에서 "구독 장기 토큰 없음"(무권한 `_axagent` 모드에 필요한 `claude setup-token`)은 상태 문구로 보여 준다 — owner 계정이 필요한 일이라 이번에는 막혀 있음.
- 관리자도 다른 사람의 대화·메모리를 볼 수 없다. "다른 사람으로 로그인" 없음. 비밀번호 초기화는 감사 기록.

### B — server-chat-realtime (포트 19120–19129)
- 소유: `server/src/routes/chats.ts`, `routes/ws.ts`, `routes/memories.ts`, `routes/browser.ts`, `server/src/chat/*`, `server/src/realtime/*`, 대기열, 엔진 통합(`server/src/engine/*`의 확장은 B가 맡는다), `shared/src/api/chats.ts`·`memories.ts`·`ws.ts`·`browser.ts`, 마이그레이션 200–299, `tests/unit/b-*.test.ts`.
- 구현: 채팅·메시지(트리: `parent_id`, `chats.active_leaf_id`, `branch`), 대기열(동시 실행 수 = 설정 `concurrency`, `queue.position`), 턴 실행(`ctx.core()` + `TurnExec`, `server/src/chat/turn.ts`; stage 1의 `TurnRunner`는 실제 엔진 시험용으로 `tests/lib/stage1-runner.ts`에 있다), 0.3초마다 DB 저장, `message.*` 이벤트, 중지, 다시 생성·수정(팀 폴더 변경은 되돌리지 않음), 답변 아래 파일 요약(`file_events`), `ask_user`(`turn.request` → `POST /api/turns/:id/answer`), 메모리(remember/forget 도구 + REST), 프로젝트, `RealtimeHub`(사용자별 seq·epoch·링 버퍼·resync/reset·20초 프로토콜 핑·느린 클라이언트 4408), 브라우저 중계(`browser.call`을 턴을 보낸 창으로, `callId`로 중복 제거, 끊긴 동안의 호출 재전송, 롱폴링 대체 경로), 엔진에 브라우저 도구 노출(입력 스키마는 E가 `shared/src/browser-tools.ts`에 정의).
- 아티팩트 도구 호출 처리(저장·`artifact.updated`)는 C의 서비스(`server/src/tools/artifact*`)를 부른다.

### C — server-files-tools (포트 19130–19139)
- 소유: `server/src/routes/files.ts`, `routes/artifacts.ts`, `routes/jobs.ts`, `server/src/tools/*`(파일 도구 말고 나머지: make_file, share_file, artifact, web_fetch), `server/src/jobs/*`, 업로드(`server/src/uploads/*`), `shared/src/api/files.ts`·`artifacts.ts`·`jobs.ts`, 마이그레이션 300–399, `tests/unit/c-*.test.ts`.
- 구현: 파일 화면 API 전부(모든 경로는 `ctx.files`/정책 함수를 거친다, "없음"="권한 없음"), 다운로드 스트리밍 + Range(통째로 메모리에 올리지 않기), 작은 업로드(50MB), 첨부(`users/<id>/.attachments/<chatId>/`, 썸네일), 조각 업로드(8MB, sha256, 24시간 만료, 임시 폴더는 `<data>/uploads`), `files.changed` 이벤트(볼 수 있는 사람에게만: `realtime.publishEach`), 버전 기록·되돌리기·휴지통, 아티팩트 저장·조회, `JobService`(재시작 시 진행 중 작업은 failed, 7일 뒤 정리), 받아쓰기(whisper.cpp, 파이썬 없음), make_file(pandoc / SheetJS / typst), web_fetch.

### D — web (포트 19140–19149)
- 소유: `web/` 전부, `server/src/routes/web.ts`(빌드된 웹 제공, SPA 대체), `tests/unit/d-*`·`web/` 안의 시험.
- React + Vite(Saram `web/` d315378에서 복사해 가져오기: 채팅 UI, KaTeX·Mermaid·스트리밍 마크다운 보정, 아티팩트 패널 + 샌드박스 iframe, 파일 미리보기, 답변 복사, 이미지 썸네일), Supabase 제거, 문구는 ko/en/id 번역 파일(기본 한국어), 표시 이름 `PRODUCT.displayName`.
- `ApiClient`와 `ws.ts` 프로토콜만 쓴다. Vite 개발 서버 19140, `/api`(WebSocket 포함)를 19100으로 프록시. `web/package.json`에 `dev`/`build` 스크립트를 넣으면 `bun run dev`가 함께 띄운다.
- 화면: 로그인·초대 수락·첫 설정(`/setup?token=`), 사이드바, 채팅, 오른쪽 패널, 프로젝트, 파일, 메모리, 설정, 관리자 화면들(5번 탭). PWA(모바일).

### E — desktop (포트 19150–19159)
- 소유: `desktop/` 전부, `shared/src/browser-tools.ts`(브라우저 도구 입력 스키마, 새 파일), `tests/unit/e-*`.
- Electron 껍데기(Saram `desktop/` 재사용): 팀 주소 입력·여러 팀 기억, 웹 화면을 서버에서 불러옴, 앱 안 브라우저 창(CDP)으로 `browser.call` 실행 → `browser.result`, 사이트별 허용, "AI가 사용 중" 표시. 맥 빌드(서명은 owner 인증서 필요 → 막힘 목록), 윈도우는 서명 없는 빌드만. 사무실 안 직접 연결은 인증서 지문 고정(`ConnectionStatus.direct.fingerprintSha256`).

### F — relay (포트 19160–19169)
- 소유: `relay/` 전부, `server/src/relay-client/*`, `server/src/routes/relay.ts`(엔드포인트 없음, `init()`에서 중계 클라이언트 시작), 마이그레이션 600–699, `tests/unit/f-*`.
- 중계 서버는 **Node 25**에서 돈다(Bun.serve 배압 없음, 취소 전파 안 됨 — 스파이크 REPORT). 프로토콜 v2: 이진 프레임 `[type u8][streamId u32][flags u8][len u32]`, OPEN/DATA/END/RST/WINDOW/PING/PONG/GOAWAY/RESPONSE/EVENT, 스트림별 창 256KB, Ed25519 인증, 제어 연결 2–4개, 45초 무응답 감지, 재연결 0.5초×2^n(최대 30초, full jitter), 클라이언트 IP는 OPEN 메타데이터로만 넘기고 **중계 서버는 IP를 기록하지 않는다**. 스파이크 코드: `/private/tmp/claude-501/-Users-dion-dea/a01281aa-b40b-4035-b3ca-2a0f5b472d61/scratchpad/spike-relay/`.
- 팀 서버 쪽: 중계 요청을 `ctx.appFetch(req, { ip, via: 'relay' })`로 같은 프로세스 안에서 처리, 큰 다운로드는 창 단위로 흘려보냄, `ctx.services.relay`(연결 상태). 로컬 주소는 `<팀>.localhost`, 나중에 `<팀>.treesoop.com`.

### G — installer-ops (포트 19170–19179)
- 소유: `scripts/`, `menubar/`, `server/src/system/*`, `server/src/routes/system.ts`(health는 기반이 구현해 둠), 마이그레이션 700–799, `tests/unit/g-*`.
- 구현: 진단(디스크·엔진·대기열·pf anchor·sandbox-exec·백업·중계), 백업(VACUUM INTO + 팀 폴더 목록 비교, 14일, `.system/backups/`), 복원(임시 위치에 풀고 성공했을 때만 교체), 내보내기(age-encryption 스트리밍), 업데이트(`app/versions/<버전>` + `current` 링크, 실패 시 되돌림, DB는 되돌리지 않음), 연결 방식 변경, 메뉴바 앱, 설치 스크립트(역할 계정 `_axserver`·`_axagent`, LaunchDaemon, cron.deny). 역할 계정 모드는 **가짜 엔진으로** 시험한다(실제 무권한 엔진 실행에는 owner의 `claude setup-token`이 필요 → 막힘 목록).

## 6. 공유 파일을 고쳐야 할 때

- `package.json`(루트): 스크립트 추가만, 한 줄씩. 의존성은 각 워크스페이스의 `package.json`에(버전 고정, `versions.json`에도 적기).
- `shared/src/api/index.ts`: 새 그룹 파일을 만들 때 import·spread·export 한 줄씩만.
- `server/src/services.ts`: 인터페이스에 메서드를 **추가**할 때만, 기본값(fallback)도 같이.
- `server/src/app.ts`, `main.ts`, `context.ts`, `http/*`, `routes/index.ts`, `db.ts`: 기반 파일. 꼭 필요하면 작은 단위로 고치고 커밋 메시지에 이유를 적는다.
- `docs/DECISIONS.md`: 누구나 자기 절(`## A …` 등)을 추가해 결정을 적는다.

## 7. 커밋

- 작은 논리 단위, 메시지는 평범한 영어 문장, 마지막 줄 `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- force-push 금지, 비밀값 커밋 금지. 커밋 전에 `bun run typecheck && bun run test:unit`.
- 다른 에이전트도 `main`에 커밋한다: `git pull --rebase` 후 push, 충돌이 나면 남의 파일은 그쪽 것을 따른다.
- 실제 `claude -p` / `codex exec` 호출은 적게, 항상 `--max-turns`·시간 제한을 둔다.

## 8. 이번 실행에서 막힌 것 (owner 계정 필요)

- 무권한 `_axagent`로 실제 엔진 실행: owner의 `claude setup-token`(구독 장기 토큰)과 Codex `codex login --device-auth`가 필요. 그전까지 제품은 개발 모드(현재 사용자, 로컬 로그인)로 돌고, 역할 계정 설치는 가짜 엔진으로 시험한다.
- Apple 서명·공증(데스크톱 앱, 메뉴바 앱, 앱 안 실행 파일), 운영 중계 서버(리눅스 + Cloudflare, `*.treesoop.com`), 메일 계정, 회사 API 키.
