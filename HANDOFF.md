# HANDOFF — Naver Content OS

- 갱신 시각: `2026-09-03 20:25 KST`
- 저장소: `coreline-ai/naver-contents-os`
- 브랜치/기준 커밋: `main` / `106f896`
- 현재 계획: `dev-plan/implement_20260903_083733.md`
- 상태: **Phase 1~6 및 SmartEditor 임시저장 인수 완료, Phase 7 Extension UI·수동 공개 등록 인수 남음**
- Git: 커밋·푸시하지 않은 dirty working tree

## 1. 제품 안전 경계

Naver Content OS는 키워드 조사 → 콘텐츠 플랜 → 근거 검토 → 초안 버전 → SmartEditor 임시저장을 연결하는 로컬 우선 도구다.

- 자동 공개 발행은 하지 않는다.
- Publisher Job은 SmartEditor **임시저장까지만** 수행한다.
- 실제 공개 콘텐츠는 사용자가 URL·제목·공개 사실을 확인해야 등록된다.
- SearchAd 계정 API는 조회 전용이며 공식 estimate URI 이외의 POST는 허용하지 않는다.
- 목록·FactPack·의도 보드·오늘의 추천은 로컬 DB만 사용하며 시작 시 외부 quota를 소비하지 않는다.
- `.env`, API Secret, Local Core token, SQLite DB, provider 전체 응답은 Git에 저장하지 않는다.

## 2. 이번 구현 결과

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

모든 `/v1/*` 요청은 `X-Local-Token`이 필요하다.

## 5. 자동 검증 결과

| 검증 | 결과 |
|---|---|
| Python non-live | `186 passed, 4 deselected, 1 warning` |
| Extension Vitest | `47 passed` / 7 files |
| TypeScript | 통과 |
| Extension production build | 통과, 총 `372.33KB` |
| Python compileall | 통과 |
| Runtime/Secret 추적 검사 | 통과 |
| `git diff --check` | 통과 |
| Alembic clean upgrade | `e8c1f4a9b7d2 (head)` 통과 |
| Alembic downgrade/upgrade | `e8c1f4a9b7d2 → d73a91c5e4f2 → e8c1f4a9b7d2` 통과 |
| 기존 DB 사본 migration | 기존 Draft 5개·Version 5개 보존, 신규 column/table 확인 |
| 실제 로컬 DB migration | `e8c1f4a9b7d2 (head)` 적용, 기존 데이터 보존 확인 |
| 로컬 콘텐츠 흐름 | snapshot 13 → FactPack 1 승인 v2 → Draft 6 v1/v2 lineage 확인 |

빌드 크기는 이전 `331.07KB`에서 `372.33KB`로 `41.26KB` 증가했다. 신규 Workspace 화면과 FactPack/의도/추천/도넛 UI가 포함된 결과이며 새 chart dependency는 없다.

## 6. 현재 로컬 환경

- Node.js: `v24.13.1`
- Local Core `127.0.0.1:3719`: 작성 시점 **기동 중**, `/health` 정상
- Ollama `127.0.0.1:11434`: listener 존재
- 전용 Chrome CDP `127.0.0.1:9222`: listener 존재, NAVER 로그인 완료
- 전용 Chrome 실행 시 현재 production extension을 `--load-extension`으로 자동 적용
- `LLM_PROVIDER=local`
- `OLLAMA_MODEL`: 비어 있음. 실행 시 설치 모델 목록의 첫 항목을 선택하는 기존 동작
- Extension 산출물: `apps/extension/.output/chrome-mv3/manifest.json` 존재
- Local token: `data/local_core_token.txt`, 권한 `600`
- 로컬 DB 원본은 `e8c1f4a9b7d2`까지 migration 완료
- 인수 검증 데이터: FactPack `1` 승인 v2, Draft `6` 구조 초안 v1·검수본 v2

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
/Volumes/Eprojects/project_202609/naver-content-os/apps/extension/.output/chrome-mv3
```

사이드패널의 Local Core 토큰에는 다음 파일의 **경로가 아니라 내용**을 넣는다.

```text
/Volumes/Eprojects/project_202609/naver-content-os/data/local_core_token.txt
```

## 8. 남은 실사용 인수

자동 검증, Local Core의 `FactPack 생성·승인 → lineage 연결 초안 → 새 버전 저장 → 오늘의 작업/의도 보드 조회`, 로그인된 SmartEditor의 제목·본문 입력과 임시저장까지 끝났다.

실브라우저에서 비동기 editor canvas, custom caret paragraph, 입력 중 선행 자동저장을 확인해 Publisher readiness·editability·저장 baseline을 보정했다. Job 6은 화면의 `임시저장이 완료되었습니다.` 알림과 저장 개수 `2`를 근거로 `draft_saved`로 조정했으며 Draft 목록에서도 최신 Job 상태가 유지된다. 임시저장 2건이 존재하고 공개 발행은 발생하지 않았다.

1. 확장 reload 후 사이드패널과 `research.html`을 연다.
2. Draft `6`을 `최근 작업 계속`에서 열고 FactPack `1` 승인 v2 lineage를 화면에서 확인한다.
3. 사용자가 네이버에서 직접 공개한 뒤 `발행 완료 등록`을 수행한다.
4. 오늘의 작업에서 미발행 추천이 사라지고 공개 등록부에 표시되는지 확인한다.
5. 430px 폭에서 도넛·FactPack·최근 작업 UI overflow와 keyboard focus를 확인한다.

Research live smoke는 API quota를 사용하므로 사용자 승인과 자격증명이 있을 때만 별도로 실행한다.

## 9. 다음 작업 원칙

- 작업 트리를 reset하거나 기존 변경을 버리지 않는다.
- 사용자가 별도로 요청하기 전 커밋·푸시하지 않는다.
- 실브라우저 인수 전 자동 공개 기능을 추가하지 않는다.
- SmartEditor DOM 변경은 실제 실패 evidence가 있을 때만 selector를 수정한다.
- 최종 인수 후 `dev-plan/implement_20260903_083733.md`의 실브라우저·live smoke 항목만 실제 결과에 따라 체크한다.
