import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AnalyzeResponse, PlanItem } from '@ncos/contracts';
import {
  BlogInspectionCard,
  ClusterCard,
  LandscapeCard,
  PlanCard,
  RelatedKeywordsCard,
  ScoreCard,
  SearchEvidenceCard,
  TrendCard,
} from '../entrypoints/sidepanel/App';

const plan: PlanItem[] = [
  {
    order: 1,
    title: '시리즈 허브',
    blog_type: 'SERIES',
    target_keyword: '테스트',
    angle: '',
    reason: '허브',
    generation_status: 'structure_only',
    series_prev: null,
    series_next: 2,
  },
  {
    order: 2,
    title: '방법 글',
    blog_type: 'HOWTO',
    target_keyword: '테스트',
    angle: '',
    reason: '질문',
    generation_status: 'ready',
    series_prev: 1,
    series_next: null,
  },
];

const evidence: AnalyzeResponse = {
  keyword: '러닝화',
  snapshot_id: 1,
  collected_at: '2026-09-02T00:00:00Z',
  data_status: { searchad: 'ok', hub_search: 'ok', hub_trend: 'ok' },
  metric: {
    source: 'SEARCH_AD',
    collected_at: '2026-09-02T00:00:00Z',
    keyword: '러닝화',
    monthly_pc_searches: 100,
    monthly_mobile_searches: 900,
    volume_masked: false,
    ad_competition: '높음',
    ad_click_metrics: {},
  },
  related_keywords: [
    {
      source: 'SEARCH_AD',
      collected_at: '2026-09-02T00:00:00Z',
      keyword: '초보 러닝화',
      monthly_pc_searches: 20,
      monthly_mobile_searches: 180,
      volume_masked: false,
      ad_competition: '중간',
      ad_click_metrics: {},
    },
  ],
  landscape: {
    source: 'NAVER_API_HUB',
    collected_at: '2026-09-02T00:00:00Z',
    keyword: '러닝화',
    blog_total: 1000,
    cafe_total: 200,
    kin_total: 30,
    web_total: 4000,
    news_total: 10,
    top_results: [{ title: 'API 결과', link: 'https://example.com/api', description: '', author: '작성자', posted_at: '20260901' }],
    kin_items: [],
    cafe_items: [],
    news_items: [],
  },
  trend: {
    source: 'NAVER_API_HUB',
    collected_at: '2026-09-02T00:00:00Z',
    keyword_group: '러닝화',
    keywords: ['러닝화'],
    time_unit: 'month',
    points: [{ period: '2026-07', ratio: 30 }, { period: '2026-08', ratio: 80 }],
  },
  serp: {
    source: 'BROWSER_DOM',
    collected_at: '2026-09-02T00:00:00Z',
    query: '러닝화',
    results: [{ rank: 1, result_type: 'blog', title: '브라우저 결과', url: 'https://example.com/serp', blog_id: 'runner', description: '', posted_at: '2026.09.01', is_ad: false }],
  },
  score: {
    value: 72,
    score_version: 'v1',
    coverage_weight: 0.75,
    available_component_count: 6,
    total_component_count: 8,
    confidence: 'high',
    contributions: [],
    missing: ['top10_strength', 'intent_match'],
  },
  questions: [],
  clusters: [{ label: '초보', keywords: ['초보 러닝화'], total_volume: 200 }],
  plan,
};

describe('sidepanel result cards', () => {
  it('disables AI draft for structure-only plan items', () => {
    const html = renderToStaticMarkup(<PlanCard plan={plan} creating={false} onCreate={vi.fn()} />);
    expect(html).toContain('현재 LLM 생성 미지원 유형');
    expect(html).toMatch(/disabled=""[^>]*title="현재 LLM 생성 미지원 유형"/);
    expect(html).toContain('설정된 LLM으로 초안 생성');
    expect(html).not.toContain('Ollama로 초안 생성');
  });

  it('renders blog inspector metrics', () => {
    const html = renderToStaticMarkup(
      <BlogInspectionCard
        inspection={{
          ok: true,
          found: true,
          title: '분석 글',
          posted_at: '2026.09.01',
          body_chars: 2500,
          image_count: 3,
          video_count: 1,
          link_count: 2,
          likes: 10,
          comments: 4,
        }}
      />,
    );
    expect(html).toContain('본문 2,500자');
    expect(html).toContain('이미지 3');
    expect(html).toContain('공감 10');
  });

  it('renders required analysis evidence with separated sources and score coverage', () => {
    const html = [
      <ScoreCard key="score" result={evidence} />,
      <LandscapeCard key="landscape" result={evidence} />,
      <RelatedKeywordsCard key="related" result={evidence} onSelect={vi.fn()} />,
      <TrendCard key="trend" result={evidence} />,
      <ClusterCard key="cluster" result={evidence} onSelect={vi.fn()} />,
      <SearchEvidenceCard key="search" result={evidence} />,
    ].map((component) => renderToStaticMarkup(component)).join('');

    expect(html).toContain('coverage 75%');
    expect(html).toContain('PC 검색량');
    expect(html).toContain('초보 러닝화');
    expect(html).toContain('모바일 비중');
    expect(html).toContain('90%');
    expect(html).toContain('절대 검색량이 아닙니다');
    expect(html).toContain('키워드 클러스터');
    expect(html).toContain('Browser SERP');
    expect(html).toContain('API HUB 블로그 결과');
  });

  it('renders empty and single-point trends without invalid geometry', () => {
    const empty = renderToStaticMarkup(
      <TrendCard result={{ ...evidence, trend: { ...evidence.trend!, points: [] } }} />,
    );
    const single = renderToStaticMarkup(
      <TrendCard
        result={{
          ...evidence,
          trend: { ...evidence.trend!, points: [{ period: '2026-08', ratio: 0 }] },
        }}
      />,
    );
    expect(empty).toBe('');
    expect(single).toContain('최근 0.0');
    expect(single).not.toContain('NaN');
  });

  it('does not treat a masked component as zero in totals or mobile share', () => {
    const masked = renderToStaticMarkup(
      <RelatedKeywordsCard
        result={{
          ...evidence,
          related_keywords: [
            {
              ...evidence.related_keywords[0],
              monthly_pc_searches: 100,
              monthly_mobile_searches: null,
              volume_masked: true,
            },
          ],
        }}
        onSelect={vi.fn()}
      />,
    );
    expect(masked).toContain('title="정확한 합계 결측"');
    expect(masked).not.toContain('>100%</td>');
  });
});
