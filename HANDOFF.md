# HANDOFF — Naver Content OS

- 갱신 시각: `2026-09-06 23:30 KST`
- 저장소: `coreline-ai/naver-contents-os`
- 브랜치/기준 커밋: `main` / `b8d461e`
- 진행 개발 계획: [기능 보존형 웹앱·사용성 개선](dev-plan/implement_20260906_194855.md) — P0·P1·P2-A·P2-B 자동 검증 완료, P2-C·P3 잔여
- 직전 검토 계획: `dev-plan/implement_20260906_190353.md`
- 최신 검토: `docs/20_full_function_review_20260906.md`
- 상태: **Codex 고품질 작성 경로와 Advisor 내 성과 P0~P3 구현·자동 검증 완료, 실제 계정 표 형식·430px Chrome UAT 대기**
- Git: 커밋·푸시하지 않은 dirty working tree

## 2026-09-07 main 반영 전 검증

- 사용자 요청으로 누적 변경 전체를 main에 커밋·푸시하는 작업. 앱 자동 검증 **486 PASS**(Python297/Extension75/Web114), 양쪽 타입·빌드·migration·parity PASS. 로그 `/tmp/ncos-main-prepush-verify.log`.
- 변경 파일의 설정된 비밀값 대조/주요 토큰 패턴 검사 및 추적 실행 파일 검사 PASS. `.env`, DB/백업, 로컬 토큰, 세션 DB, 빌드 결과는 제외.
- 추가 문서 검사: 미추적 테스트 참조는 staging으로 해소됐지만 기존 `DL-20260904T115000Z-a91f6c2b`의 high/active 상태는 `LESSON_PROMOTION_BLOCKED`가 반환된다. 신뢰할 외부 승인 제공자가 없는 advisory 도구의 제한이며 **Lesson 승격은 미완료**다. 승인자/심각도를 임의 변경하지 않았다. 앱 테스트 결과와는 별도다.

## 최신 추가 — 브라우저 탭 아이콘

- 앱의 초록색 N 마크를 SVG 파비콘으로 추가: `apps/web/public/ncos-icon-v1.svg`, `apps/web/index.html`. 폰트/외부 이미지 의존 없음. Vite 빌드에서 `/app/ncos-icon-v1.svg`로 연결되며 모든 웹 경로에 적용.
- `apps/web/tests/favicon.test.ts` 추가, 전체 **486 PASS**(Python297/Extension75/Web114), 양쪽 타입·빌드·migration·parity PASS. `/tmp/ncos-favicon-verify.log`.
- 현재 서버 **PID36424 / exec64504**, 직전 PID25770 종료. 백업 `data/backups/ncos-before-web-20260906-232858-507466.db`. 기존 DB 개수 보존, 아이콘 HTTP200/image/svg+xml/no-cache·빌드 바이트·runtime revision 일치 확인.
- 기존 Chrome 작업실 새로고침, 다크/연결 유지. DOM의 원본 favicon 경로 확인. 브라우저 제어 중 Codex가 임시 favicon badge를 덧씌우므로 그 표시를 앱 아이콘으로 오인하거나 제거하지 않는다.
- 코드 커밋/푸시 없음. 기존 테마 지정 폭/샘플 시각 검수 잔여 상태는 그대로다.

## 직전 추가 개발 — 웹 다크 테마

- 계획: [다크 테마 구현](dev-plan/implement_20260906_230626.md). Phase 1·2 구현 완료, Phase 3 자동 회귀·실행 반영 완료 / 지정 폭·샘플 시각 검수 잔여.
- 앱 설정 → 화면 테마: 시스템/라이트/다크, 기본 시스템. 브라우저별 `ncos-web-theme` enum만 저장. 원고/주제/성과 표 입력 보존, OS 변화/동일 origin storage 이벤트 반영, 실패 시 현재 화면 적용+저장 재시도.
- 핵심: `apps/web/src/{theme.ts,theme.css,AppearancePanel.tsx}`, `apps/web/public/theme-init.js`; 공유 SVG는 CSS 변수와 확장 fallback 유지. 외부 초기화 스크립트는 no-cache, CSP 완화 없음, 런타임 지문에 bootstrap 포함.
- 최신 검증: **485 PASS**(Python297/Extension75/Web113), 양쪽 타입·빌드·migration·parity·compile PASS. 로그 `/tmp/ncos-theme-verify.log`.
- 당시 서버 **PID25770 / exec34465** (파비콘 적용 시 종료), [설정 화면](http://127.0.0.1:3719/app/settings). 기존 Chrome 탭에 다크 선택·새로고침 유지·연결 정상 확인. 아래 P2-B 당시 PID94422는 종료됨.
- 백업 `data/backups/ncos-before-web-20260906-231726-498835.db` (600). 운영 개수 Keyword13/Draft20/Version21/Publication0/DiscoveryRun6/성과채널0/성과Import0 유지. 활성 발행0, integrity ok.
- UI 검수: 기존 앱 기본 폭에서 설정/작성·저장 원고/목록/키워드 후보/성과 폼 확인, 콘솔 오류0. 샘플 표는 저장하지 않고 입력만 복원. 새로운 Chrome 검수 탭은 차단되고 viewport가 적용되지 않아 지정 폭·샘플 차트/사진 시각 검수 미완료. 우회하지 않았으며 임시 검수 서버/탭 종료, viewport reset.
- 기존 웹 P2-C·P3와 실계정 UAT는 여전히 별도 잔여. 커밋/푸시 없음.

## 독립 웹앱 전환 — P0·P1·P2-A·P2-B 완료, P2-C·P3 잔여

- 독립 로컬 웹앱을 기본 작업 화면으로 제공하고 기존 확장 기능도 유지한다.
- `글쓰기·키워드 찾기·내 원고·성과` 4개 영역과 보조 설정으로 재배치한다.
- 기존 30개 기능군의 입력·출력·저장 이력·오류 경로를 보존하며, 실제 탭 수집만 선택형 확장에 연결한다.
- P0 실행·인증 기반 → P1 작성·근거·원고 → P2 탐색·성과·확장 연결 → P3 격리 검수·접근성·호환성 순서다.
- 구현: `apps/web`, `packages/core-client`, `packages/workbench`, 웹 세션·정적 제공·실행기. 생성/편집/버전/목록 웹 경로와 버전 충돌 보호를 추가했다.
- 명령: `pnpm app:start`, `pnpm app:pair`, `pnpm test:web`, `pnpm test:parity`. `app:demo`는 미구현.
- 최신 자동 검증: Python 297 + Extension 75 + Web 114 = 486건. 실제 모델/네이버 웹 저장 인수는 별도다.
- 세부 사용·잔여 범위: [웹앱 실행·검수 안내](docs/18_web_app_setup_and_verification.md).
- 기존 확장 기능·API 경로·DB 이력은 보존한다. P1 근거 승인/플랜/개선 작업 연결을 완료했다. P2-A 상세 탐색을 추가했다. P2-B 성과 가져오기·집계·추천·추적·광고를 공유 모듈로 연결했다. 다음은 P2-C 확장 수집, P3 샘플/인수다.
- 키워드 기본 화면에 최근 수집 후보/4모드 최신 수집, 상세 분석·맵·관심·특화 자료를 연결했다. 앱 설정과 기존 메뉴 위치 안내는 `docs/19_web_keyword_and_menu_review.md` 참조.

### P2-B 당시 전체 재검토·실행 인수 (22:39 KST 기록)
- 누락 성과 UI/선택적 API scope 연결. 표 입력은 메뉴 전환 중 유지, 미리보기/추적/채널 변경 중복·늦은 응답 보호. 공감수 별칭과 전체 지표 미리보기 보완.
- 30기능군 중 웹 진입 구현29, F29 현재 탭 수집 연결 미구현. 정식 `app:demo`, 전 기능 접근성·실계정 인수, 범분야 실시간 인기 피드도 아직 없다.
- 최종 자동 검증 **458건** + build/typecheck/compile/migration/parity PASS. 로그 `/tmp/ncos-review-final-verify.log`. 구조 검사를 기능 전체 완료로 해석하지 않는다.
- 운영 `http://127.0.0.1:3719/app/performance`, PID94422 / exec14569 유지. 자료 가져오기 탭을 실제 브라우저에 열었다. 다음 사용 시 재확인.
- 백업 `data/backups/ncos-before-web-20260906-223640-689322.db` (mode600). Keyword13 / Draft20 / DraftVersion21 / Publication0 / DiscoveryRun6 동일. 성과 채널/표는 운영에0건이며 가상 자료를 넣지 않았다.
- 외부 생성·네이버 입력·실제 광고 조회 없이 격리 UI를 검수했다. 320/430/768/1280/1440px 성과·가져오기 가로 넘침 없음, 콘솔 경고/오류0. 임시 QA 서버3720/탭 종료.
- 최신 상세 및 한계는 `docs/20_full_function_review_20260906.md`. 큰 dirty tree와 기존 Lesson durable_ref 문제 유지, commit/push/stage 미실행.

### P2-A 이전 실행 인수 (당시 이력)
- 운영 URL: `http://127.0.0.1:3719/app/keywords`, PID26542 / exec70921 (다음 작업에서 재확인).
- 마지막 전체 검증 로그: `/tmp/ncos-p2-final-verify.log`, 427건 PASS.
- 백업: `data/backups/ncos-before-web-20260906-214828-120746.db` (mode600, Git 제외).
- 실제 일반 최신 수집 ‘유니버셜스튜디오재팬’: 2026-09-06 21:50 KST, Run#6, 후보20/호출10, 정상. 기존 원고20/버전21/발행0 유지. DiscoveryRun만5→6.
- 네이버/AI 원고 생성·네이버 임시저장은 이번 웹 검수에서 실행하지 않음. 다른 모드의 실제 권한은 별도 인수.
- 임시 P2 검수 harness는 `/tmp/ncos_p2_browser_qa.py`, 정식 `app:demo`가 아니다. P2-B 성과 이관부터 계속한다.

## 1. 제품 안전 경계

Naver Content OS는 키워드 조사 → 콘텐츠 플랜 → 근거 검토 → 초안 버전 → SmartEditor 임시저장을 연결하는 로컬 우선 도구다.

- 자동 공개 발행은 하지 않는다.
- Publisher Job은 SmartEditor **임시저장까지만** 수행한다.
- 실제 공개 콘텐츠는 사용자가 URL·제목·공개 사실을 확인해야 등록된다.
- SearchAd 계정 API는 조회 전용이며 공식 estimate URI 이외의 POST는 허용하지 않는다.
- 목록·FactPack·의도 보드·오늘의 추천은 로컬 DB만 사용하며 시작 시 외부 quota를 소비하지 않는다.
- `.env`, API Secret, Local Core token, SQLite DB, provider 전체 응답은 Git에 저장하지 않는다.

## 2. 이번 구현 결과

### 공식 Codex CLI 고품질 원고 경로

- `LLM_PROVIDER=codex_cli`를 기본 운영 설정으로 전환했다.
- Local Core는 공식 `codex login status`와 `codex exec`만 사용하며 credential 파일을 읽지 않는다.
- subprocess는 shell 없이 stdin prompt, `--ephemeral`, `--sandbox read-only`, config/rules 무시, 빈 작업 디렉터리, 환경변수 allowlist로 격리한다.
- 모델 기본값은 `gpt-5.6-sol`, reasoning은 `high`, timeout은 300초다.
- JSON Schema로 제목·10~14개 섹션·태그·사실 확인 경고를 강제한 뒤 기존 자동 품질 Gate를 통과한 원고만 저장한다.
- 동시 Codex 생성은 1건으로 제한하며 로그인 만료·사용량 한도·timeout·품질 실패를 구분해 안내한다.
- Extension 상태 문구는 `Codex 고품질 AI 연결됨 · ChatGPT 로그인`이며 OAuth/API key 입력 UI는 추가하지 않았다.
- 저품질 실패 시 Ollama나 skeleton으로 자동 폴백하지 않고 Draft도 저장하지 않는다.

### 실모델 품질 인수

- 정보형 Draft 18: 2,877자, 자동 검사 100점, 주 3회 글쓰기 루틴의 준비·실행·점검 흐름 확인.
- 후기형 Draft 16: 2,677자, 자동 검사 100점, 직접 사용한 것처럼 경험을 만들지 않고 비교 기준 중심으로 작성됨.
- 구매가이드 Draft 19: 3,148자, 자동 검사 100점, 가격·효능·제품명·건강 효과 단정 없이 확인 항목 중심으로 작성됨.
- 최초 Draft 15·17에서 검색 유래 질문이 다른 서비스·가전 문단을 섞는 문제를 발견했다. 원클릭 흐름에서 미승인 검색 질문을 prompt에서 제외하고 두 Draft는 보관했다.

### 콘텐츠 작업함과 이어쓰기

- `GET /v1/drafts`: 제목·키워드 검색, 사용자 상태 필터, 안정적인 cursor pagination
- Draft 요약에는 본문·prompt·provider payload가 포함되지 않는다.
- 상태: `editing`, `review_ready`, `archived`
- 사이드패널의 최근 작업과 Workspace 작업함에서 Extension 재시작 후 Draft를 다시 연다.

### 발행 콘텐츠 등록부

- `PublishedContent`가 실제 공개 URL의 source of truth다.
- 상태: `missing`, `draft_only`, `published`, `stale`, `archived`
- 실제 공개 후 90일 경계부터 `stale`이다.
- `draft_saved`만으로 공개 콘텐츠가 자동 생성되지 않는다.
- 등록은 `confirmed=true`, HTTP(S) URL, 제목, 미래가 아닌 공개 시각이 필요하다.

### FactPack 근거 브리프

- 저장된 `KeywordSnapshot`에서 검색량, Trend 요약, 질문, 검색 결과 metadata, 기회 점수를 추출한다.
- 근거마다 source, URL/내부 ID, 수집 시각, cache 여부, freshness, 선택 상태를 보존한다.
- provider 설명 본문·Secret·전체 payload는 FactPack과 LLM prompt에 포함하지 않는다.
- 선택 변경과 승인은 항상 새 `FactPackVersion`을 append한다.
- Draft가 FactPack을 사용할 때 keyword/snapshot/승인 버전을 LLM 호출 전에 검증한다.
- skeleton과 LLM Draft 모두 `fact_pack_id/version` lineage를 저장한다.

### 의도별 연관 키워드

- `intent-v1`: `informational`, `howto`, `eligibility`, `troubleshooting`, `comparison_review`, `commercial`, `local_visit`, `other`
- NFKC·공백 정규화와 결정적 한국어 marker 우선순위를 사용한다.
- SearchAd PC/MO·광고 경쟁, Organic 문서 수, 상대 Trend, 콘텐츠 상태를 합산하지 않고 나란히 표시한다.
- 재분석, Watchlist, 플랜 후보, 기존 공개 콘텐츠 열기 action을 제공한다.

### 오늘의 추천 작업

- `GET /v1/work/today?limit=5`
- 우선순위: 실패 복구 → 검수 대기 → 임시저장 후 미발행 → 90일 이상 공개 콘텐츠 → 상승 후보 미작성 → 고성과 광고 키워드 미작성
- 동일 Draft/keyword는 가장 높은 우선순위 하나만 남긴다.
- stale/partial 근거는 글 작성을 권하지 않고 `refresh_data`만 반환한다.
- 카드 action은 사용자가 누르기 전 상태 변경·외부 호출·Publisher Job을 시작하지 않는다.

### PC·모바일 비율 도넛

- SearchAd 월간 PC/MO 검색량만 사용한다.
- 정확한 두 값과 양수 합계가 있을 때만 CSS `conic-gradient` 도넛을 표시한다.
- 마스킹, null, 한쪽 결측, 합계 0은 `계산 불가`와 원시 상태로 표시한다.
- 텍스트 수치·비율·합계와 screen-reader label을 함께 제공한다.

## 3. 주요 파일

| 영역 | 파일 |
|---|---|
| 개발 계획 | `dev-plan/implement_20260903_083733.md` |
| DB 모델 | `apps/local-core/app/models_db.py` |
| Migration | `alembic/versions/e8c1f4a9b7d2_content_workflow.py` |
| Draft 작업함 | `apps/local-core/app/services/drafts.py` |
| 공개 등록부 | `apps/local-core/app/services/published.py` |
| FactPack | `apps/local-core/app/services/factpacks.py` |
| 의도 보드 | `apps/local-core/app/services/intent.py`, `python/intelligence/keyword/intent.py` |
| 오늘의 추천 | `apps/local-core/app/services/work.py` |
| REST API | `apps/local-core/app/api.py`, `apps/local-core/app/deps.py` |
| TypeScript 계약 | `packages/contracts/src/index.ts` |
| Core client | `apps/extension/lib/core.ts` |
| 사이드패널 | `apps/extension/entrypoints/sidepanel/App.tsx` |
| Workspace | `apps/extension/entrypoints/research/App.tsx` |
| 도넛 | `apps/extension/components/PcMobileDonut.tsx` |
| SmartEditor 인수 수정 | `python/publisher/health.py`, `page.py`, `editor.py`, `jobs.py`, `selectors.py` |
| 전용 Chrome 실행 | `scripts/start_chrome_automation.sh` |
| SmartEditor Dev Lesson | `docs/dev-lessons/DL-20260903T112430Z-5d87a2d5.md` |
| API 문서 | `docs/12_api_contracts_and_smoke_tests.md` |
| Codex CLI provider | `python/providers/llm/codex_cli.py` |
| 구조화 출력 schema | `python/providers/llm/schemas/blog_article_v1.json`, `blog_expansion_v1.json` |
| 완성 글 Composer | `apps/local-core/app/services/composer.py` |
| 최신 개발 계획 | `dev-plan/implement_20260906_083105.md` |
| 성과 서비스·DB | `apps/local-core/app/services/performance.py`, `apps/local-core/app/models_db.py` |
| 성과 migration | `alembic/versions/b1f6e8a2c9d4_performance_feedback_loop.py` |
| 성과 UI·가져오기 | `apps/extension/entrypoints/research/PerformanceWorkspace.tsx`, `apps/extension/lib/performance-import.ts` |
| 브라우저 없이 검증 | `scripts/test_performance_without_chrome.sh`, `docs/16_performance_import_and_browserless_testing.md` |

## 4. API 추가분

| Method | Endpoint |
|---|---|
| `GET` | `/v1/drafts` |
| `PATCH` | `/v1/drafts/{draft_id}/status` |
| `POST/GET` | `/v1/published-contents` |
| `PATCH` | `/v1/published-contents/{content_id}` |
| `POST` | `/v1/factpacks` |
| `GET` | `/v1/factpacks/{fact_pack_id}` |
| `POST` | `/v1/factpacks/{fact_pack_id}/versions` |
| `GET` | `/v1/snapshots/{snapshot_id}/intent-board` |
| `GET` | `/v1/work/today` |
| `GET` | `/v1/llm/status` |
| `POST` | `/v1/blogs/compose` |

모든 `/v1/*` 요청은 `X-Local-Token`이 필요하다.

## 5. 19시 검토 당시 자동 검증 결과 — 최신 웹 검증은 상단/아래 실행 기록 참조

| 검증 | 결과 |
|---|---|
| Python non-live | `267 passed, 4 deselected, 1 warning` |
| Extension Vitest | `74 passed` / 11 files |
| TypeScript | 통과 |
| Extension production build | 통과, 총 `441.23KB` |
| Python compileall | 통과 |
| Runtime/Secret 추적 검사 | 통과 |
| `git diff --check` | 통과 |
| Alembic clean upgrade | `b1f6e8a2c9d4 (head)` 통과 |
| Alembic downgrade/upgrade | `e8c1f4a9b7d2 → b1f6e8a2c9d4 → e8c1f4a9b7d2 → b1f6e8a2c9d4` 통과 |
| 합성 기존 데이터 migration | 기존 Keyword·Draft·원문·발행 글 보존, FK/삭제 cascade 확인 |
| 실제 로컬 DB migration (이전 작업 기록·이번 실행 아님) | `e8c1f4a9b7d2 (head)` 적용, 기존 데이터 보존 확인 |
| 로컬 콘텐츠 흐름 | snapshot 13 → FactPack 1 승인 v2 → Draft 6 v1/v2 lineage 확인 |

19시 검토 당시 production build는 `441.23KB`였다. 완성 글 단일 흐름, Codex 상태·오류 안내, 자동 검사 결과, 참고 사진·출간 설정·내 성과 P0~P3 UI가 포함됐으며 새 runtime dependency는 추가하지 않았다.

## 6. 로컬 환경 — 기존 기록, 최신 서버/DB는 아래 20:34 기록 참조

- Node.js: `v24.13.1`
- Local Core `127.0.0.1:3719`: 작성 시점 **기동 중**, `/health` 정상
- 전용 Chrome CDP `127.0.0.1:9222`: listener 존재, NAVER 로그인 완료
- 전용 Chrome 실행 시 현재 production extension을 `--load-extension`으로 자동 적용
- `LLM_PROVIDER=codex_cli`
- `CODEX_CLI_MODEL=gpt-5.6-sol`, `CODEX_CLI_REASONING=high`
- `codex login status`: ChatGPT 로그인 확인, `/v1/llm/status`: `ready=true`, `auth=chatgpt`
- Extension 산출물: `apps/extension/dist/chrome-mv3/manifest.json` 존재
- Local token: `data/local_core_token.txt`, 권한 `600`
- 로컬 DB 원본은 `e8c1f4a9b7d2`까지 migration 완료
- 실모델 QA에서 생성된 부적합 Draft `5, 7, 10, 11, 12, 13, 14, 15, 17`은 보관 처리해 최근 작업에서 숨김

## 7. 실행 방법

```bash
cd /Volumes/Eprojects/project_202609/naver-content-os
uv run uvicorn app.main:app \
  --app-dir apps/local-core \
  --host 127.0.0.1 \
  --port 3719
```

```bash
pnpm build:ext
```

Chrome에서 압축해제 확장으로 선택할 경로:

```text
/Volumes/Eprojects/project_202609/naver-content-os/apps/extension/dist/chrome-mv3
```

사이드패널의 Local Core 토큰에는 다음 파일의 **경로가 아니라 내용**을 넣는다.

```text
/Volumes/Eprojects/project_202609/naver-content-os/data/local_core_token.txt
```

## 8. 남은 실사용 인수

자동 검증과 기존 SmartEditor 제목·본문 입력·임시저장 인수는 통과했다. 새 기본 흐름은 `주제 입력 → 완성 글 만들기 → 확인/수정 → 네이버 임시저장`으로 구현됐다.

실브라우저에서 비동기 editor canvas, custom caret paragraph, 입력 중 선행 자동저장을 확인해 Publisher readiness·editability·저장 baseline을 보정했다. Job 6은 화면의 `임시저장이 완료되었습니다.` 알림과 저장 개수 `2`를 근거로 `draft_saved`로 조정했으며 Draft 목록에서도 최신 Job 상태가 유지된다. 임시저장 2건이 존재하고 공개 발행은 발생하지 않았다.

1. Chrome 확장 관리에서 최신 `apps/extension/dist/chrome-mv3` 빌드를 reload한다.
2. 430px 사이드패널에서 `Codex 고품질 AI 연결됨 · ChatGPT 로그인` 문구와 생성·수정 저장·출간 설정·임시저장 진입을 확인한다.
3. 사용자가 네이버에서 직접 공개한 뒤 `발행 완료 등록`을 수행한다.

Research live smoke는 API quota를 사용하므로 사용자 승인과 자격증명이 있을 때만 별도로 실행한다.

## 9. 다음 작업 원칙

- 작업 트리를 reset하거나 기존 변경을 버리지 않는다.
- 사용자가 별도로 요청하기 전 커밋·푸시하지 않는다.
- 실브라우저 인수 전 자동 공개 기능을 추가하지 않는다.
- SmartEditor DOM 변경은 실제 실패 evidence가 있을 때만 selector를 수정한다.
- 최종 인수 후 `dev-plan/implement_20260903_083733.md`의 실브라우저·live smoke 항목만 실제 결과에 따라 체크한다.

## 10. 2026-09-04 완성 글 기본 흐름 개편

- 계획: `dev-plan/implement_20260904_174104.md`
- 신규 API: `GET /v1/llm/status`, `POST /v1/blogs/compose`
- 신규 서비스: `apps/local-core/app/services/composer.py`
- 품질 Gate: `python/planner/article_quality.py`
- 기본 사이드패널: `주제 → 완성 글 만들기 → 수정 저장 → 네이버 임시저장`
- 기존 분석·급상승·FactPack·15편 플랜은 `상세 도구`로 이동
- 이미지 모드는 기본 화면에서 제거하고 원고 결과의 `참고 사진 찾기`로 재정의
- 네이버 블로그 ID와 기본 태그는 Extension local storage에 1회 저장
- Ollama는 JSON schema 구조화 출력으로 제목·본문만 생성하며 사고 과정, placeholder, 문장 반복, 키워드 도배, 고위험 민감정보 조언이 검출되면 저장하지 않음
- 실모델 QA에서 `qwen3:4b`, `qwen3:8b`, `qwen2.5:14b-instruct-q3_K_M`의 반복·근거 없는 내용·위험 조언을 확인했다. 로컬 모델 연결은 유지하되 운영 원고 품질이 승인됐다고 간주하지 않음
- 화면의 점수 명칭을 `품질`이 아닌 `자동 검사`로 바꾸고 사실 정확성은 사용자가 확인해야 함을 명시
- 공식 Codex CLI subprocess provider를 추가하고 제3자 proxy 자동 기동 경로를 제거
- ChatGPT OAuth 로그인은 CLI 내부에서만 처리하며 앱은 credential 파일의 존재 여부나 내용도 읽지 않음
- 실모델 정보형·후기형·구매가이드 인수를 통과했고, 미승인 검색 질문의 주제 혼입 문제를 수정함

## 11. 2026-09-06 Advisor 성과 연동 계획

- 전문가 검토: `docs/15_advisor_performance_expert_review.md`
- 개발 계획: `dev-plan/implement_20260906_083105.md`
- Creator 게시물·검색어, Biz 기여 집계, Search Advisor 독립 웹 성과를 CSV/TSV로 가져오는 로컬 연동을 구현했음
- `내 콘텐츠 성과 → 설명 가능한 개선 추천 → 제목 개선·본문 최신화·후속 글 Draft` 폐루프를 연결했음
- 공식 읽기 API를 가정하지 않고 앱 CSV/표 입력 기반 MVP부터 시작
- 내부 API 역분석, cookie/token 복사, 무인 스크래핑, 고객·주문 단위 저장은 제외
- 기본 사이드패널은 `완성 글 만들기`를 유지하고 성과 기능은 `오늘 할 일`과 `내 성과`로 단순화
- SearchAd·Trend·SERP·Creator·Biz·Search Advisor 숫자를 합산하지 않고 source별로 나란히 표시
- 중복 snapshot 멱등성, 원본 파일 비저장, 열 allowlist, credential URL·고객/주문 열 거부를 구현
- SmartStore 공식 `nt_*` 규칙 추적 링크와 독립 웹사이트 전용 Search Advisor 경계를 구현

## 12. 성과 P0~P3 운영·인수 상태

- Chrome 없이 전용 검증: `pnpm test:performance`
- 테스트 계층: Python unit/integration, Vitest happy-dom, TypeScript, Alembic 순환, production build
- 전체 API: `/v1/performance/metric-dictionary`, `/channels`, `/imports`, `/overview`, `/contents`, `/queries`, `/recommendations`, `/tracking-links`
- 추천 카드는 읽기 전용이며 사용자가 작업 유형을 누른 후에만 기존 완성 글 흐름으로 전환됨
- 실제 계정으로 남은 항목: Creator/Biz/Search Advisor 표 헤더 호환성, 430px 사이드패널 표시, Extension reload 후 SmartEditor 회귀
- 자세한 사용·보안·테스트 계약: `docs/16_performance_import_and_browserless_testing.md`


## 2026-09-06 19시 개발 검토 후 보완

- 제목-only ID 충돌, 결측/대기 합산, 기간·대상 비교, 과거 추천 노출, 후속 글 중복, 추적 ID 충돌·귀속 불일치 수정.
- 미리보기 변경/지연응답/연속 저장을 차단하고 정규화된 행을 확인하게 했다.
- 개선 원고에 `source_draft_mode=revision|followup` 추가. 주제 변경 시 기존 참조와 추천 연결을 해제한다. 성공한 요청에만 추천 완료를 1회 연결한다.
- `performance-v2` 적용. 기존 자료를 명시적으로 다시 저장하면 snapshot 중복 없이 재계산하며 done/dismissed를 보존한다.
- Python 267 + Extension 74 = 341 통과. `pnpm test:performance`에 새 회귀·Alembic 테스트를 편입했다.
- 이번에는 운영 DB·실계정·실모델·Chrome/SmartEditor를 사용하지 않았고 서버 재시작·확장 reload·Git 작업도 수행하지 않았다.
- P2 잔여: 채널 선택 요약, Trend 지수 화면, URL 별칭, 누적 데이터 성능 검증. 실제 표와 새 원고의 사람 검수는 별도다.
- 기존 Dev Lesson 검색은 `LESSON_CORPUS_INVALID`로 실패했다. 새 회귀 예방 계약은 `docs/12_api_contracts_and_smoke_tests.md`와 현 계획에 기록했고, 기존 lesson을 임의 수정하거나 Git stage하지 않았다.

## 2026-09-06 20:34 독립 웹앱 실행 기록

- 최신 서버 PID 31623 / exec 세션 97423, `http://127.0.0.1:3719/app/` 실행 중. 다음 작업에서 PID·버전·연결 상태를 다시 확인한다.
- 실행기 백업: `data/backups/ncos-before-web-20260906-203411-045912.db`, 모드 0600, Git 제외.
- 운영 DB revision은 `b1f6e8a2c9d4`, 원고 20개·버전 21개·키워드 13개·공개 기록 0개 보존, integrity_check=ok.
- 일반 인앱 브라우저 웹 세션 연결·원고 목록·Codex CLI 모델 준비 상태 확인. 운영 AI 생성/네이버 저장은 새로 실행하지 않았다.
- 격리 검수 서버 3720은 종료했다. 기존 사용자 Chrome의 확장 reload나 확장 페이지 자동화는 수행하지 않았다.
- 전체 verify 373건 PASS. 웹·확장 production build 통과. 실행·연결은 됐지만 P1 전체/P2/P3 완료는 아니다.

## 2026-09-06 P1 잔여 작업 완료
- 공유 UI: `ContentPlanner`, `FactPackEditor`, `TodayWork`, `ImprovementQueue`, `improvement.ts`. 기존 extension 성과 deep link helper는 공유 계약을 재export한다.
- 근거 선택/버전 승인, 15편·8유형 플랜, 상세 AI/구조 원고 구분, 불변 근거 lineage, 승인 동시 충돌 보호를 추가했다.
- Writer 요청별 source/recommendation 귀속, 수동 주제 변경 시 연결 해제, 늦은 완료·실패한 완료 표시만 재시도를 검증했다.
- 원고 재열기와 `기존 임시저장 작업 다시 확인`은 최신 Job GET만 수행한다. 응답 유실 이후 새 Job 확인 전 재POST 금지. 명시적 409 거부는 최신 원고 비교로 안내한다.
- 공개 기록 보관/복원·원문 링크, 오늘 할 일의 원고/성과/분석/관심 갱신 연결을 제공한다.
- 신규 검수 범위: 웹 38개 테스트, Python 288개, extension 74개 = 400. P1 임시 격리 DB의 실제 브라우저 승인→구조 생성→편집 저장→재열기, 5개 너비 검수. 실제 AI·네이버 호출은 하지 않았다.
- 다음 단계: P2-A 키워드 입력 추천/상승 후보/맵·의도·상업성/특화자료 → P2-B 성과 가져오기·집계·추적 → P2-C 현재 탭 연결. P3 demo 환경은 여전히 미구현.

## 2026-09-06 21:11 KST 최신 실행 상태
- 운영 서버를 최종 P1 검증 코드로 재시작했다. PID `80518`, Codex exec 세션 `2858`, URL `http://127.0.0.1:3719/app/write`. PID/세션은 다음 작업에서 재확인한다.
- 백업: `data/backups/ncos-before-web-20260906-211048-755711.db`, Git 제외, 0600. Keyword 13 / Draft 20 / DraftVersion 21 / PublishedContent 0 유지, integrity_check=ok.
- 최신 실제 웹 화면에서 ‘오늘 이어서 할 일’ 및 ‘근거와 플랜으로 쓰기’ 반영·기존 웹 세션 연결 확인, console warning/error 없음. 운영 자료 생성·수정·실제 AI/네이버 저장은 하지 않았다.
- 임시 검수 서버 3720은 종료. 테스트 장치 `/tmp/ncos_p1_browser_qa.py`, 임시 DB `/tmp/ncos-web-p1-qa/content.db`는 제품 demo가 아니다.
- 최종 검증 로그 `/tmp/ncos-web-p1-release-verify.log`: Python 288 + Extension 74 + Web 38 = 400, 두 빌드/typecheck/parity/clean migration PASS. `git diff --check` PASS. 이번 작업도 커밋·푸시하지 않았다.
