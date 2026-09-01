# 13. 바로 개발하기 위한 착수 체크리스트

## 현재 상태 요약

| 영역 | 상태 | 설명 |
|---|---:|---|
| 제품 방향 | 준비됨 | V1 범위와 데이터 소스가 명확함 |
| API HUB 키 | 부분 준비 | `.env`에 존재하지만 호출 미검증 |
| SearchAd 키 | 미준비 | 3개 값 발급·설정 필요 |
| Node 프런트 환경 | 준비됨 | Node 24 LTS, pnpm 설치됨 |
| Python 백엔드 환경 | 부분 준비 | `uv`는 있으나 Python 3.12 환경 없음 |
| 브라우저 | 부분 준비 | Chrome 있음, Whale 없음 |
| 저장소 | 미준비 | Git·패키지·코드 스캐폴드 없음 |
| 테스트 | 미준비 | API/DOM fixture와 smoke test 없음 |

**결론:** 설계 문서는 개발 가능한 수준이지만, 코드 구현은 아직 시작 전입니다. 아래 P0를 끝내면 첫 API 클라이언트 개발에 바로 들어갈 수 있습니다.

## P0 — 개발 시작 전 필수

- [ ] Git 저장소 초기화 및 기본 브랜치 생성
- [ ] Python 3.12 설치, `uv` 가상환경 생성
- [ ] pnpm workspace와 WXT/FastAPI 스캐폴드 생성
- [ ] `.env.example` 작성, `.env` 제외 규칙 재확인
- [ ] `.gitignore`에 `.venv/`, Python cache, SQLite runtime DB 추가
- [ ] API HUB 콘솔에서 선택 API 목록 확인
- [ ] API HUB 일·월 한도 및 통보 대상 설정
- [ ] SearchAd 광고주센터 가입·API License 생성
- [ ] SearchAd 3개 환경변수 설정
- [ ] API HUB Blog/Trend 스모크 테스트 성공
- [ ] SearchAd `/keywordstool` 스모크 테스트 성공

## 권장 프로젝트 뼈대

```text
naver-content-os/
├── apps/
│   ├── extension/           # WXT + React
│   └── local-core/          # FastAPI application
├── packages/
│   └── contracts/           # TypeScript/Python API schema 계약
├── python/
│   ├── providers/
│   │   ├── naver_hub/
│   │   ├── searchad/
│   │   └── llm/
│   ├── intelligence/
│   ├── planner/
│   └── publisher/
├── tests/
│   ├── fixtures/
│   ├── unit/
│   ├── integration/
│   └── smoke/
├── data/                    # runtime, gitignore
└── docs/
```

## Phase 1 — 데이터 수집 기반

### 구현

1. 설정 로더와 Secret 마스킹
2. `NaverHubSearchClient`
3. `NaverHubTrendClient`
4. `NaverSearchAdClient`와 HMAC 서명
5. SQLite + SQLAlchemy + Alembic
6. TTL 캐시와 429 backoff
7. `/health`, `/v1/keywords/analyze` Local API

### 완료 기준

- 키워드 1개 입력 시 검색량·트렌드·5종 검색 규모 반환
- 두 번째 동일 요청은 캐시 hit
- 로그에 Secret 없음
- 외부 API 오류가 표준 오류 코드로 변환됨

## Phase 2 — 분석과 기획

### 구현

1. 키워드 정규화와 결측 처리
2. Opportunity Score v1
3. 점수 기여도 설명
4. 지식iN·카페 질문/후기 후보 추출
5. 키워드 클러스터
6. 15편 콘텐츠 플래너

### 완료 기준

- 동일 snapshot과 score version에서 결과 재현 가능
- 검색량, 상대 트렌드, 문서 수, 파생 점수가 UI에서 구분됨
- 각 추천 키워드에 추천 이유가 표시됨

## Phase 3 — 브라우저 확장과 공개 DOM

### 구현

1. WXT 사이드패널
2. Local Core handshake와 로컬 토큰
3. SERP Content Script
4. Blog Inspector Parser
5. fixture 기반 DOM 회귀 테스트

### 완료 기준

- 현재 네이버 검색어를 읽고 분석 요청 가능
- SERP 상위 결과와 공개 블로그 정보가 구조화됨
- 파서 실패가 전체 Extension crash로 이어지지 않음

## Phase 4 — 콘텐츠와 SmartEditor 임시저장

### 구현

1. BlogType별 템플릿
2. LLM Provider 인터페이스와 Local provider
3. 초안 버전 관리
4. SmartEditor Selector Health Check
5. 제목·본문·이미지·태그 입력
6. 임시저장과 실패 로그

### 완료 기준

- Health Check 실패 시 입력 시작 금지
- 기존 네이버 로그인 세션만 사용
- 네이버 ID·비밀번호 저장 없음
- 자동 공개 없이 임시저장까지만 성공

## V1 범위에서 제외

- 자동 공개 발행
- 다계정 로그인 자동화
- 네이버 ID/PW 저장
- 클라우드 SaaS·팀 협업
- 결제·구독
- 스마트플레이스·지역 분석
- 이미지 검색/Stock API 중심 제작
- 완전 자동 댓글·공감·이웃 활동

## 가장 먼저 구현할 파일 순서

1. `pyproject.toml`, `package.json`, workspace 설정
2. `apps/local-core/app/config.py`
3. `python/providers/naver_hub/client.py`
4. `python/providers/searchad/signature.py`
5. `python/providers/searchad/client.py`
6. `tests/smoke/test_naver_hub.py`
7. `tests/smoke/test_searchad.py`
8. `python/intelligence/keyword/models.py`
9. DB 모델과 첫 Alembic migration
10. `apps/extension`의 health/handshake 화면

## 개발 착수 가능 판정

다음 네 항목이 모두 `YES`면 Phase 1 구현을 시작할 수 있습니다.

```text
API HUB Blog 호출 성공?       YES / NO
API HUB Trend 호출 성공?      YES / NO
SearchAd keywordstool 성공?   YES / NO
Python 3.12 환경 생성?        YES / NO
```

현재 확인된 상태는 API HUB 환경변수만 존재하고 실제 호출은 하지 않은 상태이므로, 위 네 항목은 아직 모두 검증 전으로 취급합니다.
