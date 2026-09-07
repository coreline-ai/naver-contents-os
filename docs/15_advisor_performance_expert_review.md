# 15. Advisor 성과 연동 및 사용자 사용성 확장 전문가 검토

검토일: **2026-09-06**

## 1. 결론

현재 Naver Content OS는 키워드 발굴, 공개 SERP 표본, 글 작성, Draft 관리, SmartEditor 임시저장까지는 연결되어 있다. 그러나 발행 후 실제 성과를 가져와 다음 작성·개선 행동으로 연결하는 폐루프는 없다.

가장 높은 우선순위는 세 Advisor를 한꺼번에 붙이는 것이 아니라 **Creator Advisor에서 사용자가 확인한 내 콘텐츠 성과를 로컬로 가져와 `성과 문제 발견 → 개선 작업 추천 → 기존 글 수정 Draft 생성`으로 연결하는 것**이다.

제품 화면에는 공식 서비스명을 전면에 늘어놓기보다 다음 네 가지 사용자 행동을 보여주는 것이 적절하다.

1. 새 글 작성
2. 성과 낮은 글 개선
3. 오래된 글 업데이트
4. 잘되는 키워드로 후속 글 작성

## 2. 공식 서비스 사실 검토

### Creator Advisor

- 네이버 여러 창작 채널의 통합 통계, 검색 유입, 검색 트렌드, 광고 수익 관련 데이터를 제공한다.
- 검색 노출 분석은 노출·유입·비율·평균 노출 순위를 제공하지만 이미지·뉴스·쇼핑·지식iN 검색은 포함하지 않는다.
- 채널은 최대 20개까지 설정할 수 있다.
- 홈의 조회 수·방문 횟수·댓글·공감·재생 수는 실시간이지만 통합·유입·리워드 데이터는 일간·주간·월간 주기로 반영된다.
- 공식 고객센터 기준 PC 버전은 현재 지원되지 않는다.

공식 근거:

- [Creator Advisor 소개](https://help.naver.com/service/23038/contents/19001?lang=ko&osType=MOBILE)
- [검색 노출 분석](https://help.naver.com/service/23038/contents/14624?lang=ko&osType=MOBILE)
- [채널 설정](https://help.naver.com/service/23038/contents/11385?lang=ko&osType=MOBILE)
- [데이터 반영 주기](https://help.naver.com/service/23038/contents/11389?lang=ko&osType=MOBILE)
- [서비스 제공 기기](https://help.naver.com/service/23038/contents/11390?lang=ko&osType=MOBILE)

### Search Advisor

- 사용자가 소유 확인한 독립 웹사이트의 수집·색인·웹 검색 노출·클릭·CTR을 확인하는 도구다.
- 네이버 블로그와 스마트스토어는 독립 사이트처럼 소유 확인하는 대상이 아니다.
- 성과 리포트는 웹 검색 관련 영역 기준이며 VIEW·블로그 검색·검색광고 등을 같은 지표로 포함하지 않는다.
- 노출·클릭 데이터는 최근 90일, 업데이트 기준 약 1주 지연이라는 제약이 있다.

공식 근거:

- [콘텐츠 노출 및 클릭](https://searchadvisor.naver.com/guide/report-expose-ctr)
- [사이트 등록 및 소유 확인](https://searchadvisor.naver.com/guide/faq-start-register)
- [URL 검사](https://searchadvisor.naver.com/guide/url-inspection)

### Biz Advisor

- 스마트스토어의 판매분석, 마케팅분석, 쇼핑행동분석은 서로 다른 이벤트 시각과 집계 기준을 사용한다.
- 블로그에서 스마트스토어로 보낸 유입을 구분하려면 사용자 정의 링크의 `nt_source`, `nt_medium` 등 공식 규칙을 사용해야 한다.
- 유입과 결제 기여 데이터는 인과관계를 직접 증명하는 값이 아니라 Biz Advisor의 집계·기여 모델에 따른 성과다.

공식 근거:

- [판매·마케팅·쇼핑행동 집계 기준](https://help.sell.smartstore.naver.com/faq/content.help?faqId=13432)
- [사용자 정의 유입 파라미터](https://help.sell.smartstore.naver.com/faq/content.help?faqId=5553)

> 위 첫 Biz Advisor 링크의 공식 도움말 경로는 네이버 고객센터 화면 개편에 따라 이동할 수 있으므로 구현 착수 시 다시 확인한다.

### API 제공 여부에 대한 판단

검토한 공식 고객센터와 개발 문서에서는 Creator Advisor·Biz Advisor 대시보드 데이터를 읽는 공개 API를 확인하지 못했다. Search Advisor의 IndexNow API는 페이지 갱신 알림 용도이며 성과 리포트를 읽는 API가 아니다. 따라서 다음 접근은 금지한다.

- 내부 API endpoint 역분석
- 네이버 비밀번호 수집
- 로그인 cookie·session token 복사
- 사용자 동의 없는 백그라운드 수집
- 모바일 전용 화면을 지원되는 것처럼 가장한 무인 스크래핑

초기 제품은 앱이 정의한 입력 템플릿, 사용자의 명시적 가져오기, 필요 시 별도 기술 검증을 통과한 현재 화면 파서만 사용해야 한다.

## 3. 현재 구현 대조

| 영역 | 상태 | 현재 구현 | 부족한 부분 |
|---|---|---|---|
| 키워드 수요 | 구현 | SearchAd 검색량·연관어, Trend, Opportunity | 내 실제 유입과 연결 안 됨 |
| 최신 키워드 | 구현 | 7일 비교, 뉴스 표본, 최신성 점수 | 발행 후 성과 피드백 없음 |
| 공개 SERP | 부분 구현 | 현재 네이버 검색 탭에서 최대 20개 기본 결과 파싱 | 기간별 순위 이력·경쟁 표본 집계 없음 |
| 공개 블로그 검사 | 부분 구현 | 현재 연 게시물 1개의 글자·이미지·영상·링크·공감·댓글 | Top 10 일괄 비교·이력 없음 |
| 발행 콘텐츠 | 구현 | URL·제목·발행일·90일 노후 상태 | 조회·노출·유입·CTR·순위 없음 |
| SearchAd 광고 성과 | 구현 | 광고 노출·클릭·CTR·CPC·전환·ROAS | Creator/Biz 성과와는 다른 데이터 |
| Creator 성과 | 미구현 | 없음 | 채널·게시물·검색어 성과 전체 |
| Search Advisor | 미구현 | 없음 | 독립 사이트 수집·색인·웹 검색 성과 |
| Biz Advisor | 미구현 | 없음 | 스토어 유입·상품행동·결제 기여 |
| 콘텐츠→매출 추적 | 미구현 | 없음 | 공식 사용자 정의 링크와 성과 연결 |
| 다채널 설정 | 미구현 | 블로그 ID 1개 중심 | 채널 권한·source별 설정 없음 |

코드 근거:

- `apps/local-core/app/services/research.py`: SearchAd 및 외부 수요 분석
- `apps/local-core/app/models_db.py`: PublishedContent와 AdPerformanceSnapshot은 있으나 콘텐츠 성과 snapshot 없음
- `apps/extension/lib/parsers/serp.ts`: 현재 검색 페이지 최대 20개 기본 필드
- `apps/extension/lib/parsers/blog.ts`: 현재 블로그 게시물 한 건의 공개 지표
- `apps/extension/entrypoints/research/App.tsx`: 내 콘텐츠 성과 메뉴 없음
- `apps/extension/wxt.config.ts`: Advisor 화면 접근 권한·content script 없음

## 4. 핵심 설계 위험

### 4.1 데이터 획득 위험

Creator Advisor가 모바일 중심이고 공개 읽기 API가 확인되지 않았으므로, 브라우저 자동 수집부터 구현하면 계정·약관·DOM 변경 위험이 크다. **데이터 계약과 수동 가져오기 MVP를 먼저 만들고 자동화는 기술 검증 후 별도 승인**해야 한다.

### 4.2 지표 의미 혼합

SearchAd 검색량, Creator 검색 노출·유입, Search Advisor 웹 검색 클릭, Biz Advisor 유입·결제는 서로 다른 모집단과 집계 기준이다. 하나의 숫자로 합치지 않고 source, 기간 단위, 수집 시각, 반영 상태를 보존해야 한다.

### 4.3 0값 오판

Creator Advisor는 반영 전 데이터가 0으로 보일 수 있다. 0을 실제 성과 없음으로 저장하면 잘못된 개선 추천이 발생한다. `pending`, `partial`, `observed_zero`, `unavailable`을 구분해야 한다.

### 4.4 개인정보·매출정보

성과와 예상 수익은 민감한 운영 데이터다. 원본 계정 응답, 고객·주문 단위 데이터는 저장하지 않고 집계값만 로컬 DB에 보존해야 한다. 가져오기 삭제와 보존기간 설정도 필요하다.

### 4.5 화면 복잡도

Advisor 서비스명과 지표를 그대로 메뉴로 추가하면 기존 사용성 문제가 반복된다. 기본 사이드패널은 `완성 글 만들기`를 유지하고 성과 기능은 `오늘 할 일` 카드와 한 개의 `내 성과` 화면으로 통합한다.

## 5. 권장 제품 구조

```text
시장 수요
SearchAd + Trend + 뉴스 + 공개 SERP
              │
              ▼
내 콘텐츠 성과
노출 → 유입 → CTR → 평균 순위 → 조회·반응
              │
              ▼
결정 엔진
새 글 / 제목 개선 / 본문 보강 / 최신화 / 후속 글
              │
              ▼
기존 Codex 작성 → Draft 버전 → SmartEditor 임시저장
```

## 6. 권장 데이터 모델

### 공통

- `OwnedChannel`: source, 표시 이름, 채널 종류, 활성 상태
- `PerformanceImportRun`: source, 기간, grain, 가져온 시각, 상태, 경고, 입력 hash
- `ContentPerformanceSnapshot`: 발행 콘텐츠, 기간, 조회·노출·유입·CTR·평균 순위·반응·광고 집계
- `QueryPerformanceSnapshot`: 채널, 검색어, 기간, 노출·유입·CTR·평균 순위·상대 트렌드

### 선택 확장

- `CommerceAttributionSnapshot`: 추적 ID, 유입·상품 조회·결제·기여금액 집계
- `SitePerformanceSnapshot`: 소유 도메인, 수집·색인·웹 노출·클릭·CTR 집계

모든 snapshot에는 `source`, `period_start`, `period_end`, `grain`, `collected_at`, `data_state`를 필수로 둔다.

## 7. 사용자 흐름

### 첫 연결

```text
내 성과 연결
→ 데이터 종류 선택
→ 표 붙여넣기 또는 앱 CSV 템플릿 가져오기
→ 열 매핑 미리보기
→ 오류·중복 확인
→ 저장
```

### 일상 사용

```text
오늘 할 일
├─ 노출은 높은데 클릭이 낮은 글 2개
├─ 순위가 내려간 오래된 글 1개
├─ 유입이 증가한 후속 키워드 3개
└─ 새 글이 필요한 상승 키워드 2개
```

추천을 누르면 이유와 근거를 먼저 보여주고, 사용자 확인 후 기존 분석·Codex Draft 생성으로 이동한다.

## 8. 단계별 권장 순서

1. 데이터 의미·입력 계약과 수동 가져오기
2. Creator 기반 내 콘텐츠 성과 화면
3. 오늘의 개선 추천과 기존 Draft 연결
4. 시장 수요·SERP·내 성과 비교
5. SmartStore 사용자 정의 추적 링크
6. Biz Advisor 집계 가져오기
7. 독립 웹사이트용 Search Advisor 모듈

## 9. 구현하지 말아야 할 것

- `Creator Advisor+`, `Naver Advisor`처럼 공식 제휴로 오해할 이름
- 근거 없는 Blog Power 단일 점수
- 검색량과 실제 유입을 같은 수치로 합산
- 한 번의 검색 결과를 장기 평균으로 표시
- 사용자 모르게 Advisor 페이지를 순회하는 자동 수집
- 수익·성과 원본을 LLM prompt로 전송
- 결제 기여를 블로그 글의 직접 매출로 단정

## 10. 최종 판단

사용성 확대의 핵심은 새 분석 메뉴가 아니라 **현재 사용자에게 가장 가치 있는 다음 행동 하나를 추천하는 것**이다. 따라서 Creator 성과 MVP와 오늘의 개선 큐를 먼저 구현하고, Biz Advisor와 Search Advisor는 계정·대상 사용자가 확인된 뒤 선택 기능으로 분리하는 것이 비용·위험·제품 가치 면에서 가장 적절하다.
