# 트리나 사이트 브랜드 자산

## 앱·설치 파일 이름

`product.json`은 판매판 앱 이름 설정이다. 최신 코어의 `scripts/product-brand.ts`로 별도 빌드 사본에 적용한다. `bun scripts/product-brand.ts editions/trina/branding/product.json`으로 검토한 뒤 같은 명령에 `--apply`를 붙인다. 이후 웹·서버·데스크톱 등 필요한 묶음을 다시 빌드한다. 설치 ID·기존 사용자 데이터 경로는 유지한다. 상세 절차는 코어 `docs/EDITION-BRANDING.md`를 따른다. 이는 P6 사이트 자산 스냅샷 이후 root가 추가한 공통 빌드 도구 연동이며, 원본 코어 이름을 바꾸지 않는다.

## 사이트 자산

P6 후보는 기존 `~/src/trina-ax/website`의 tracked 파일을 복사해 시각 디자인을 유지한다. 실제 사용 자산은 `../website/public`과 `../website/src/assets/fonts`에 두며 중복 배포하지 않는다. 고객 문서·실제 앱 데이터·계정 설정은 복사 대상이 아니다.

- 로고·아이콘: 기존 Trina AX SVG/PNG를 그대로 사용한다. 브랜드명은 한글 ‘트리나 AX’, 영문 ‘Trina AX’다. 코드 라이선스와 별도로 상표 사용 범위를 확인한다.
- 색상·타이포그래피·밝은/어두운 테마: 기존 Astro CSS와 컴포넌트를 보존한다. 새 구조도는 같은 카드 형식의 앱→팀 서버→Anthropic 흐름이다.
- 배경 WebP: 기존 사이트 README에 2026-10-26 Higgsfield 생성 이미지로 기록되어 있다. 추상 폴더·빛·보관함이며 신규 생성하지 않았다. 해당 기록은 출처 설명이고 제3자 권리 실사를 대신하지 않는다.
- 화면 예시: 이름·조직·수치는 기존 합성 예시다. 실사용 고객 사례로 소개하지 않는다.
- Geist/Geist Mono와 Pretendard: SIL OFL 고지를 유지한다. 새 한국어 문구에 맞춰 부분 생성한 폰트는 예약 이름을 쓰지 않는 `Trina UI`로 명명했다. glyph/metrics/layout은 유지하며 내부 이름·파일명·CSS 참조만 변경했다. `../website/public/fonts/NOTICE-Trina-UI.txt`에 변경 기록을 보존한다. 원본 폰트는 로컬 `~/src/website/src/app/fonts/PretendardVariable.woff2`이며 글꼴 내용만 읽었다.
- Open Graph PNG: `../website/scripts/render-social.mjs`가 새 서버판 한·영 카피로 로컬 렌더한다.

원본 웹사이트의 Apache-2.0 라이선스와 저작권 고지는 `LICENSE.website-upstream.txt` 및 `NOTICE.website-upstream.md`에 유지한다. 파생 후보의 라이선스 표시는 코어/판매판 AGPL 정책에 맞추며 기존 고지를 삭제하지 않는다.

파일별 복사 SHA와 기준 커밋은 작업 증거 `.validation/p6/old-website-provenance.json`에 있다. 공개 산출물에 포함할 최종 provenance는 배포 검토에서 별도로 확정한다. 원본 사이트와 기업 홈의 운영 배포는 이 작업에서 변경하지 않았다.
