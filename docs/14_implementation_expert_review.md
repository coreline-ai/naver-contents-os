# 14. 구현 사항 전문가 상세 분석

검토 기준일: **2026-09-01**  
검토 기준 커밋: **`98b8e7a`** (`main`)  
검토 범위: Phase 1~6 전체 코드, 설정, DB migration, Python/TypeScript 테스트, 확장 빌드, 라이브 NAVER API 스모크 테스트

## 후속 안정화 구현 상태

### 2026-09-02 P0/P1 잔여 구현

`dev-plan/implement_20260902_112824.md`에 따라 실계정·실브라우저 검증을 제외하고 제품 흐름과 안전 실패 계약을 다음과 같이 연결했다.

- 사이드패널에 seed/연관 키워드의 PC·모바일·합계·모바일 비중·광고 경쟁·마스킹, 상대 Trend, cluster, API HUB/Browser SERP 근거를 표시하고 연관/cluster 키워드 재분석을 연결했다.
- Opportunity Score 응답과 공유 계약에 `coverage_weight`, 사용 가능/전체 component 수, `confidence`를 추가하고 UI에 표시했다.
- SERP parser가 미지 DOM을 실패로, 확인된 empty state를 정상 0건으로 반환하고 혼합 layout은 중복 제거 후 모두 수집한다.
- Gateway가 cache hit를 제외한 실제 전송 시도 직전에 일·월 한도를 원자적으로 예약하며 provider별 RPS와 숫자/HTTP-date `Retry-After`를 적용한다. 4xx·429 재시도·transport 실패 시도도 사용량에 포함된다.
- Draft 조회·편집·버전 append UI와 `POST /v1/drafts/{id}/publish-jobs`, `GET /v1/publish-jobs/{id}`를 추가했다. Publisher는 새 분석/초안을 만들지 않고 지정 Draft 최신 버전만 사용한다.
- SmartEditor 저장 성공은 완료 알림과 저장 전 fingerprint에서 달라진 지속 상태 DOM을 모두 요구한다. Health/입력/저장 실패 시 입력영역·프로필을 마스킹한 screenshot과 텍스트·입력값을 제외한 구조 DOM을 `data/publisher-artifacts/`에 남기고 Job history에는 경로만 기록한다.
- 공개 발행 action은 추가하지 않았고 Publisher 시작 전에 사이드패널 확인 대화상자를 요구한다.

현재 자동 검증은 Python non-live 136개와 Extension 23개로 **159개 통과**했다. TypeScript typecheck, production build, compileall, clean DB Alembic `8b9f2c1d4e7a (head)`, tracked Secret/runtime 검사도 통과했다.

최초 P0/P1 판정과의 대응은 다음과 같다.

| 최초 항목 | 현재 상태 |
|---|---|
| P0-1 제품 흐름 미연결 | 분석 → plan → Draft 생성/편집/version → Publisher Job까지 HTTP/UI 연결 완료 |
| P0-2 미지원 BlogType 기본 선택 | 기존 안정화에서 generation status와 첫 활성 유형 선택으로 해결 |
| P0-3 저장 성공 미확인 | 독립 신호 2개와 실패 evidence로 해결, 실DOM 검증만 대기 |
| P0-4 Chrome 136+ CDP | 기존 전용 automation profile script로 해결, 사용자 로그인 검증 대기 |
| P1-1~5, 7~8 | 기존 안정화에서 type/cache/metric/validation/error/security/health 계약 해결 |
| P1-6 quota 모델 | 일·월 원자 예약, 실제 시도 계수, RPS, Retry-After로 해결 |
| P1-9 이미지 입력 | 텍스트·태그 V1 제외 범위로 명시, Health 필수 gate에 포함하지 않음 |
| P1-10 FactPack | 별도 생성 품질 확장 범위로 유지 |

현재 남은 차단 항목은 코드 미연결이 아니라 사용자의 네이버 세션과 명시적 승인이 필요한 **Extension 및 SmartEditor 실브라우저 인수 검증**이다. 아래 최초 분석 본문은 발견 당시 이력이며 현재 판정에는 이 절과 [09. 현재 구현 품질 평가](./09_quality_assessment.md)를 우선한다.

### 2026-09-02 현재 기능 안정화

`dev-plan/implement_20260902_095019.md`의 Phase 1~5에서 신규 기능을 추가하지 않고 다음 회귀를 보강했다.

- Analyze 통합 경로의 provider schema·transport·지속 429 부분 강하 검증
- Draft LLM 오류 provider 정합성과 snapshot 선검증, 실패 시 부분 row 부재 확인
- 예상 밖 브라우저 예외에서도 Publisher Job을 실패 이력으로 종료하고 임시저장 fallback 유지
- Extension keyword/SERP 변경과 지연 응답에서 이전 분석·초안이 복원되지 않도록 request epoch 검증
- Secret 없는 non-live GitHub Actions와 clean DB migration·runtime 파일 추적 검사

최신 non-live 검증은 Python 117개와 Extension 13개로 **130개 통과**했다. TypeScript typecheck, WXT production build, compileall, Alembic clean DB `f2c91d8a7b42 (head)`도 통과했다. FastAPI TestClient import의 Starlette deprecation warning 1건은 알려진 의존성 경고로 남아 있다.

아래 최초 분석의 발견 항목은 당시 상태를 보존한 이력이다. 현재 판정은 이 절과 [09. 현재 구현 품질 평가](./09_quality_assessment.md)를 우선한다.

### 2026-09-01 1차 후속 안정화

이 문서의 최초 분석 이후 `dev-plan/implement_20260901_222039.md`에 따라 다음 항목을 구현했다.

- Extension TypeScript 오류 13개 해결, WXT `browser` API 전환, version `0.2.0`
- whitespace/NFKC keyword 검증, SERP-query 일치 검증, exact SearchAd metric 보장
- cache 원본 `collected_at`과 `from_cache` provenance 보존
- transport/invalid JSON/schema 오류 표준화와 dedup lock 정리
- Local token startup 생성, token·SQLite 권한 `600`
- plan `generation_status`, Draft REST API, snapshot·provider·model·prompt lineage migration
- 사이드패널 구조/AI 초안 생성과 Blog Inspector 표시
- SmartEditor visible/enabled/editable Health Check, 단일 navigation, 실제 tag field 검사
- 임시저장 success signal 미확인 시 Job 실패 처리
- Chrome 136+ 전용 automation profile 실행 스크립트

당시 자동 검증은 Python non-smoke 91개, live smoke 3개, Extension 10개로 **104개 통과**했다. 이 문서 아래의 최초 발견 항목은 분석 이력으로 유지한다.

현재 남은 차단 항목은 사용자의 명시적 승인과 테스트 블로그가 필요한 **실브라우저 Extension 육안 확인 및 SmartEditor 임시저장 인수 테스트**다. 이미지 업로드는 이번 안정화 범위에서 제외했다.

## 1. 최종 판단

현재 구현은 단순 스캐폴드가 아니다. NAVER API HUB·SearchAd 수집, 정규화, 캐시, 점수 계산, 콘텐츠 플래너, 사이드패널, 초안 버전, SmartEditor 어댑터까지 **개발형 MVP의 주요 부품은 실제 코드로 존재**한다.

다만 제품 상태는 다음처럼 구분해야 한다.

- **키워드 수집·분석 코어:** 실제 사용 가능한 MVP 수준
- **분석 사이드패널:** 빌드 가능한 프로토타입 수준
- **콘텐츠 생성:** CLI 중심의 부분 구현
- **SmartEditor 임시저장:** 단위 테스트된 자동화 시제품이며 실브라우저 인수 검증 전
- **전체 사용자 흐름:** Extension → 초안 생성 → 수정 → 임시저장이 하나의 제품 흐름으로 아직 연결되지 않음

따라서 “Phase 1~6 코드가 있다”는 표현은 맞지만, “V1 제품이 완성됐다”거나 “바로 안정적으로 임시저장할 수 있다”는 판정은 이르다.

## 2. 구현 성숙도

| 영역 | 판정 | 전문가 의견 |
|---|---|---|
| 저장소·런타임 | 준비됨 | Python 3.12, uv lock, pnpm workspace, Alembic이 구성됨 |
| 외부 API 검증 | 준비됨 | HUB Blog/Trend와 SearchAd 라이브 스모크 테스트 통과 |
| Provider·Gateway | 조건부 준비 | 캐시·backoff·quota 기본 구조는 좋지만 오류·사용량·수집 시각 보완 필요 |
| DB·snapshot | 조건부 준비 | 핵심 테이블과 migration은 정상, lineage·보존정책·권한 보완 필요 |
| Opportunity Score | 실험용 V1 | 설명 가능하지만 결측 범위가 크고 점수 비교 신뢰도 표시가 없음 |
| 15편 플래너 | 실험용 V1 | 결정적 생성은 장점이나 생성 가능한 BlogType과 불일치 |
| Extension | 부분 준비 | 분석 UI는 존재하지만 typecheck 실패, Blog Inspector와 초안 흐름 미연결 |
| LLM 초안 | 부분 준비 | Ollama provider와 버전 저장은 있으나 모델·근거 데이터·출력 검증이 부족 |
| SmartEditor | 검증 대기 | 실DOM·실제 임시저장·저장 성공 확인이 검증되지 않음 |
| 운영·배포 | 미준비 | CI, 설치/기동 UX, 확장 버전, 자동 복구, 브라우저 E2E가 없음 |

## 3. 잘 구현된 부분

### 3.1 데이터 출처 분리와 결측 처리

`python/providers/models.py`는 SearchAd 검색량, API HUB 검색 규모·트렌드, Browser DOM 관측을 `DataSource`로 분리한다. `< 10` 검색량을 0으로 왜곡하지 않고 `volume_masked`와 `None`으로 유지하는 설계도 적절하다.

이 구조는 다음 오류를 예방한다.

- SearchAd 월간 검색량과 검색 API 문서 수 혼동
- Trend ratio를 절대 검색량으로 오해
- 데이터 미수집을 실제 0으로 표시
- 파생 점수와 원천 데이터 혼합

### 3.2 Provider 경계와 Gateway 공통화

`python/providers/gateway.py`에 다음 책임이 모여 있어 Provider 구현의 중복이 적다.

- 요청 해시 기반 TTL 캐시
- 동일 요청 in-process dedup
- Provider별 동시성 제한
- 429 exponential backoff와 jitter
- 자체 월간 quota guard
- 캐시 적중 시 외부 호출 및 사용량 증가 방지

Provider 패키지가 앱 DB 구현에 직접 의존하지 않고 Protocol로 저장소를 주입받는 점도 유지보수에 유리하다.

### 3.3 SearchAd 서명 구현

`python/providers/searchad/signature.py`는 다음 핵심 조건을 명확히 고정한다.

- `<timestamp>.<METHOD>.<uri>` 메시지
- query string 서명 금지
- millisecond epoch
- HMAC-SHA256 후 Base64
- Secret을 Base64 decode하지 않고 UTF-8 원문으로 사용

서명 단위 테스트와 라이브 `/keywordstool` 테스트가 모두 통과해 현재 인증 경로의 신뢰도는 높다.

### 3.4 로컬 우선 Secret 경계

NAVER API Secret은 Local Core의 `.env`에만 있고 Extension에는 Local Core token만 저장한다. `.env`는 Git에서 제외되고 파일 권한도 `600`이다. 네이버 ID/PW를 저장하지 않고 기존 브라우저 세션을 사용하려는 방향도 적절하다.

### 3.5 설명 가능한 점수

`python/intelligence/scoring.py`는 최종 점수만 반환하지 않고 구성요소별 weight, normalized value, points, raw 근거, missing 상태를 반환한다. `score_version="v1"`을 snapshot에 저장해 알고리즘 변경 가능성을 고려한 점도 좋다.

### 3.6 초안 원본 보존과 Job 이력

`DraftVersion`은 내용을 덮어쓰지 않고 version을 증가시키며, `PublishJob`은 단계별 상태와 오류를 기록한다. 자동 공개를 구현하지 않고 임시저장까지만 제한한 제품 원칙도 안전하다.

### 3.7 테스트 기반

Provider, Gateway, score, planner, draft version, publisher state machine, DOM parser fixture를 각각 분리해 테스트했다. 특히 Health Check 실패 시 에디터 입력이 0건인지 확인하는 테스트는 잘못된 입력을 막는 유효한 안전장치다.

## 4. 핵심 차단 이슈 — P0

### P0-1. 전체 제품 흐름이 HTTP/UI에서 연결되지 않음

Local Core의 공개 route는 다음 3개뿐이다.

- `GET /health`
- `GET /v1/handshake`
- `POST /v1/keywords/analyze`

`DraftService`, `SqlJobStore`, `PublishJobRunner`는 존재하지만 REST API에 연결되지 않았고 `scripts/run_publish.py` CLI에서만 사용된다. Extension도 분석 결과를 표시할 뿐 플랜 선택, 초안 생성, 버전 수정, 임시저장 시작 기능이 없다.

또한 Blog Inspector parser와 `MSG_GET_BLOG` 메시지는 구현됐지만 `App.tsx`에서 호출하지 않아 사용자 기능으로 노출되지 않는다.

**영향:** 프로젝트 핵심 목적인 `키워드 → 기획 → 초안 → SmartEditor 임시저장`이 한 화면에서 이어지지 않는다.

**필수 조치:** Draft/Job API와 사이드패널 action을 추가하고 분석 snapshot → plan item → draft → publish job ID를 연결해야 한다.

### P0-2. 기본 publish 실행 경로가 지원하지 않는 BlogType을 선택함

15편 플랜의 1번은 항상 `SERIES`다(`python/planner/series.py`). 그러나 LLM 생성이 활성화된 유형은 `HOWTO`, `POLICY`, `REVIEW` 세 개뿐이며 나머지는 `build_prompt()`에서 `ValueError`가 발생한다(`python/planner/templates.py`).

`scripts/run_publish.py`의 기본 `--order`는 1이므로 기본 실행은 LLM 경로에서 `SERIES` 생성 오류로 종료된다. 샘플 입력 기준 15편 중 7편이 현재 LLM 미지원 유형이었다.

**영향:** 사용자가 기본 옵션으로 E2E를 실행하면 초안 단계에서 실패할 수 있다.

**필수 조치:** 다음 중 하나를 선택해야 한다.

1. 플래너가 `generation_status`를 반환하고 기본 순번을 첫 활성 유형으로 선택
2. 8개 BlogType 전부 생성 가능하게 구현
3. 미지원 유형은 명시적 skeleton 모드로만 실행하고 UI에서 사전 경고

### P0-3. SmartEditor 임시저장 성공을 확인하지 않음

`SmartEditorAdapter.save_draft()`는 버튼 클릭이 예외 없이 끝나면 성공으로 간주한다. 저장 완료 toast, 네트워크 응답, draft 상태, 버튼 상태 변화 중 어느 것도 확인하지 않는다.

**영향:** 클릭이 무시됐거나 저장 요청이 실패해도 Job이 `draft_saved`로 기록될 수 있다.

**필수 조치:** 저장 후 최소 2개 신호를 확인해야 한다.

- 저장 완료 toast/문구
- 저장 API response 또는 네트워크 이벤트
- 임시저장 시간·상태 DOM 변화
- 재진입 시 동일 draft 존재

확인 실패 시 screenshot, DOM snapshot, 현재 URL을 증거로 남기고 Job을 실패 처리해야 한다.

### P0-4. 현재 CDP 실행 안내는 최신 Chrome에서 그대로 동작하지 않을 가능성이 높음

`python/publisher/browser.py`는 Chrome을 `--remote-debugging-port=9222`만으로 실행하도록 안내한다. Chrome 136부터 기본 Chrome 데이터 디렉터리에 대한 remote debugging switch는 무시되며, 비표준 `--user-data-dir`가 필요하다. Chrome은 자동화 시 별도 프로필 또는 Chrome for Testing 사용을 권고한다.

- [Chrome remote debugging 변경 공지](https://developer.chrome.com/blog/remote-debugging-port)
- [Playwright `connect_over_cdp` 문서](https://playwright.dev/python/docs/api/class-browsertype#browser-type-connect-over-cdp)

Playwright도 CDP 연결은 Playwright protocol보다 fidelity가 낮고, 직접 실행한 Chrome argument 차이로 기능 일부가 깨질 수 있다고 명시한다.

**영향:** 현재 명령으로는 9222 포트가 열리지 않거나, 사용자의 일반 프로필 로그인 세션을 그대로 재사용할 수 없을 수 있다.

**필수 조치:** 전용 자동화 프로필 디렉터리를 만들고 해당 프로필에 네이버 로그인을 1회 수행하는 공식 실행 스크립트를 제공해야 한다.

## 5. 높은 우선순위 이슈 — P1

### P1-1. Extension TypeScript typecheck 실패

확장 빌드는 통과하지만 `tsc --noEmit`은 `chrome` global 미정의와 message listener의 implicit `any`로 13개 오류가 발생한다. Vite/esbuild 빌드가 typecheck를 수행하지 않아 빌드 성공만으로 타입 안정성을 보장할 수 없다.

WXT 공식 문서는 브라우저 확장 API에 `browser` from `wxt/browser` 사용을 권장한다.

- [WXT Extension APIs](https://wxt.dev/guide/essentials/extension-apis)
- [WXT TypeScript Configuration](https://wxt.dev/guide/essentials/config/typescript)

**조치:** `chrome`을 WXT `browser`로 전환하고 listener sender/response 타입을 지정한 뒤 root script와 CI에 `typecheck`를 추가한다.

### P1-2. 캐시 응답도 새로 수집한 데이터처럼 timestamp가 갱신됨

Gateway는 `(body, from_cache)`를 반환하지만 HUB·SearchAd client는 `from_cache`를 버린다. 캐시된 raw body를 다시 모델로 만들면서 `now_utc()`를 넣기 때문에 실제 외부 수집 없이도 `collected_at`이 현재 시각으로 변경된다.

**영향:** UI와 snapshot이 캐시 데이터를 최신 외부 수집 데이터처럼 표시한다. 데이터 lineage와 freshness 판단이 왜곡된다.

**조치:** cache row의 원래 `created_at`을 Gateway 결과에 포함하고 Provider model의 `collected_at`에 전달한다. 응답에는 `cache_status`, `age_seconds`도 포함하는 것이 좋다.

### P1-3. 정확한 seed keyword가 없을 때 첫 연관 키워드를 seed metric으로 사용

`AnalyzeService._collect_searchad()`는 정확히 일치하는 row가 없으면 `rows[0]`을 seed metric으로 선택한다.

**영향:** 사용자가 입력한 키워드와 다른 연관어의 검색량이 메인 검색량과 Opportunity Score에 사용될 수 있다.

**조치:** exact/space-insensitive match가 없으면 `metric=None`으로 유지하고, 별도 `metric_match_status`를 반환해야 한다.

### P1-4. whitespace keyword와 SERP 불일치가 허용됨

Pydantic `min_length=1`은 공백 문자열을 통과시키고, 서비스 정규화 후 빈 문자열이 된다. 또한 Extension에서 현재 SERP를 가져온 뒤 키워드를 수동 변경해도 `serp` 상태를 지우지 않는다. Backend 역시 `serp.query`와 분석 keyword 일치 여부를 검증하지 않는다.

**영향:** 빈 키워드 호출 또는 다른 키워드의 SERP를 사용한 잘못된 score가 저장될 수 있다.

**조치:** trim 후 길이 validator, Unicode normalization, `compact(serp.query) == compact(keyword)` 검증을 추가한다. 키워드 input 변경 시 Extension의 SERP attachment도 해제해야 한다.

### P1-5. 외부 오류가 표준 오류 코드로 완전히 매핑되지 않음

Gateway는 HTTP status는 분류하지만 다음 오류를 변환하지 않는다.

- DNS/connection/timeout 등 `httpx` transport error
- JSON decode 실패
- 예상 schema 누락 및 Pydantic validation error

`SchemaError` 클래스는 존재하지만 실제 Provider에서 사용되지 않는다. 따라서 일부 장애는 `CoreError`로 degrade되지 않고 HTTP 500으로 전파될 수 있다.

**조치:** transport, JSON, schema 경계를 각각 `upstream_unreachable`, `invalid_json`, `schema`로 변환하고 retry 가능 여부를 분리한다.

### P1-6. quota guard가 실제 API 제한 모델을 충분히 반영하지 못함

현재 저장소는 월간 성공 호출만 집계한다. 429 retry와 4xx 요청은 카운트하지 않고, 일간 제한과 RPS limiter가 없다. `max_concurrency=1`은 동시 요청 수 제한이지 초당 요청 수 제한이 아니다. 서로 다른 cache key 요청은 월간 한도 확인과 증가 사이에 경합할 수 있다.

**조치:** 시도 횟수와 성공 횟수를 분리해 기록하고, 일/월/RPS token bucket, `Retry-After`, atomic quota reservation을 구현한다.

### P1-7. Local Core token과 DB 파일 권한

실제 파일 권한 점검 결과:

- `.env`: `600`
- `data/local_core_token.txt`: `644`
- `data/ncos.db`: `644`

또한 token 파일은 앱 시작 시 생성되지 않고 보호 endpoint가 처음 호출될 때 생성된다. 신규 사용자는 서버를 시작한 직후 UI 안내에 나온 token 파일을 찾지 못할 수 있다.

**조치:** startup에서 token을 원자적으로 생성하고 `0600`을 적용한다. SQLite 파일도 생성 직후 `0600`으로 변경한다. token rotation/pairing UX도 추가한다.

### P1-8. SmartEditor Health Check가 실제 상호작용 가능성을 보장하지 않음

현재 `exists()`는 locator count만 확인하며 visible, enabled, editable 상태를 검사하지 않는다. Health Check 후 `adapter.open()`이 다시 같은 URL로 이동하므로 검사한 DOM과 실제 입력 DOM이 다를 수 있다. `tag_input_reachable` 검사도 실제 tag input이 아니라 publish layer button만 확인한다.

**조치:** 한 번만 navigation하고 같은 page state에서 health와 입력을 이어가야 한다. `visible/enabled/editable`, iframe owner, selector uniqueness, tag layer open/close까지 검사한다.

### P1-9. 이미지 입력 기능은 Health selector만 있고 구현은 없음

`image_button`은 Health Check 필수 항목이지만 `SmartEditorAdapter`에는 이미지 삽입 method가 없다. 문서의 “제목·본문·이미지·태그 입력” 완료 기준과 구현이 일치하지 않는다.

**조치:** 이미지가 V1 필수라면 upload/placement/focus recovery를 구현한다. 아니라면 Health 필수 검사와 완료 문서에서 이미지 항목을 제거해 범위를 일치시킨다.

### P1-10. LLM 콘텐츠가 근거 데이터와 충분히 연결되지 않음

프롬프트에는 제목·키워드·angle·질문만 전달된다. 검색 결과, 공식 출처, 제품 사실, 사용자 경험 근거가 전달되지 않는다. REVIEW 템플릿은 “구체적 수치·기간이 있는 경험담”을 요구해 근거가 없을 경우 가상의 경험을 생성할 위험이 있다. POLICY/NEWS도 최신 사실 검증 단계가 없다.

**조치:** `FactPack`을 만들고 출처 URL·수집일·인용 가능한 사실·금지 주장·사용자 제공 경험을 분리한다. 생성 결과는 title length, minimum length, section completeness, unsupported claims 검사를 통과해야 저장하도록 한다.

## 6. 중간 우선순위 이슈 — P2

### 6.1 점수 비교 신뢰도

V1은 `top10_strength` 15%와 `intent_match` 10%가 항상 missing이므로 최대 데이터 coverage가 75%다. 추가 결측이 있으면 남은 가중치를 재정규화해 100점으로 표시한다. 따라서 coverage가 다른 키워드끼리 점수를 직접 비교하기 어렵다.

`score.value`와 함께 다음을 표시해야 한다.

- `coverage_weight`
- `available_component_count`
- `confidence`: low/medium/high
- ranking 가능 최소 coverage

### 6.2 Planner 품질

`trend` 인자를 받지만 실제 plan 생성에 사용하지 않는다. filler는 일반 문구와 `#2` suffix로 15개 수량을 맞추기 때문에 “정확히 15개”는 보장하지만 콘텐츠 차별성은 약하다. cluster와 Opportunity 기여도도 plan 선정 근거로 사용하지 않는다.

### 6.3 Contract drift 위험

FastAPI endpoint에 response model이 없고 TypeScript 계약은 Python Pydantic 모델을 수동 복제한다. `raw_schema_version`처럼 이미 차이가 있는 필드도 존재한다.

OpenAPI JSON을 개발 시 생성하고 TypeScript type/client를 자동 생성하거나, JSON Schema를 단일 정본으로 사용해야 한다.

### 6.4 DB lineage 부족

Draft가 어느 `keyword_snapshot`, plan item, prompt, LLM provider/model로 생성됐는지 저장하지 않는다. 재현성과 사실 검토를 위해 다음 필드가 필요하다.

- `snapshot_id`
- `plan_payload` 또는 `plan_item_id`
- `prompt_version`
- `provider`, `model`
- `generation_parameters`
- `fact_pack_version`

### 6.5 DB 운영

만료 cache는 해당 key 재조회 때만 삭제된다. snapshot과 Job history 보존 정책, expired cache cleanup, DB vacuum/backup, abandoned running job 복구가 없다.

### 6.6 Extension UI 미노출 데이터

Backend는 related keywords, trend points, clusters를 반환하지만 현재 사이드패널은 이를 표시하지 않는다. Blog Inspector도 미노출이다. 분석 제품의 핵심 근거를 사용자가 충분히 검토할 수 없다.

### 6.7 Extension 세부 품질

- manifest version이 없어 빌드 결과가 `0.0.0`
- component/UI test 없음
- `activeTab`과 `tabs` permission 중복 검토 필요
- token이 TanStack Query key에 포함됨
- unknown SERP DOM도 `ok=true, results=[]`로 처리돼 selector 파손과 실제 검색 결과 0건을 구분하지 못함
- mixed SERP layout에서는 첫 selector group만 처리해 일부 결과를 놓칠 수 있음

### 6.8 문서 상태 불일치

`docs/09_quality_assessment.md`와 `docs/13_development_kickoff_checklist.md`에는 여전히 “실행 코드 없음”, “SearchAd 미준비” 등의 과거 상태가 남아 있다. 반대로 개발 계획서는 Phase 6 완료로 표시하지만 실브라우저 인수 테스트는 미완료다.

문서의 상태는 `설계 완료`, `코드 완료`, `자동 테스트 완료`, `실환경 검증 완료`, `제품 연결 완료`로 분리해야 한다.

## 7. 검증 결과

| 검증 | 결과 |
|---|---|
| Python unit/integration | **68 passed**, smoke 3 deselected |
| 라이브 NAVER API smoke | **3 passed** (HUB Blog, Trend, SearchAd) |
| Extension parser fixture | **6 passed** |
| Extension production build | **PASS**, 단 version `0.0.0` 경고 |
| TypeScript `tsc --noEmit` | **FAIL**, 13 errors |
| Python compileall | **PASS** |
| Alembic current/head | **일치** (`a60d442bc8dd`) |
| Python dependency consistency | **PASS** |
| pnpm production audit | **알려진 취약점 0건** |
| SmartEditor live draft-save | **미실행/미검증** |
| Extension live page E2E | **미실행/미검증** |

Python 테스트에는 Starlette TestClient의 `httpx` 사용 방식에 대한 deprecation warning 1건이 있다. 즉시 장애는 아니지만 다음 의존성 갱신 전에 test client 전환을 준비해야 한다.

## 8. 권장 수정 순서

### Gate A — 기본 품질 복구

1. WXT `browser` API로 전환하고 TypeScript 오류 0개 달성
2. Extension version과 root `typecheck` script 추가
3. trim validator, SERP-query 일치 검증, seed metric exact match 수정
4. token startup 생성과 token/DB `0600` 적용

### Gate B — 콘텐츠 흐름 연결

1. Draft create/get/version API 구현
2. Analyze response의 plan item에서 초안 생성 버튼 연결
3. 지원 BlogType과 Planner 출력 계약 통일
4. snapshot/prompt/model lineage 저장
5. Ollama 모델 선택·상태 점검 UI 추가

### Gate C — 외부 데이터 신뢰성

1. cache provenance와 원래 collected_at 유지
2. transport/JSON/schema 오류 표준화
3. 일/월/RPS limiter와 atomic usage reservation
4. score coverage/confidence 표시
5. Trend·cluster를 실제 planner 근거로 사용

### Gate D — SmartEditor 실사용 승인

1. 전용 Chrome automation profile 실행 스크립트
2. live DOM selector 캡처와 fixture 작성
3. 단일 navigation + visible/enabled/editable Health Check
4. 제목/본문/태그 실제 입력 검증
5. 임시저장 성공 postcondition 2개 이상 확인
6. 실패 screenshot/DOM/network evidence 저장
7. 테스트 블로그에서 10회 반복 성공 후 V1 승인

## 9. 출시 판정 기준

다음 조건 전에는 “자동 임시저장 완료 제품”으로 표시하지 않는 것이 적절하다.

- TypeScript typecheck 0 errors
- Extension에서 분석 → plan 선택 → draft 생성 가능
- 지원되지 않는 BlogType 실행 경로 없음
- cache timestamp가 실제 수집 시각을 보존
- whitespace/SERP mismatch/metric fallback 데이터 오류 수정
- SmartEditor live E2E 10회 연속 성공
- 저장 성공 postcondition과 실패 증거 수집 동작
- token/DB 권한 600
- 문서 상태와 실제 구현 상태 일치

현재 가장 정확한 제품 표기는 다음과 같다.

> **“NAVER 키워드 수집·분석 코어와 콘텐츠 자동화 시제품이 구현된 개발형 MVP. SmartEditor 임시저장은 실환경 검증 전.”**
