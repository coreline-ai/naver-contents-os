# 10. NAVER API·계정·비용 준비

확인 기준일: **2026-09-01**

## 결론

V1 분석 기능에 필요한 외부 계정은 두 종류입니다.

1. **NAVER Cloud Platform → NAVER API HUB**
2. **NAVER 검색광고 → SearchAd API Manager**

브라우저에서 이미 로그인한 네이버 세션을 사용하므로 네이버 ID·비밀번호 저장이나 네이버 로그인 OAuth는 V1에 필요하지 않습니다. 글쓰기도 공개 Blog Write API가 아니라 SmartEditor 임시저장 어댑터로 처리합니다.

## 데이터 소스 지도

| 데이터 | 소스 | 필요도 | 비고 |
|---|---|---:|---|
| 블로그·카페·지식iN·웹·뉴스 결과 | API HUB Search | 필수 | `total`과 검색 결과 목록 |
| 검색 관심도 추이 | API HUB Search Trend | 필수 | 절대량이 아닌 상대 `ratio` |
| 쇼핑 클릭 관심도 | API HUB Shopping Insight | 조건부 | 쇼핑·제품 콘텐츠에 사용 |
| PC/모바일 월간 검색량 | SearchAd `/keywordstool` | 필수 | API HUB가 제공하지 않음 |
| 연관 키워드·광고 경쟁 지표 | SearchAd `/keywordstool` | 필수 | 검색광고 지표로 명확히 표시 |
| 현재 SERP·블로그 공개 정보 | Browser DOM | 필수 | API Key 없음, DOM 변경 리스크 |
| 글 생성 | Local/외부 LLM | 선택 | V2 연결됨 — 아래 "LLM 경로" 참조 |

## API HUB 이관 일정

- 2026-06-25: NAVER API HUB 정식 출시
- 2026-07-31: 개발자센터에서 Search·Search Trend·Shopping Insight 신규 신청 차단
- 2027-06-30: 기존 개발자센터 지원 종료
- 2027-07-01부터: 이관 대상은 NAVER API HUB에서만 사용

쇼핑·책·전문자료 검색 API는 HUB 이관 대상이 아니며 별도 종료 공지를 확인해야 합니다. 근거: [네이버 개발자센터 이관 공지](https://developers.naver.com/notice/article/32530)

## API HUB Application 선택안

### 최소 분석 MVP: 5개

- 검색어 트렌드
- 블로그
- 지식iN
- 카페
- 웹문서

### 현재 제품 범위 권장: 8개

- 최소 5개
- 뉴스
- 쇼핑 인사이트
- 오타변환

### 나중에 추가

- 이미지: 참고 이미지 검색 기능이 생길 때
- 지역: 플레이스·맛집·병원·미용실·여행 분석을 만들 때
- 성인 검색어 판별: 공개형 다중 사용자 검색 서비스로 확장할 때
- 백과사전: 사실·개념 보조 검색이 필요할 때

하나의 Application에 여러 API를 선택할 수 있습니다. Application 이름은 영문·숫자·`-`만 사용 가능하므로 `naver-content-os`가 적절합니다. 근거: [Application 등록 가이드](https://guide.ncloud-docs.com/docs/apihub-application)

## API HUB 인증과 기본 계약

필요한 값:

```dotenv
NAVER_HUB_CLIENT_ID=
NAVER_HUB_CLIENT_SECRET=
```

공통 URL과 헤더:

```text
Base URL: https://naverapihub.apigw.ntruss.com
X-NCP-APIGW-API-KEY-ID: <Client ID>
X-NCP-APIGW-API-KEY: <Client Secret>
```

첫 테스트 엔드포인트:

```text
GET  /search/v1/blog?query=테스트&display=10&start=1&sort=sim
POST /search-trend/v1/search
```

블로그 검색의 `display`는 1~100, `start`는 1~1000이며 응답 `total`을 경쟁 문서 규모의 보조값으로 사용할 수 있습니다. 근거: [블로그 검색 API](https://api.ncloud-docs.com/docs/naver-api-hub-search-blog)

Search Trend는 최대 5개 그룹을 요청할 수 있고 세부 API 문서에는 그룹당 최대 20개 검색어로 기재되어 있습니다. 반면 API HUB 개요 FAQ에는 더 보수적인 수치가 표시될 수 있으므로, 구현값을 설정으로 분리하고 초기 스모크 테스트에서 실제 허용값을 확인합니다. `ratio`는 조회 구간의 최대값을 100으로 둔 상대값입니다. 근거: [검색어 트렌드 API](https://api.ncloud-docs.com/docs/naver-api-hub-search-trend)

### V1에서 사용할 Search 엔드포인트

[12_api_contracts_and_smoke_tests.md](./12_api_contracts_and_smoke_tests.md)의 Provider 메서드가 호출하는 경로입니다.

| 콘텐츠 | Endpoint | V1 활용 |
|---|---|---|
| 블로그 | `GET /search/v1/blog` | 핵심 경쟁 분석, `total` 문서 규모 |
| 카페 | `GET /search/v1/cafearticle` | 커뮤니티 관심·후기 발굴 |
| 지식iN | `GET /search/v1/kin` | 실제 질문·FAQ 주제 추출 |
| 웹문서 | `GET /search/v1/webkr` | 전체 웹 경쟁 보조 지표 |
| 뉴스 | `GET /search/v1/news` | 최신 이슈·Trending 판단 |
| 오타변환 | `GET /search/v1/errata` | 입력 키워드 보정(선택) |
| 이미지 | `GET /search/v1/image` | V2 참고 이미지 검색(현재 미사용) |
| 트렌드 | `POST /search-trend/v1/search` | 상대 관심도 추이 |

`확인됨`: 2026-09-01 실 호출 검증 완료 — blog·cafearticle·kin·webkr·news는 200 + `total`/`items` 응답, errata는 200(별도 스키마), search-trend는 200 + `ratio` 응답을 확인했습니다(`scripts/verify_api_hub.py --all`). 이미지 경로만 미호출 상태로 남아 있습니다.

주의: HUB 검색 API는 JSON 본문을 `Content-Type: text/plain;charset=UTF-8`로 반환하므로 클라이언트는 content-type이 아니라 본문 파싱으로 판단해야 합니다.

## API HUB 비용과 한도

2026-09-01 현재 공식 문서는 API HUB를 **한시적 무료**로 안내하며 유료 전환 전에 별도 공지한다고 명시합니다. 장기 요금 모델이 종량제라는 설명과 현재 무료라는 상태를 구분해야 합니다. 근거: [NAVER API HUB 개요](https://guide.ncloud-docs.com/docs/apihub-overview)

| 구분 | 공식 안내 |
|---|---:|
| NAVER 검색 카테고리 | 월 합산 최대 775,000회 |
| 개별 Search 문서 | 일 25,000회 안내 |
| Search Trend | 월 50,000회 |
| Shopping Insight | 월 50,000회 |
| API Key Rate Limit | 최대 50 RPS |
| 월 한도 도달 시 | 추가 과금이 아니라 호출 차단 |
| 무료 기간 한도 증설 | 불가 |

일 25,000회와 월 775,000회는 동시에 적용되는 안전 한도로 취급합니다. 실제 호출 허용량은 다음 중 가장 먼저 도달한 한도에서 중단됩니다.

```text
min(일 한도, 월 한도, 콘솔 사용자 설정 한도, RPS 제한)
```

개발 초기 권장 자체 한도:

| API | 월 한도 예시 |
|---|---:|
| NAVER Search | 50,000 |
| Search Trend | 5,000 |
| Shopping Insight | 5,000 |

콘솔의 `Application → 한도 및 알림`에서 일·월 한도와 임계치 알림을 설정하고, **통보 대상자도 별도로 등록**해야 실제 알림을 받을 수 있습니다. 근거: [Application 이용 관리](https://guide.ncloud-docs.com/docs/apihub-application)

### 카드 등록 해석

NCP는 여러 유료 클라우드 서비스를 함께 제공하는 결제 플랫폼이므로 결제수단 등록 화면이 나타날 수 있습니다. 이것만으로 현재 한시적 무료인 API HUB가 즉시 유료 전환됐다는 뜻은 아닙니다. 다만 같은 계정에서 Server, Cloud DB, Storage 등 다른 유료 상품을 만들면 별도 과금될 수 있으므로 이번 프로젝트에서는 불필요한 NCP 리소스를 생성하지 않습니다.

## SearchAd 계정과 인증

발급 순서:

1. NAVER 검색광고 광고주센터 가입
2. 검색광고 관리시스템 접속
3. `도구 → API Manager`
4. API License 생성
5. 아래 세 값을 보관

```dotenv
NAVER_SEARCHAD_API_KEY=
NAVER_SEARCHAD_SECRET_KEY=
NAVER_SEARCHAD_CUSTOMER_ID=
```

공식 시작 가이드: [Naver Search AD API](https://naver.github.io/searchad-apidoc/), [공식 GitHub 저장소](https://github.com/naver/searchad-apidoc)

핵심 요청:

```text
GET https://api.searchad.naver.com/keywordstool
    ?hintKeywords=<keyword>
    &showDetail=1
```

필수 헤더:

```text
X-Timestamp
X-API-KEY
X-Customer
X-Signature
```

서명 메시지:

```text
<timestamp>.<METHOD>.<URI>
```

`URI`에는 `/keywordstool` 경로를 사용하고 쿼리 문자열을 서명 메시지에 붙이지 않습니다. Secret은 UTF-8 원문 바이트로 HMAC-SHA256을 계산한 뒤 Base64 인코딩합니다. 근거: [공식 signaturehelper.py](https://github.com/naver/searchad-apidoc/blob/master/python-sample/examples/signaturehelper.py)

SearchAd 키워드 도구는 다른 API보다 429 제한이 민감할 수 있습니다. 캐시, 지수 백오프, jitter, 동시 호출 제한이 필수입니다. 근거: [키워드 도구 429 가이드](https://naver.github.io/searchad-apidoc/notice/2020/12/18/notice/)

## LLM 경로 (V2, 2026-09-01 실호출 검증)

초안 생성 LLM은 `.env`의 `LLM_PROVIDER`로 선택합니다. API 키는 어느 경로에도 필요 없습니다.

| 경로 | 설정 | 필요 조건 | 특징 |
|---|---|---|---|
| Ollama (기본) | `LLM_PROVIDER=local` | `ollama pull <model>` | 데이터가 기기 밖으로 나가지 않음 |
| Codex OAuth 프록시 | `LLM_PROVIDER=openai_compat` | `codex login` 완료(`~/.codex/auth.json`) + 프록시 기동 | ChatGPT 구독 모델(gpt-5.4 계열) 사용, API 키 불필요 |
| 기타 OpenAI 호환 | `LLM_PROVIDER=openai_compat` + `OPENAI_COMPAT_BASE_URL` 변경 | LM Studio·ChatMock 등 | 동일 Provider로 커버 |

Codex 프록시 기동: 수동 `npx -y @thkdog/codex-openai-proxy`(127.0.0.1:8787) 또는 `.env`에
`CODEX_PROXY_AUTOSTART=true`(Local Core가 기동·헬스 대기·종료 관리). 401 발생 시 `codex login`으로
재로그인하면 auth.json이 갱신됩니다.

참조 오픈소스: [thkdog/codex-openai-proxy](https://github.com/thkdog/codex-openai-proxy)(기본),
[RayBytes/ChatMock](https://github.com/RayBytes/ChatMock)(대안, MIT).
주의: 구독 OAuth 프록시는 OpenAI 비공식 경로입니다 — 본인 계정, 자기 책임으로 사용하며
백엔드 변경 시 동작이 깨질 수 있습니다. 외부 전송·보안 규칙은
[11_local_environment_and_security.md](./11_local_environment_and_security.md) 보안 규칙 9·10을 따릅니다.

## 계정 준비 완료 판정

- [ ] API HUB Application에 선택한 API 목록을 캡처 또는 기록
- [ ] Client ID·Client Secret 발급
- [ ] 블로그 검색 200 응답 확인
- [ ] Search Trend 200 응답과 `ratio` 확인
- [ ] 일·월 한도와 통보 대상 설정
- [ ] SearchAd API License 생성
- [ ] API Key·Secret Key·Customer ID 발급
- [ ] `/keywordstool` 200 응답 확인
- [ ] API 응답 샘플에서 Secret과 개인정보를 제거해 test fixture 저장

현재 로컬 상태는 [11_local_environment_and_security.md](./11_local_environment_and_security.md)에 정리했습니다.
