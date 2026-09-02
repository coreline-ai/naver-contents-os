import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PlanItem } from '@ncos/contracts';
import { BlogInspectionCard, PlanCard } from '../entrypoints/sidepanel/App';

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
});
