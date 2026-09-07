import type { PerformanceAction, PerformanceRecommendation } from '@ncos/contracts';

export const IMPROVEMENT_LABELS: Record<PerformanceAction, string> = { improve_title: '제목 개선', refresh_body: '본문 최신화', create_followup: '후속 글' };
export interface ImprovementInput {
  keyword: string;
  notes: string;
  recommendationId: number;
  sourceDraftId: number | null;
  sourceDraftMode: 'revision' | 'followup';
  label: string;
}
export function buildImprovementInput(item: PerformanceRecommendation, action: PerformanceAction): ImprovementInput {
  return {
    keyword: action === 'create_followup' ? item.keyword : item.published_keyword || item.keyword,
    notes: [
      `성과 기반 작업: ${IMPROVEMENT_LABELS[action]}`,
      `추천 근거: ${item.reason}`,
      item.published_title ? `기존 게시물: ${item.published_title}` : '',
      item.published_url ? `기존 게시물 URL: ${item.published_url}` : '',
      item.draft_id ? `참고할 기존 Draft: #${item.draft_id}` : '',
      `근거 기간: ${item.period.start}~${item.period.end}`,
      '수치를 사실처럼 본문에 복사하지 말고 독자의 검색 의도를 충족하는 완성 글로 작성하세요.',
    ].filter(Boolean).join('\n'),
    recommendationId: item.id, sourceDraftId: item.draft_id,
    sourceDraftMode: action === 'create_followup' ? 'followup' : 'revision',
    label: IMPROVEMENT_LABELS[action],
  };
}

// Compatibility for existing extension deep links. Web uses the object in memory, never these URL notes.
export function buildImprovementDraftParams(item: PerformanceRecommendation, action: PerformanceAction): URLSearchParams {
  const input = buildImprovementInput(item, action);
  const params = new URLSearchParams({ compose_keyword: input.keyword, compose_notes: input.notes, compose_style: 'auto', recommendation_id: String(input.recommendationId), source_draft_mode: input.sourceDraftMode });
  if (input.sourceDraftId) params.set('source_draft_id', String(input.sourceDraftId));
  return params;
}
