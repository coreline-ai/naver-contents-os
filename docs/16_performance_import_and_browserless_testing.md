# 16. 내 성과 가져오기·브라우저 없이 테스트하기

최종 갱신: **2026-09-06**

## 결론

`P0~P3 내 성과` 기능의 대부분은 Chrome을 열지 않고 검증할 수 있다.

```bash
pnpm test:performance
```

이 명령은 합성 데이터만 사용해 다음을 자동 검증한다.

- Python 단위·API 통합 테스트
- CSV/TSV 파서와 개인정보 열 차단
- `happy-dom` 기반 React 화면 테스트
- TypeScript 계약 검사
- 임시 DB의 실제 Alembic upgrade/downgrade와 기존 원고 보존
- 중복·결측·경계값·source 분리·추천 규칙

Chrome이 반드시 필요한 항목은 마지막 사용자 인수인 **확장 reload, 실제 사이드패널 크기, 네이버 로그인, SmartEditor 임시저장**뿐이다.

## 사용 순서

1. 전체화면 Workspace에서 **내 성과**를 누른다.
2. **성과 가져오기**에서 소스와 데이터 종류를 고른다.
3. 채널이 없으면 블로그·스마트스토어·독립 웹사이트 채널을 한 번 등록한다.
4. 기간과 일간·주간·월간 단위를 선택한다.
5. **샘플 양식**을 붙여넣고 내 표의 값으로 교체하거나 CSV/TSV 파일을 선택한다.
6. 열 매핑·오류·경고를 확인한 뒤 **미리보기**를 누른다.
7. 정규화된 값만 확인하고 **저장**한다.
8. 추천 이유를 읽고 `제목 개선`, `본문 최신화`, `후속 글` 중 하나를 사용자가 선택한다.

추천 카드를 보는 것만으로 LLM, 외부 API, SmartEditor, 초안 생성이 시작되지 않는다.

## 가져오기 계약

| 소스 | 데이터 | 필수 식별자 | 주요 지표 |
|---|---|---|---|
| Creator Advisor | 게시물 성과 | 게시물 URL, 콘텐츠 ID 또는 제목 | 조회, 노출, 유입, CTR, 평균 순위, 공감, 댓글 |
| Creator Advisor | 검색어 성과 | 검색어 | 노출, 유입, CTR, 평균 순위 |
| Biz Advisor | 기여 성과 | 추적 ID | 유입, 상품 조회, 결제 건, 결제율, 기여 금액 |
| Search Advisor | 독립 웹 성과 | 페이지 URL | 수집, 색인, 웹 노출, 클릭, CTR |

허용 상태:

- `pending`: 집계 대기·반영 전
- `partial`: 일부 지표만 존재
- `observed_zero`: 실제로 관측된 0
- `unavailable`: 제공되지 않음·마스킹
- `ready`: 해석 가능

CTR과 결제율은 분자·분모가 있으면 서버가 다시 계산한다. 공백, 0, 반영 전, 제공 불가를 같은 값으로 취급하지 않는다.

## 데이터 보호

- 파일은 Extension에서 로컬 파싱하며 원본 파일과 원본 텍스트는 Local Core에 저장하지 않는다.
- 서버에는 allowlist를 통과한 집계 숫자, 기간, source, 정규화 URL, 입력 hash만 보낸다.
- 고객명·주문자·주소·전화·주문번호 같은 알 수 없는 열은 API에서 거부한다.
- 네이버 ID·비밀번호·cookie·session token은 요구하거나 복사하지 않는다.
- 같은 소스·기간·대상은 불변 snapshot으로 중복 저장하지 않는다. 잘못 가져온 값을 고치려면 해당 import를 삭제한 뒤 다시 가져온다.

## 지표 해석 경계

- SearchAd 검색량·Trend 상대지수·공개 SERP 표본·Creator 내 성과는 합산하지 않는다. 현재 표는 SearchAd·SERP와 내 성과를 나란히 표시하며 Trend는 API에 제공된다.
- SERP는 사용자가 직접 수집한 현재 화면의 최대 10건 표본이며 전체 시장 통계가 아니다.
- Search Advisor는 네이버 블로그·스마트스토어가 아닌 독립 웹사이트만 등록할 수 있다.
- Search Advisor 성과는 최근 90일 범위와 약 1주 반영 지연을 감안한다. 이 데이터를 VIEW·블로그 성과로 표하지 않는다.

## SmartStore 추적 링크

SmartStore·BrandStore 채널을 명시적으로 켠 사용자에게만 builder를 보여준다.

- `nt_source`, `nt_medium`: 필수, 영문·숫자·`-_.`, 최대 100자
- `nt_detail`, `nt_keyword`: 선택, 한글·영문·숫자·`-_.`, 최대 100자
- 로컬에 저장하는 사용자 정의 추적 조합은 공식 안내에 맞춰 최대 400개로 제한한다.
- 기존 쿼리는 보존하고 기존 `nt_*`만 교체한다.
- SmartStore·BrandStore 공식 host 외 URL은 거부한다.
- 발행 글을 선택하면 추적 ID→`PublishedContent` 연결을 로컬에 저장하고 이후 Biz 집계 가져오기에서 자동 매핑한다.
- 기여 금액은 Biz Advisor의 집계 조건이며 이 앱이 직접 증명한 매출로 표현하지 않는다.

공식 기준: [스마트스토어 고객유입 채널 추적 안내](https://help.sell.smartstore.naver.com/faq/content.help?faqId=5553), [Search Advisor 노출·클릭 보고서](https://searchadvisor.naver.com/guide/report-expose-ctr)

## 테스트 레이어

| 레이어 | 브라우저 | 검증 범위 |
|---|---:|---|
| Python unit | 불필요 | 정규화, CTR, 멱등성, 추천 규칙, source 경계 |
| FastAPI integration | 불필요 | 인증, schema allowlist, CRUD, transaction, feature flag |
| Vitest + happy-dom | 불필요 | CSV/TSV, 빈·오류·부분 상태, 버튼 확인 흐름 |
| TypeScript | 불필요 | Extension ↔ Local Core 계약 |
| Alembic 임시 DB | 불필요 | clean upgrade, downgrade/upgrade, 기존 행 보존 |
| Production build | 불필요 | MV3 bundle 생성 |
| Playwright/Chrome UAT | 필요 | 실제 Extension reload, 네이버 세션, SmartEditor 임시저장 |

자동 검증은 실제 계정에 접속하지 않고 외부 API quota도 사용하지 않는다. Creator/Biz/Search Advisor에서 복사한 실제 표의 헤더·단위가 샘플 양식과 맞는지는 최종에 한 번 사용자 계정으로 확인해야 한다.


## 2026-09-06 재검토 반영

- 기간·채널·단위·표를 바꾸면 미리보기를 다시 확인해야 한다. 저장 직전 정규화된 최대 5행을 표시한다.
- 결측을 0으로 합산하지 않는다. 같은 채널·기간·단위의 여러 가져오기를 함께 집계하며, 기간 길이나 대상 집합이 다르면 증감은 표시하지 않는다.
- 개선 완료/90일 경과/보관/이미 작성된 후속 글의 추천을 다시 실행하지 않도록 걸러낸다.
- 구버전 추천 갱신은 같은 자료를 다시 미리보기·저장한다. snapshot은 중복 저장하지 않으며 완료·숨김은 유지한다.
- 최신 검증 상세와 적용 한계는 [17. 개발 검토 보고서](./17_development_review_20260906.md)를 따른다.
