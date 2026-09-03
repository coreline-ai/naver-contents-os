# 네이버 콘텐츠 운영 OS 분석 문서 인덱스

최종 재분석일: **2026-09-01**

기존 저장소 분석과 추가로 제공된 ChatGPT 대화의 API·비용·개발 준비 내용을 합쳐 주제별로 재구성했습니다. 최신성이 중요한 내용은 네이버 및 각 프로젝트의 공식 문서를 다시 확인해 반영했습니다.

## 먼저 읽을 문서

- 현재 결론과 제품 범위: [01. 프로젝트 개요 및 핵심 성격](./01_project_overview.md)
- 공식 API·비용·계정 준비: [10. API 및 계정 준비](./10_api_and_account_setup.md)
- 현재 PC 준비 상태와 보안: [11. 로컬 환경 및 보안 준비](./11_local_environment_and_security.md)
- 즉시 개발 순서: [13. 개발 착수 체크리스트](./13_development_kickoff_checklist.md)
- 실제 구현 품질과 잔여 위험: [14. 구현 사항 전문가 상세 분석](./14_implementation_expert_review.md)
- 설치·실행·검증 빠른 시작: [프로젝트 README](../README.md)

## 전체 문서

- [01. 프로젝트 개요 및 핵심 성격](./01_project_overview.md)
- [02. 구조/모듈 및 파이프라인 정리](./02_architecture_and_modules.md)
- [03. 키워드 분석·골든키워드·Opportunity Score](./03_keyword_research_and_scoring.md)
- [04. 콘텐츠 생성 파이프라인과 템플릿 전략](./04_content_pipeline_and_templates.md)
- [05. SmartEditor 자동화 핵심 자산과 리스크](./05_smarteditor_automation_core.md)
- [06. 통합 전략: naver-keyword-tool + naver-blog-automation](./06_integration_strategy.md)
- [07. 상태 관리/DB 설계 제안](./07_db_and_state.md)
- [08. 구현 우선순위·개선 과제](./08_implementation_roadmap_and_tech_stack.md)
- [09. 품질 평가 및 최종 판단](./09_quality_assessment.md)
- [10. NAVER API·계정·비용 준비](./10_api_and_account_setup.md)
- [11. 로컬 개발 환경·보안 준비](./11_local_environment_and_security.md)
- [12. API 계약·캐시·스모크 테스트](./12_api_contracts_and_smoke_tests.md)
- [13. 바로 개발하기 위한 착수 체크리스트](./13_development_kickoff_checklist.md)
- [14. 구현 사항 전문가 상세 분석](./14_implementation_expert_review.md)
- [15. 콘텐츠 작업 흐름 구현 계획](../dev-plan/implement_20260903_083733.md)
- [SmartEditor 상태 모델 Dev Lesson](./dev-lessons/DL-20260903T112430Z-5d87a2d5.md)

## 문서 해석 기준

- `확인됨`: 2026-09-01 기준 공식 문서로 재확인한 내용
- `설계 결정`: 이 프로젝트에 적용하기 위한 권장안
- `미확인`: 실제 계정·콘솔·API 호출로 확인해야 하는 항목
- 인증값은 문서에 기록하지 않으며 `.env` 존재 여부만 점검합니다.
