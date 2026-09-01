# 07. 상태 관리·DB 설계 제안

## 왜 필요한가
현재 텍스트 분석 내용에서 `한 건씩 처리`는 가능하지만,
전체 시스템 관점에서는 작업 이력, 버전, 실패 원인 추적이 약함.

## 최소 권장 테이블
- `projects`
- `topics`
- `keywords`
- `keyword_snapshots`
- `blogs`
- `posts`
- `serp_snapshots`
- `content_plans`
- `drafts`
- `draft_versions` (중요)
- `images`
- `thumbnails`
- `publish_jobs`
- `publish_logs`

## 핵심 포인트: `draft_versions`
작성/수정 이력을 버전 관리해야 함:
- V1 원본
- V2 사실확인 반영
- V3 제목 수정
- V4 최종

## 추가 제안
- SQLite + WAL + FTS5 사용(로컬 기반 운영 우세)
- SQLAlchemy 2 + Alembic로 마이그레이션 관리
- `publish_jobs` 상태를 통해 자동화 진행 실패 지점을 명확화

## 운영성 개선
- JSON 파일 중심 로그보다 job state, 단계별 타임스탬프, 오류 코드 중심 로그가 유리.
- 사람 검토 전후의 상태 구분 필요(임시저장 전/후).
