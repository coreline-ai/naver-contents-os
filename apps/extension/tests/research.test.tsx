import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AudienceResponse, CommercialResponse, DraftSummary, FactPack, IntentBoardResponse, ResearchGraphResponse, RisingResponse, TodayWorkItem } from '@ncos/contracts';
import { AudienceTable, CommercialTable, DraftWorkbox, FactPackWorkspace, IntentBoardWorkspace, OpportunityGraph, RisingWorkspace, TodayWorkCards } from '../entrypoints/research/App';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const graph: ResearchGraphResponse = {
  keyword: '러닝화',
  status: 'ok',
  nodes: [
    { id: '러닝화', keyword: '러닝화', depth: 0, volume: 1000, pc_volume: 100, mobile_volume: 900, volume_masked: false, competition: '높음', cluster: 'seed', blog_total: 100, trend_delta: 10, enrichment_status: 'ok' },
    { id: '초보러닝화', keyword: '초보 러닝화', depth: 1, volume: null, pc_volume: null, mobile_volume: null, volume_masked: true, competition: '낮음', cluster: '초보', blog_total: null, trend_delta: null, enrichment_status: 'not_collected' },
  ],
  edges: [{ source: '러닝화', target: '초보러닝화' }],
  call_budget: { actual: 2, maximum: 12 },
  collected_at: '2026-09-02T00:00:00Z',
};

describe('research workspace visual contracts', () => {
  it('renders draft summaries without loading draft bodies', () => {
    const items: DraftSummary[] = [{
      draft_id: 3, keyword: '러닝화', title: '이어 쓸 초안', blog_type: 'HOWTO', latest_version: 2,
      latest_version_at: '2026-09-03T00:00:00Z', user_status: 'editing', latest_job_status: 'failed',
      latest_job_id: 9, latest_job_stage: 'input_body', latest_job_error: '입력 실패', source_snapshot_id: 1,
    }];
    const html = renderToStaticMarkup(<DraftWorkbox items={items} loading={false} busy="" onOpen={() => undefined} onStatus={() => undefined} />);
    expect(html).toContain('콘텐츠 작업함');
    expect(html).toContain('이어 쓸 초안');
    expect(html).toContain('오류 확인·재시도');
    expect(html).not.toContain('초안 본문 내용');
  });

  it('renders graph nodes with keyboard semantics and explicit metric labels', () => {
    const html = renderToStaticMarkup(<OpportunityGraph graph={graph} selectedId="러닝화" minimumVolume={0} onSelect={() => undefined} />);
    expect(html).toContain('role="button"');
    expect(html).toContain('키워드 기회 그래프');
    expect(html).toContain('검색량 1000');
    expect(html).toContain('초보 러닝화');
  });

  it('keeps commercial score separate from organic opportunity', () => {
    const result: CommercialResponse = {
      status: 'ok',
      score_version: 'commercial-v1',
      rows: [{ keyword: '러닝화', device: 'PC', average_position_bid: 1200, minimum_exposure_bid: 300, median_bid: 800, estimated_impressions: 100, estimated_clicks: 3, commercial_score: 62 }],
    };
    const html = renderToStaticMarkup(<CommercialTable result={result} />);
    expect(html).toContain('Organic Opportunity와 합산하지 않는');
    expect(html).toContain('1,200원');
  });

  it('labels audience data as independently normalized relative trend', () => {
    const result: AudienceResponse = {
      keyword: '러닝화',
      status: 'ok',
      normalization: 'independent',
      warning: '각 series는 독립 정규화된 상대지수이며 절대 검색량·인구 비중이 아닙니다.',
      segments: { device: [{ label: 'pc', points: [{ period: '2026-08', ratio: 50 }], collected_at: 'now', from_cache: false }] },
    };
    const html = renderToStaticMarkup(<AudienceTable result={result} />);
    expect(html).toContain('절대 검색량·인구 비중이 아닙니다');
    expect(html).toContain('50.0');
  });

  it('renders rising evidence without claiming an official realtime ranking', () => {
    const result: RisingResponse = {
      run_id: 1, seed: '러닝화', effective_seed: '러닝화', mode: 'general', region: '', category: '', status: 'ok',
      comparison_window: { start_date: '2026-08-20', recent_start: '2026-08-27', end_date: '2026-09-02' },
      estimated_calls: 10, actual_calls: 10, score_version: 'freshness-v1', collected_at: '2026-09-02T12:00:00Z',
      data_status: { searchad: 'ok', trend: 'ok', news: 'ok' }, disclaimer: '공식 순위가 아닙니다.',
      candidates: [{
        keyword: '초보러닝화', direction: 'rising', recent7_avg: 30, previous7_avg: 10, growth_rate: 200,
        trend_score: 100, news_7d_sample_count: 4, sample_capped: false, latest_news_at: '2026-09-02T10:00:00Z',
        news_score: 60, freshness_score: 86, confidence: 'high', coverage: { observed_days: 14, recent_days: 7, previous_days: 7 },
        monthly_searches: 1000, volume_masked: false,
        components: { trend_score: 100, news_volume_score: 50, news_recency_score: 83, news_score: 60, trend_weight: 0.65, news_weight: 0.35, reason: null },
        data_status: { searchad: 'ok', trend: 'ok', news: 'ok' }, source_meta: {},
      }],
    };
    const html = renderToStaticMarkup(<RisingWorkspace result={result} mode="general" region="" category="" busy="" onMode={() => undefined} onRegion={() => undefined} onCategory={() => undefined} onCollect={() => undefined} onAnalyze={() => undefined} quotaBlocked={false} />);
    expect(html).toContain('공식 실시간 인기 검색어 순위');
    expect(html).toContain('최근 7일');
    expect(html).toContain('최신성');
    expect(html).toContain('초보러닝화');
    expect(html).toContain('+200%');
  });

  it('renders only compact FactPack evidence with warnings and approval action', () => {
    const pack: FactPack = {
      fact_pack_id: 4, snapshot_id: 7, draft_id: null, keyword: '러닝화', created_at: '2026-09-03T00:00:00Z', latest_version: 1, latest_status: 'draft',
      versions: [{
        version: 1, status: 'draft', created_at: '2026-09-03T00:00:00Z', warnings: ['검색 추세 근거가 없습니다.'],
        evidence: [{ id: 'metric:volume', kind: 'search_volume', label: '월간 PC·모바일 검색량', value: { pc: 100, mobile: 900 }, source_type: 'SEARCH_AD', source_url: null, source_id: 'keyword_snapshot:7:metric', collected_at: '2026-09-03T00:00:00Z', from_cache: false, freshness: 'fresh', selected: true }],
      }],
    };
    const html = renderToStaticMarkup(<FactPackWorkspace pack={pack} snapshotId={7} busy="" onCreate={() => undefined} onSave={() => undefined} />);
    expect(html).toContain('FactPack 근거 브리프');
    expect(html).toContain('검색 추세 근거가 없습니다');
    expect(html).toContain('선택 근거 승인');
    expect(html).not.toContain('provider_payload');
  });

  it('renders intent evidence and actions without a combined score claim', () => {
    const board: IntentBoardResponse = {
      snapshot_id: 7, keyword: '러닝화 비교', intent_version: 'intent-v1', collected_at: '2026-09-03T00:00:00Z',
      items: [{
        keyword: '러닝화 비교 후기', intent: 'comparison_review', intent_version: 'intent-v1', matched_markers: ['비교', '후기'], confidence: 'high',
        metric: { pc: 100, mobile: 900, total: 1000, masked: false, source: 'SEARCH_AD', collected_at: '2026-09-03T00:00:00Z', from_cache: false },
        trend: { latest_period: '2026-08', latest_ratio: 80, relative_change: null, source: 'NAVER_API_HUB', collected_at: '2026-09-03T00:00:00Z', from_cache: false, note: '상대 추세' },
        organic: { blog_total: 1234, cafe_total: 30, kin_total: 10, news_total: 5, source: 'NAVER_API_HUB', collected_at: '2026-09-03T00:00:00Z', note: '문서 수' },
        commercial: { ad_competition: '높음', source: 'SEARCH_AD', note: '합산하지 않습니다.' },
        content: { state: 'published', draft_count: 1, last_draft_at: null, published_content_id: 2, published_url: 'https://example.com/post', published_at: '2026-09-01T00:00:00Z' },
      }],
    };
    const html = renderToStaticMarkup(<IntentBoardWorkspace board={board} loading={false} snapshotId={7} busy="" onAnalyze={() => undefined} onWatch={() => undefined} onPlan={() => undefined} onOpen={() => undefined} />);
    expect(html).toContain('Organic·광고 경쟁·상대 Trend는 서로 합산하지 않습니다');
    expect(html).not.toContain('10 미만');
    expect(html).toContain('재분석');
    expect(html).toContain('Watchlist 추가');
    expect(html).toContain('플랜 후보로 사용');
    expect(html).toContain('기존 콘텐츠 열기');
  });

  it('routes the exact today-work item only after the user clicks its action', async () => {
    const item: TodayWorkItem = { id: 'publish_job:9', priority: 1, source_type: 'publish_job', source_id: 9, keyword: '러닝화', title: '실패한 초안', reason: '임시저장 실패', action: 'inspect_error', stale: false, draft_id: 3, publish_job_id: 9, published_content_id: null, published_url: null, calculated_at: '2026-09-03T00:00:00Z' };
    const onAction = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<TodayWorkCards items={[item]} loading={false} busy="" onAction={onAction} onAnalyze={vi.fn()} onDrafts={vi.fn()} />));
    expect(onAction).not.toHaveBeenCalled();
    const action = [...container.querySelectorAll('button')].find((button) => button.textContent === '오류 확인')!;
    await act(async () => action.click());
    expect(onAction).toHaveBeenCalledWith(item);
    await act(async () => root.unmount());
  });
});
