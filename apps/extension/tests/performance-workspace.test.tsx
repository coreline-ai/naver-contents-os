import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  ContentPerformanceItem,
  PerformanceOverviewResponse,
  PerformanceRecommendation,
} from '@ncos/contracts';
import { buildImprovementDraftParams, PerformanceDashboard } from '../entrypoints/research/PerformanceWorkspace';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const overview: PerformanceOverviewResponse = {
  creator: {
    source: 'creator_advisor', channel_id: 1, data_kind: 'content_performance',
    period: { start: '2026-08-24', end: '2026-08-30' }, grain: 'weekly', status: 'ready',
    collected_at: '2026-09-01T00:00:00Z', row_count: 1,
    metrics: { impressions: 600, inflows: 6, ctr: 1, average_rank: 8, views: 300, likes: 10, comments: 2 },
    previous_metrics: { impressions: 800, inflows: 40, ctr: 5, average_rank: 4 },
    changes: { impressions: -25, inflows: -85, ctr: -80, average_rank: 100 },
  },
  commerce: null,
  website: null,
  sources_combined: false,
  note: '서로 합산하지 않습니다.',
};

const recommendation: PerformanceRecommendation = {
  id: 9, channel_id: 1, published_content_id: 3, draft_id: 11, published_title: '후쿠오카 여행기',
  published_url: 'https://blog.naver.com/me/1', keyword: '후쿠오카 여행',
  rule_code: 'high_impressions_low_ctr', action: 'improve_title',
  reason: '노출에 비해 CTR이 낮습니다.', confidence: 'high', calculation_version: 'performance-v2',
  period: { start: '2026-08-24', end: '2026-08-30' }, evidence: { sources_combined: false },
  status: 'open', created_at: '2026-09-01T00:00:00Z',
};

const content: ContentPerformanceItem = {
  id: 4, channel_id: 1, published_content_id: 3, canonical_url: 'https://blog.naver.com/me/1',
  title: '후쿠오카 여행기', keyword: '후쿠오카 여행', period: { start: '2026-08-24', end: '2026-08-30' },
  grain: 'weekly', data_state: 'ready',
  metrics: { views: 300, impressions: 600, inflows: 6, ctr: 1, average_rank: 8, likes: 10, comments: 2 },
  previous_metrics: { views: 400, impressions: 800, inflows: 40, ctr: 5, average_rank: 4, likes: 12, comments: 3 },
  market: {
    keyword: '후쿠오카 여행',
    searchad: { monthly_searches: 2000, source: 'SEARCH_AD', collected_at: '2026-09-01T00:00:00Z' },
    trend: { latest_ratio: 80, source: 'NAVER_API_HUB', collected_at: '2026-09-01T00:00:00Z', note: '상대 추세' },
    serp: { sample_count: 10, blog_count: 8, ad_count: 1, median_observed_rank: 5.5, source: 'BROWSER_DOM', collected_at: '2026-09-01T00:00:00Z', note: '현재 화면 표본' },
  },
  mapped: true,
};

describe('owned performance workspace', () => {
  it('shows Creator funnel and keeps market sources visibly separate', () => {
    const html = renderToStaticMarkup(
      <PerformanceDashboard
        overview={overview} recommendations={[recommendation]} contents={[content]} queries={[]}
        publications={[]} features={{ creator: true, commerce: false, website: false }} loading={false}
        onAction={() => undefined} onDismiss={() => undefined} onMap={() => undefined}
      />,
    );
    expect(html).toContain('내 블로그 흐름');
    expect(html).toContain('노출');
    expect(html).toContain('유입률');
    expect(html).toContain('시장 수요와 내 실적은 합산하지 않고');
    expect(html).toContain('SEARCH_AD');
    expect(html).toContain('현재 화면·최대 10');
    expect(html).not.toContain('스마트스토어 유입·기여');
  });

  it('does not run an improvement until the user clicks an explicit action', async () => {
    const onAction = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(
      <PerformanceDashboard
        overview={overview} recommendations={[recommendation]} contents={[]} queries={[]}
        publications={[]} features={{ creator: true, commerce: false, website: false }} loading={false}
        onAction={onAction} onDismiss={vi.fn()} onMap={vi.fn()}
      />,
    ));
    expect(onAction).not.toHaveBeenCalled();
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '본문 최신화')!;
    await act(async () => button.click());
    expect(onAction).toHaveBeenCalledWith(recommendation, 'refresh_body');
    await act(async () => root.unmount());
  });

  it('builds a prefilled draft handoff without invoking an AI request', () => {
    const params = buildImprovementDraftParams(recommendation, 'create_followup');
    expect(params.get('compose_keyword')).toBe('후쿠오카 여행');
    expect(params.get('compose_notes')).toContain('성과 기반 작업: 후속 글');
    expect(params.get('compose_notes')).toContain('근거 기간: 2026-08-24~2026-08-30');
    expect(params.get('recommendation_id')).toBe('9');
    expect(params.get('source_draft_id')).toBe('11');
    expect(params.get('source_draft_mode')).toBe('followup');
  });

  it('uses the original topic for revisions and the query for a separate followup', () => {
    const queryRecommendation = { ...recommendation, keyword: '후쿠오카 맛집', published_keyword: '후쿠오카 여행' };
    expect(buildImprovementDraftParams(queryRecommendation, 'refresh_body').get('compose_keyword')).toBe('후쿠오카 여행');
    expect(buildImprovementDraftParams(queryRecommendation, 'create_followup').get('compose_keyword')).toBe('후쿠오카 맛집');
  });

  it('shows one clear empty-state instruction before any channel is configured', () => {
    const html = renderToStaticMarkup(
      <PerformanceDashboard
        overview={null} recommendations={[]} contents={[]} queries={[]} publications={[]}
        features={{ creator: false, commerce: false, website: false }} loading={false}
        onAction={() => undefined} onDismiss={() => undefined} onMap={() => undefined}
      />,
    );
    expect(html).toContain('먼저 성과 표를 연결하세요');
    expect(html).not.toContain('지금 개선할 일');
  });

  it('renders pending, partial, observed zero, and unavailable as distinct states', () => {
    const states = [
      ['pending', '반영 대기'],
      ['partial', '부분 데이터'],
      ['observed_zero', '확인된 0'],
      ['unavailable', '사용 불가'],
    ] as const;
    const html = renderToStaticMarkup(
      <PerformanceDashboard
        overview={overview} recommendations={[{
          ...recommendation,
          id: 10,
          rule_code: 'rank_drop_or_stale',
          action: 'refresh_body',
          reason: '공개 후 90일 이상 지난 글입니다.',
        }]}
        contents={states.map(([data_state], index) => ({ ...content, id: index + 20, title: `상태 ${index}`, data_state }))}
        queries={[]} publications={[]} features={{ creator: true, commerce: false, website: false }} loading={false}
        onAction={() => undefined} onDismiss={() => undefined} onMap={() => undefined}
      />,
    );
    for (const [, label] of states) expect(html).toContain(label);
    expect(html).toContain('90일 이상');
  });
});
