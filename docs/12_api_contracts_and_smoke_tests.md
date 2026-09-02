# 12. API 계약·캐시·스모크 테스트

## 목적

외부 API 응답을 UI와 점수 계산에 바로 연결하지 않고 Provider 계약으로 정규화합니다. 이렇게 해야 API 변경, 결측값, 429, DOM 변경이 전체 제품에 전파되지 않습니다.

## Provider 경계

```text
NaverHubSearchClient
  ├─ search_blog()
  ├─ search_cafe()
  ├─ search_kin()
  ├─ search_web()
  ├─ search_news()
  └─ search_news_latest(sort=date, display<=100)

NaverHubTrendClient
  ├─ get_search_trend()
  └─ get_search_trends(start_date, end_date, time_unit=date)

NaverHubShoppingClient
  └─ get_keyword_trends(start_date, end_date, time_unit=date)

NaverSearchAdClient
  └─ get_related_keywords()

BrowserParser
  ├─ parse_serp()
  ├─ parse_blog_post()
  └─ check_smarteditor_health()
```

## 정규화 모델

```text
KeywordMetric
  keyword
  monthly_pc_searches
  monthly_mobile_searches
  monthly_total_searches
  ad_competition
  ad_click_metrics
  collected_at
  source=SEARCH_AD

SearchLandscape
  keyword
  blog_total
  cafe_total
  kin_total
  web_total
  news_total
  top_results[]
  collected_at
  source=NAVER_API_HUB

TrendSeries
  keyword_group
  keywords[]
  period
  ratio
  device
  gender
  ages[]
  collected_at
  source=NAVER_API_HUB
```

모든 모델은 `source`, `collected_at`, `raw_schema_version`을 가져야 합니다. 원본 응답은 디버깅 목적으로 암호화하지 않은 채 무기한 저장하지 않고, 필요한 필드만 정규화해 DB에 저장합니다.

## SearchAd 서명 구현 주의점

```text
message = timestamp + "." + method + "." + uri
signature = Base64(HMAC_SHA256(secret_utf8, message_utf8))
```

- `method`는 대문자 `GET`.
- `uri`는 `/keywordstool`이며 query string을 포함하지 않음.
- timestamp는 밀리초 단위 문자열.
- Secret을 Base64 decode하지 않고 UTF-8 바이트로 사용.
- 쿼리 인코딩은 실제 요청 URL 생성 단계에서 처리.
- 서버 시간 차이로 403이 발생할 수 있으므로 오류에 timestamp와 로컬 시간 상태를 포함하되 Secret은 제외.

## 캐시와 호출 제어

| 데이터 | 기본 TTL | 이유 |
|---|---:|---|
| SearchAd 키워드 | 24시간 | 변동이 실시간일 필요 없음, 429 완화 |
| API HUB Search `total` | 6~24시간 | 문서 수 변동과 쿼터 균형 |
| Search Trend | 24시간 | 과거 시계열은 자주 변하지 않음 |
| 일 단위 급상승 Trend/Shopping | 6시간 | 완료된 일 단위 비교와 수동 최신 수집 균형 |
| News 최신순 표본 | 15분 | 최근 기사 시각 반영, 검색 API 호출 억제 |
| SERP DOM snapshot | 1~6시간 | 순위 변동 관찰 목적 |
| Blog 공개 정보 | 6~24시간 | 공감·댓글 변동 가능 |

호출 정책:

1. 동일 파라미터는 요청 해시로 캐시.
2. 동시 요청 deduplication.
3. 429는 지수 백오프 + jitter.
4. SearchAd 키워드 도구는 동시성 1부터 시작.
5. 401/403은 자동 재시도하지 않고 인증 오류로 분리.
6. 월·일 사용량을 Local DB에도 누적해 콘솔 한도 전에 경고.
7. UI에서 강제 새로고침은 별도 액션으로 제공.

구현 계약상 cache hit는 사용량을 늘리지 않는다. 외부 전송은 일·월 한도를 원자적으로 예약한 뒤에만 수행하며 200 외의 4xx, 429 재시도, transport 실패도 시도 횟수로 집계한다. `Retry-After`는 초 단위와 HTTP-date 형식을 지원하고 provider별 RPS pacing과 동시성 제한을 함께 적용한다.

## 연관 추천·급상승 API

### `POST /v1/keywords/suggest`

- 한글/CJK 2자 또는 그 외 3자 이상, `limit<=8`만 허용합니다.
- Extension은 700ms debounce와 AbortController를 적용하고 SearchAd 24시간 cache를 사용합니다.
- SearchAd 실패 시 Extension의 최근 키워드 후보는 유지하며 자동 강제 새로고침하지 않습니다.

### `POST /v1/research/rising`

- mode: `general | local | shopping | news`
- candidate: SearchAd 검색량 보조 정렬 최대 20개
- window: KST 기준 오늘을 제외한 완료 14일, `recent7` 대 `previous7`
- batch: Search Trend 또는 Shopping Insight 5개씩 최대 4회
- news: 추세 상위 5개만 `sort=date&display=100`
- budget: SearchAd 1 + Trend/Shopping 4 + News 5 = 최대 10회
- persistence: `discovery_runs`에 정규화 결과와 `freshness-v1`만 저장하며 인증 header·secret·기사 전문은 저장하지 않습니다.

`GET /v1/research/rising/latest`는 같은 mode/seed/region/category의 마지막 로컬 수집 결과를 반환하며 외부 API를 호출하지 않습니다.

Search Trend ratio는 같은 요청 범위의 상대지수입니다. 변화율은 한 keyword series 안에서만 계산하고, 이전 평균 0에서 최근 값이 생기면 무한 퍼센트 대신 `new`로 반환합니다. 각 7일 구간 6일 이상, 전체 12/14일 이상 관측되지 않으면 `insufficient`입니다. 뉴스는 전체 발생량이 아니라 최대 100건 표본이므로 `news_7d_sample_count`와 `sample_capped`를 함께 표시합니다.

## API 스모크 테스트

실제 인증값을 사용하는 테스트는 기본 단위 테스트와 분리해 `smoke` marker로 실행합니다.

| 테스트 | 성공 기준 | 실패 시 분류 |
|---|---|---|
| API HUB 블로그 검색 | HTTP 200, `total`, `items` 존재 | auth/request/quota |
| API HUB Search Trend | HTTP 200, `results[].data[].ratio` 존재 | auth/schema/body |
| SearchAd keywordstool | HTTP 200, `keywordList` 존재 | signature/auth/rate-limit |
| Cache 재호출 | 외부 호출 없이 동일 정규화 결과 | cache |
| 429 처리 | backoff 후 제한 횟수 내 종료 | resilience |
| Secret 로그 검사 | 로그에 키·서명·헤더 없음 | security |

스모크 테스트 결과에는 요청 URL 경로, 상태 코드, 응답 스키마, 소요 시간만 기록합니다. Secret과 전체 헤더는 기록하지 않습니다.

## DOM Parser fixture 테스트

네이버 화면은 공식 API 계약이 아니므로 HTML fixture 기반 회귀 테스트가 필수입니다.

### SERP fixture

- 검색어
- 결과 순서
- 결과 유형
- 제목·URL·블로그 ID
- 설명·작성일
- 광고/일반 결과 구분 가능 여부

### Blog fixture

- 제목·작성일·본문
- 이미지·동영상·링크 개수
- 공감·댓글
- iframe/직접 렌더 두 경로
- 값이 없는 경우의 안전한 결측 처리

### SmartEditor health fixture/실브라우저 검사

- 로그인 상태
- 글쓰기 화면 진입
- 제목 입력 영역
- 본문 입력 영역
- 이미지 삽입
- 태그 입력
- 임시저장 버튼

Health Check 하나라도 실패하면 자동 입력을 시작하지 않습니다.

## V1 통합 인수 테스트

테스트 키워드 하나로 다음 흐름이 재현되어야 합니다.

1. SearchAd에서 연관키워드·검색량 수집
2. API HUB에서 Blog·Cafe·Kin·Web 결과 규모 수집
3. Search Trend 상대 추이 수집
4. 데이터 출처와 수집 시각 저장
5. Opportunity Score와 항목별 기여도 계산
6. 15편 콘텐츠 플랜 생성
7. 선택한 플랜을 초안으로 변환
8. Chrome SmartEditor에 입력
9. 임시저장 확인
10. 사용자가 최종 검토

첫 통합 성공 기준은 자동 발행이 아니라 **정확한 데이터 표시와 임시저장 성공**입니다.
