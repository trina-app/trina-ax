# 제3자 고지 현황

2026-10-27, 로컬 후보. 알려진 출처와 누락을 설명하며 완성된 배포용 고지 묶음이 아니다.

| 범위 | 보존된 원문·출처 | 한계 |
|---|---|---|
| Team AX/Trina 코드 | [LICENSE](../LICENSE), [NOTICE](../NOTICE) | 별도 라이선스·권리 미확정 부분을 새로 허락하지 않음 |
| 공유 cloud 프로토콜 | [폴더 한정 MIT](../shared/src/cloud-protocol/LICENSE) | ee/cloud 및 shared의 다른 폴더까지 확대하지 않음 |
| 역사적 Trina 웹사이트 | [Apache-2.0](../editions/trina/branding/LICENSE.website-upstream.txt), [원 저작권 출처](../editions/trina/branding/NOTICE.website-upstream.md) | 새 서버판 전체가 Apache라는 뜻이 아님 |
| 외부 서비스 로고 | `web/public/icons/connectors`의 39개. 파일별 출처는 아래 [외부 서비스 로고](#외부-서비스-로고-webpubliciconsconnectors) 표 | 각 로고는 그 소유자의 상표이고 서비스를 가리키는 데만 쓴다. 이 저장소의 라이선스가 로고에 권리를 주지 않는다. 파일별 출처와 이용 조건은 아직 확인되지 않았다 |
| 사이트 글꼴 | 사이트(ax.trina.app)와 함께 비공개 `trina-ax-core`로 옮김. OFL 원문·Trina UI 변경 기록도 그쪽에 있다 | 사이트 배포물에 함께 넣는다 |
| 사이트 정적 출력 | 비공개 `trina-ax-core`의 `editions/trina/website/public/licenses/` | 실제 dist의 바이트 확인 필요; 대응 소스 제공과 별개 |

Saram/chat-proto 12개 명시 파일과 ee/cloud는 [PUBLICATION](PUBLICATION.md)의 권리 근거를 따른다. PowerPoint 미리보기는 2026-10-28부터 `@aiden0z/pptx-renderer@1.4.0`(Apache-2.0)을 쓴다. 패키지 `LICENSE`·`THIRD_PARTY_NOTICES.md`와 설치된 `mtx-decompressor`(MPL-2.0)의 `LICENSE`는 웹 빌드의 `web/dist/licenses/`에 복사된다. 남은 항목: 패키지 `licenses/ECMA-text-copyright-notice.txt`는 자동 복사되지 않는다. 앱 번들은 패키지 ESM이 가져오는 설치본 `mtx-decompressor@1.8.0`을 묶으며, 패키지 고지의 1.4.2는 패키지 자체 standalone 번들 기준이다. 이전 `pptx-preview@1.0.7`(저자 LICENSE가 소스 게시를 제한)은 의존성에서 뺐다.

서버의 `tldts@7.0.30`·`tldts-core@7.0.30`(MIT, 2026-10-30)은 Public Suffix List(MPL-2.0, https://publicsuffix.org/list/) 데이터를 코드에 담고 있다. 패키지 `LICENSE`(MIT)는 서버 묶음 고지에 자동 복사된다. PSL의 MPL-2.0 고지와 원본 위치는 패키지에 없어서 저장소의 `resources/notices/public-suffix-list/`(고지와 MPL-2.0 원문)에 두고, 고지 수집기(`scripts/release-notices.ts` `EMBEDDED_DATA`)가 tldts가 든 모든 서버·사무실 묶음의 `licenses/public-suffix-list/`에 자동으로 넣는다(2026-10-31). 파일이 없거나 고지에 원본 위치·라이선스가 없으면 빌드가 멈추고, `tests/unit/release-notices.test.ts`가 이 저장소로 확인한다.

리눅스 서버 묶음의 `fonts/`에는 Noto Sans CJK 2.004 Regular·Bold(OFL-1.1, https://github.com/notofonts/noto-cjk 태그 Sans2.004의 `Sans/OTC/*.ttc`, 바꾸지 않음)가 들어간다(2026-11-01, AI가 만드는 PDF의 한글·일본어·중국어). 같은 파일이 Debian 13의 `fonts-noto-cjk`에도 있다(SHA-256 같음). 고지와 OFL 원문은 `resources/notices/noto-sans-cjk/`에 두고, 고지 수집기(`BUNDLED_FONTS`)가 글꼴이 든 묶음의 `licenses/noto-sans-cjk/`에 넣는다. 고지가 없으면 빌드가 멈춘다. HWP 미리보기 플러그인의 Noto Sans KR(한글만 든 부분 글꼴)은 그와 별개로 플러그인 꾸러미에만 들어간다.

AI가 만드는 한글 문서(.hwpx, make_file, 2026-11-03)는 이 저장소의 코드(`server/src/files/hwpx-write.ts`, `hwpx-template.ts`, `hwpx-check.ts`, `zip-write.ts`)가 쓴다. 제3자 코드·서식 파일·문서를 넣지 않았고 새 의존성도 없다(XML 검사는 기존 `saxes`, zip 읽기는 기존 SheetJS). 한컴의 공개 OWPML(KS X 6101)·HWP 문서와 한글이 저장한 파일의 구조를 참고했고, python-hwpx(Apache-2.0)와 pypandoc-hwpx(MIT)는 파일 구조의 선례로 읽기만 했다. 한컴 공개 문서 참고 문구와 상표 안내는 [NOTICE](../NOTICE)에 있다. 기본 서식이 이름으로 가리키는 글꼴(함초롬바탕·함초롬돋움)은 파일에 넣지 않는다: 문서를 여는 한글이 가진 글꼴을 쓴다. 이미 있는 .hwpx를 채우는 편집기(edit_hwp, 2026-11-03)도 이 저장소의 코드(`server/src/files/hwpx-edit.ts`, `zip-write.ts`의 읽기)이고 새 의존성이 없다. .hwp(HWP 5.x)를 채우는 편집기(같은 도구, 2026-11-03)도 이 저장소의 코드(`server/src/files/hwp-edit.ts`, `hwp-changes.ts`, 복합 파일을 읽고 쓰는 `cfb.ts`)다. 새 의존성이 없다(압축은 Node의 zlib, 읽기 대조는 기존 SheetJS). 한컴의 공개 HWP 5.0 문서와 한글이 저장한 파일의 구조를 참고했다. 시험에 쓴 한글 저장 견본(hwplib의 sample_hwp, Apache-2.0, 법령정보센터의 법령 별지 서식)은 저장소에 넣지 않았고, `MYCEL_HWP_SAMPLES`로 폴더를 줄 때만 읽는다. hwplib의 코드는 읽지도 가져오지도 않았다. 고친 문단의 줄 배치 캐시(`hp:linesegarray`)를 지우는 이유는 python-hwpx(Apache-2.0)의 문서에서 읽었고, 코드는 가져오지 않았다. 테스트 문서는 테스트 코드가 만든 가상의 문서다.

앱 웹 번들의 React/KaTeX/pdf.js/Office/viewer/vendor/폰트, 서버의 web-push와 semantic runtime, desktop의 Electron/Chromium 등은 최종 artifact에서 실제 포함 버전·전이 구성요소를 확정해야 한다. lockfile/단일 SPDX metadata만으로 모든 저작권 문구·복합 라이선스를 대체하지 않는다. JSZip의 선택형 허락, pako의 복합 허락, libvips의 별도 LGPL 및 linked library 고지도 구분한다.

최종 release에는 파일/패키지·버전·출처 revision·SHA·허락 원문·저작권·수정 내역·선택한 제공 방식이 연결된 목록과 고지 묶음을 넣는다. 필요한 대응 소스·설치/재링크 자료를 보존하고 실제 zip/tar/app/image/web output에 포함되는지 검사한다.

## 외부 서비스 로고 (`web/public/icons/connectors`)

2026-11-03 정리. 근거는 이 저장소 안의 기록(로고를 넣은 PR #36 커밋 `25b458dc`와 다시 올린 `79d46d6a`의 메시지, PR #36
본문, `docs/INTEGRATIONS.md`)과 파일 자체의 메타데이터뿐이다. 외부 사이트는 확인하지 않았다.

- 기록에 남은 출처는 묶음 전체에 대한 것뿐이다. 이 문서의 이전 문구는 "svgl.app, Simple Icons와 각 서비스 사이트에서
  받음, 목록은 mcpservers.org 기준"이었고 `docs/INTEGRATIONS.md`는 "svgl.app과 Simple Icons"만 적었다. 커밋 메시지와 PR
  본문에는 출처가 없다. 어느 파일이 어디서 왔는지는 어디에도 기록되지 않았다.
- 그래서 아래 39개 중 출처가 확인된 파일은 0개, 미확인 39개다. 그중 13개는 파일 형식(`role="img"`,
  `viewBox="0 0 24 24"`, 서비스 이름의 `<title>`, 한 가지 `fill` 색)이 Simple Icons의 배포 형식과 같다. 이것은 추정이고
  출처 확인이 아니다. `higgsfield.png`, `monday.png`, `calendly.svg`를 포함한 나머지는 파일에서도 단서가 없다.
- 이용 조건은 출처를 알아야 적을 수 있어서 모두 "미확인"이다. 출처와 무관하게 각 로고는 그 소유자의 상표다.
- 공개 저장소에 둘지는 대표 결정을 기다린다. 확인하거나 파일을 바꿀 때는 이 표에 출처 주소, 받은 날짜, 그 출처의 이용
  조건을 함께 적는다.

| 파일 | 출처 | 그 출처의 이용 조건 | 파일에서 알 수 있는 것 |
|---|---|---|---|
| `ahrefs.svg` | 미확인 | 미확인 | viewBox `0 0 128 128`; 만든 곳을 알려 주는 메타데이터 없음 |
| `airtable.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>Airtable</title>`; Simple Icons 배포 형식과 같음(추정) |
| `atlassian.svg` | 미확인 | 미확인 | viewBox `0 0 256 256`; 만든 곳을 알려 주는 메타데이터 없음 |
| `brex.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>Brex</title>`; Simple Icons 배포 형식과 같음(추정) |
| `calendly.svg` | 미확인 | 미확인 | viewBox `0 0 841.89 595.28`; Adobe Illustrator 27.5.0(으)로 내보낸 파일(파일 안 주석), 어디서 받았는지는 없음 |
| `canva.svg` | 미확인 | 미확인 | viewBox `0 0 80 80`; 만든 곳을 알려 주는 메타데이터 없음 |
| `clickup.svg` | 미확인 | 미확인 | viewBox `0 0 64 64`; 만든 곳을 알려 주는 메타데이터 없음 |
| `cloudflare.svg` | 미확인 | 미확인 | viewBox `0 0 256 116`; 만든 곳을 알려 주는 메타데이터 없음 |
| `cloudinary.svg` | 미확인 | 미확인 | viewBox `0 0 256 168`; 만든 곳을 알려 주는 메타데이터 없음 |
| `figma.svg` | 미확인 | 미확인 | viewBox `0 0 54 80`; 만든 곳을 알려 주는 메타데이터 없음 |
| `gitlab.svg` | 미확인 | 미확인 | viewBox `0 0 32 32`; 만든 곳을 알려 주는 메타데이터 없음 |
| `higgsfield.png` | 미확인 | 미확인 | PNG 180×180, EXIF는 색 공간과 크기뿐(만든 이·프로그램·날짜 없음) |
| `indeed.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>Indeed</title>`; Simple Icons 배포 형식과 같음(추정) |
| `intercom.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>Intercom</title>`; Simple Icons 배포 형식과 같음(추정) |
| `linear.svg` | 미확인 | 미확인 | viewBox `0 0 100 100`; 만든 곳을 알려 주는 메타데이터 없음 |
| `mermaid.svg` | 미확인 | 미확인 | viewBox `0 0 491 491`; 만든 곳을 알려 주는 메타데이터 없음 |
| `mintlify.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>Mintlify</title>`; Simple Icons 배포 형식과 같음(추정) |
| `monday.png` | 미확인 | 미확인 | PNG 160×160, EXIF는 색 공간과 크기뿐(만든 이·프로그램·날짜 없음) |
| `neon.svg` | 미확인 | 미확인 | viewBox `0 0 64 64`; `<title>Neon</title>`; 만든 곳을 알려 주는 메타데이터 없음 |
| `netlify.svg` | 미확인 | 미확인 | viewBox `0 0 256 226`; 만든 곳을 알려 주는 메타데이터 없음 |
| `notion.svg` | 미확인 | 미확인 | viewBox `0 0 256 268`; 만든 곳을 알려 주는 메타데이터 없음 |
| `openrouter.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>OpenRouter</title>`; Simple Icons 배포 형식과 같음(추정) |
| `paypal.svg` | 미확인 | 미확인 | viewBox `7.056000232696533 3 37.35095977783203 45`; 만든 곳을 알려 주는 메타데이터 없음 |
| `planetscale.svg` | 미확인 | 미확인 | viewBox `0 0 256 256`; 만든 곳을 알려 주는 메타데이터 없음 |
| `posthog.svg` | 미확인 | 미확인 | viewBox `0 0 50 30`; 만든 곳을 알려 주는 메타데이터 없음 |
| `postman.svg` | 미확인 | 미확인 | viewBox `0 0 256 256`; 만든 곳을 알려 주는 메타데이터 없음 |
| `railway.svg` | 미확인 | 미확인 | viewBox `0 0 1024 1024`; 만든 곳을 알려 주는 메타데이터 없음 |
| `razorpay.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>Razorpay</title>`; Simple Icons 배포 형식과 같음(추정) |
| `resend.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>Resend</title>`; Simple Icons 배포 형식과 같음(추정) |
| `sanity.svg` | 미확인 | 미확인 | viewBox `0 0 192 192`; 만든 곳을 알려 주는 메타데이터 없음 |
| `sentry.svg` | 미확인 | 미확인 | viewBox `0 0 256 227`; 만든 곳을 알려 주는 메타데이터 없음 |
| `square.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>Square</title>`; Simple Icons 배포 형식과 같음(추정) |
| `stripe.svg` | 미확인 | 미확인 | viewBox `100 100 312 312`; 만든 곳을 알려 주는 메타데이터 없음 |
| `supabase.svg` | 미확인 | 미확인 | viewBox `0 0 109 113`; 만든 곳을 알려 주는 메타데이터 없음 |
| `todoist.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>Todoist</title>`; Simple Icons 배포 형식과 같음(추정) |
| `vercel.svg` | 미확인 | 미확인 | viewBox `0 0 256 222`; 만든 곳을 알려 주는 메타데이터 없음 |
| `webflow.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>Webflow</title>`; Simple Icons 배포 형식과 같음(추정) |
| `wix.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>Wix</title>`; Simple Icons 배포 형식과 같음(추정) |
| `wordpress.svg` | 미확인 | 미확인 | viewBox `0 0 24 24`; `<title>WordPress</title>`; Simple Icons 배포 형식과 같음(추정) |
