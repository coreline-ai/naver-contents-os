import { describe, expect, it } from 'vitest';
import { parsePerformanceTable, PERFORMANCE_TEMPLATES } from '../lib/performance-import';

describe('performance table parser', () => {
  it('parses a copied tab-separated Creator table and preserves explicit zero', () => {
    const parsed = parsePerformanceTable(
      '게시물 URL\t제목\t노출수\t유입수\tCTR\t상태\nhttps://blog.naver.com/me/1\t여행 글\t100\t0\t0%\tobserved_zero',
      'content_performance',
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([{
      canonical_url: 'https://blog.naver.com/me/1', title: '여행 글', impressions: 100,
      inflows: 0, ctr: 0, data_state: 'observed_zero',
    }]);
    expect(parsed.headers.find((header) => header.original === '노출수')?.mapped).toBe('impressions');
  });

  it('parses quoted CSV, commas in numbers, and warns without forwarding unknown columns', () => {
    const parsed = parsePerformanceTable(
      '검색어,노출수,유입수,메모\n"후쿠오카, 여행","1,200",36,"개인 메모"',
      'query_performance',
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toEqual({ query: '후쿠오카, 여행', impressions: 1200, inflows: 36 });
    expect(parsed.warnings[0]).toContain('메모');
    expect(parsed.rows[0]).not.toHaveProperty('메모');
  });

  it('rejects formula cells, malformed rows, negatives, and oversized inputs locally', () => {
    const formula = parsePerformanceTable('제목\t노출수\n=HYPERLINK("bad")\t10', 'content_performance');
    expect(formula.errors.join(' ')).toContain('수식');
    const negative = parsePerformanceTable('검색어\t유입수\n테스트\t-1', 'query_performance');
    expect(negative.errors.join(' ')).toContain('0 이상의 숫자');
    const malformed = parsePerformanceTable('검색어\t유입수\n테스트', 'query_performance');
    expect(malformed.errors.join(' ')).toContain('열 개수');

    const lines = ['검색어\t유입수', ...Array.from({ length: 1001 }, (_, index) => `키워드${index}\t1`)];
    const oversized = parsePerformanceTable(lines.join('\n'), 'query_performance');
    expect(oversized.errors.join(' ')).toContain('1,000행');
    expect(oversized.rows).toHaveLength(1000);
  });

  it('ships a template for every supported source data kind', () => {
    expect(Object.keys(PERFORMANCE_TEMPLATES).sort()).toEqual([
      'commerce_attribution', 'content_performance', 'query_performance', 'site_performance',
    ]);
    for (const [kind, template] of Object.entries(PERFORMANCE_TEMPLATES)) {
      expect(parsePerformanceTable(template, kind as keyof typeof PERFORMANCE_TEMPLATES).errors).toEqual([]);
    }
  });
});
it('accepts count suffixes for public reaction aggregates without admitting personal columns',()=>{
  const parsed=parsePerformanceTable('제목,공감수,댓글수,작성자전화번호\n검수,0,2,01012345678','content_performance');
  expect(parsed.rows).toEqual([{title:'검수',likes:0,comments:2}]);expect(parsed.warnings.join(' ')).toContain('작성자전화번호');
});
