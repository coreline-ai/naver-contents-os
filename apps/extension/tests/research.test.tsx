import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AudienceResponse, CommercialResponse, ResearchGraphResponse } from '@ncos/contracts';
import { AudienceTable, CommercialTable, OpportunityGraph } from '../entrypoints/research/App';

const graph: ResearchGraphResponse = {
  keyword: '러닝화',
  status: 'ok',
  nodes: [
    { id: '러닝화', keyword: '러닝화', depth: 0, volume: 1000, volume_masked: false, competition: '높음', cluster: 'seed', blog_total: 100, trend_delta: 10, enrichment_status: 'ok' },
    { id: '초보러닝화', keyword: '초보 러닝화', depth: 1, volume: null, volume_masked: true, competition: '낮음', cluster: '초보', blog_total: null, trend_delta: null, enrichment_status: 'not_collected' },
  ],
  edges: [{ source: '러닝화', target: '초보러닝화' }],
  call_budget: { actual: 2, maximum: 12 },
  collected_at: '2026-09-02T00:00:00Z',
};

describe('research workspace visual contracts', () => {
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
});
