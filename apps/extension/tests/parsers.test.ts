import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBlogPost } from '../lib/parsers/blog';
import { extractBlogId, parseSerp } from '../lib/parsers/serp';

function loadDoc(fixture: string): Document {
  const html = readFileSync(resolve(process.cwd(), 'tests/fixtures', fixture), 'utf-8');
  return new DOMParser().parseFromString(html, 'text/html');
}

const SERP_URL = 'https://search.naver.com/search.naver?query=%ED%85%8C%EC%8A%A4%ED%8A%B8';

describe('parseSerp', () => {
  it('parses the modern layout with query, types, dates and ad flags', () => {
    const parsed = parseSerp(loadDoc('serp-modern.html'), SERP_URL);
    expect(parsed.ok).toBe(true);
    expect(parsed.query).toBe('애드포스트 승인');
    expect(parsed.results).toHaveLength(3); // title-less block skipped

    const [first, second, ad] = parsed.results;
    expect(first).toMatchObject({
      rank: 1,
      result_type: 'blog',
      title: '애드포스트 승인 조건 총정리',
      blog_id: 'writer1',
      description: '승인 조건을 정리했습니다',
      posted_at: '2026.08.30.',
      is_ad: false,
    });
    expect(second.result_type).toBe('cafe');
    expect(ad.is_ad).toBe(true);
  });

  it('parses the legacy li.bx layout', () => {
    const parsed = parseSerp(loadDoc('serp-legacy.html'), SERP_URL);
    expect(parsed.ok).toBe(true);
    expect(parsed.query).toBe('다이슨 에어랩');
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].title).toContain('사용 후기');
    expect(parsed.results[0].blog_id).toBe('legacy1');
  });

  it('marks an unknown DOM as a parse failure while preserving the URL query', () => {
    const doc = new DOMParser().parseFromString('<div><p>전혀 다른 구조</p></div>', 'text/html');
    const parsed = parseSerp(doc, SERP_URL);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('unsupported_serp_dom');
    expect(parsed.query).toBe('테스트'); // from URL param
    expect(parsed.results).toEqual([]);
  });

  it('distinguishes an explicit empty state from an unknown layout', () => {
    const doc = new DOMParser().parseFromString(
      '<div class="api_no_result_wrap">검색 결과가 없습니다</div>',
      'text/html',
    );
    const parsed = parseSerp(doc, SERP_URL);
    expect(parsed.ok).toBe(true);
    expect(parsed.results).toEqual([]);
  });

  it('merges mixed layouts and deduplicates nested result containers', () => {
    const doc = new DOMParser().parseFromString(
      `<input id="query" value="혼합 검색" />
       <li class="bx"><div class="total_wrap"><a class="title_link" href="https://blog.naver.com/a/1">첫 결과</a></div></li>
       <div class="fds-ugc-block-mod"><a class="fds-comps-right-image-text-title" href="https://cafe.naver.com/b/2">둘째 결과</a></div>`,
      'text/html',
    );
    const parsed = parseSerp(doc, SERP_URL);
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((item) => item.title)).toEqual(['둘째 결과', '첫 결과']);
  });

  it('extracts blog ids only from naver blog urls', () => {
    expect(extractBlogId('https://blog.naver.com/abc_123/223')).toBe('abc_123');
    expect(extractBlogId('https://cafe.naver.com/xyz')).toBe('');
  });
});

describe('parseBlogPost', () => {
  it('parses a SmartEditor ONE post with counts', () => {
    const parsed = parseBlogPost(loadDoc('blog-se-one.html'));
    expect(parsed.ok).toBe(true);
    expect(parsed.found).toBe(true);
    expect(parsed.title).toBe('애드포스트 승인 조건 총정리');
    expect(parsed.posted_at).toContain('2026');
    expect(parsed.body_chars).toBeGreaterThan(20);
    expect(parsed.image_count).toBe(2);
    expect(parsed.video_count).toBe(1);
    expect(parsed.link_count).toBe(1);
    expect(parsed.likes).toBe(128);
    expect(parsed.comments).toBe(45);
  });

  it('reports found=false on a frame without the post container (safe missing)', () => {
    const doc = new DOMParser().parseFromString('<div id="top">외부 프레임</div>', 'text/html');
    const parsed = parseBlogPost(doc);
    expect(parsed.ok).toBe(true);
    expect(parsed.found).toBe(false);
    expect(parsed.likes).toBeNull(); // missing, not zero
  });
});
