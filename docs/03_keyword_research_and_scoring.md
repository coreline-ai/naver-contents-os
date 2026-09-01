# 03. 키워드 분석·골든키워드·Opportunity Score

## 1) 기존 골든키워드(기존 방식)

기존 정의:

- `골든점수 = 월간 검색량 / 블로그 문서수`
- 값이 높고 경쟁이 상대적으로 낮은 키워드 상위 3개 선택

예시(문서의 예)

- 애드포스트: 30,000 / 300,000 = 0.10
- 애드포스트 승인: 8,000 / 30,000 = 0.267
- 애드포스트 재검수: 2,000 / 3,500 = 0.571

해석: 검색량 자체는 작아도, 경쟁 강도가 낮으면 효율적 키워드로 판단됨.

## 2) 한계
- 상위 검색 결과의 질을 반영하지 못함.
- “검색량/문서수”만으로는 실제 글작성 성과/노출 기여도를 가늠하기 어려움.

## 3) 확장 제안: Opportunity Score

권장 가중치(총 100):
- 검색량 25%
- 검색량 증가 추세 15%
- 블로그 경쟁 문서수 15%
- Top10 블로그 강도 15%
- Top10 콘텐츠 최신성 10%
- 검색 의도 일치도 10%
- 정확 키워드 제목 비율 5%
- 모바일 검색 비중 5%

목표는 기존 골든점수 + SERP 품질/최신성/의도 정합성을 결합해
실제 발행 가치가 높은 키워드 우선순위를 산정하는 것.

## 4) 예시 점수 해석
문맥상 제시된 샘플에서 Opportunity 91/100은
`애드포스트 승인 조건` 같은 키워드가 추천 사유(★★★★☆)에 부합.

## 5) API/데이터 인프라
`naver-keyword-tool`의 SearchAd는 공유 가능성 높음(중복 구현 불필요).
요구 정보:
- `NAVER_SEARCHAD_API_KEY`
- `NAVER_SEARCHAD_SECRET_KEY`
- `NAVER_SEARCHAD_CUSTOMER_ID`

공유 API 엔진으로 통합하면 파이프라인 중복 제거 가능.

## 6) 중요 변경: 네이버 API 허브 이전
2026-09-01 공식 문서 재확인 기준:
- 기존 `developers.naver.com` 기반 검색 API 신규 신청 방식은 중단.
- 신규는 **NAVER API HUB**로 이동.
- 예시 엔드포인트: `https://naverapihub.apigw.ntruss.com/search/v1/blog`
- 인증 헤더: `X-NCP-APIGW-API-KEY-ID`, `X-NCP-APIGW-API-KEY`
- 검색 API 문서는 일 25,000회, API HUB 개요는 NAVER 검색 카테고리 합산 월 775,000회와 Key당 50 RPS를 안내.
- 따라서 유효 한도는 `일 한도`, `월 한도`, `콘솔 사용자 한도`, `RPS`를 모두 만족해야 함.

따라서 기존 저장소는 **최우선 마이그레이션 대상**.

공식 근거: [이관 공지](https://developers.naver.com/notice/article/32530), [API HUB 개요](https://guide.ncloud-docs.com/docs/apihub-overview), [블로그 검색 API](https://api.ncloud-docs.com/docs/naver-api-hub-search-blog)

## 7) 데이터 의미를 분리해야 하는 이유

| 값 | 출처 | 정확한 의미 | 금지할 해석 |
|---|---|---|---|
| `monthlyPcQcCnt`, `monthlyMobileQcCnt` | SearchAd | 검색광고 키워드 도구의 월간 검색량 계열 | 블로그 유입 수 |
| Search Trend `ratio` | API HUB | 조회 구간의 최대값을 100으로 둔 상대 검색 추이 | 절대 검색량 |
| Search `total` | API HUB | 해당 검색 API가 반환한 총 결과 수 | 정확한 경쟁 난이도 또는 조회수 |
| 공감·댓글·이미지 수 | 공개 DOM | 화면에서 공개된 관측값 | 내부 통계 |
| Opportunity Score | 파생 계산 | 제품이 계산한 우선순위 | 네이버 공식 점수 |

Search Trend는 별도 요청 간 절대값 비교에 사용하지 않습니다. 같은 기간·같은 요청 그룹 안에서 방향성과 상대 추이를 해석하고, 절대 규모는 SearchAd 검색량으로 보완합니다. [검색어 트렌드 API](https://api.ncloud-docs.com/docs/naver-api-hub-search-trend)는 `ratio`가 구간 최대값 100 기준의 상댓값이라고 정의합니다.

## 8) V1 점수 계산 권장 규칙

1. 검색량과 문서 수는 편차가 크므로 `log1p` 정규화.
2. 결측 데이터는 0으로 오인하지 말고 `missing`으로 유지.
3. SearchAd의 PC·모바일 검색량은 원본과 합계를 모두 저장.
4. 트렌드 점수는 최근 구간 기울기와 전기 대비 변화율로 계산.
5. `total`은 경쟁 규모의 보조값으로만 쓰고 Top10 실제 품질 점수를 함께 사용.
6. 점수 산식과 가중치는 `score_version`으로 버전 관리.
7. 결과 화면에 원본 데이터, 계산일, 출처, 점수 버전을 표시.

초기 버전은 완벽한 100점 산식보다 **설명 가능한 점수**가 중요합니다. `왜 91점인지`를 항목별 기여도로 재현할 수 있어야 합니다.
