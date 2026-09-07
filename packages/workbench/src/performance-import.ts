import type {
  PerformanceDataKind,
  PerformanceDataState,
  PerformanceImportRow,
} from '@ncos/contracts';

export interface PerformanceTableParse {
  rows: PerformanceImportRow[];
  headers: Array<{ original: string; mapped: string | null }>;
  warnings: string[];
  errors: string[];
}

type FieldType = 'text' | 'number' | 'integer' | 'state';

const COMMON_ALIASES: Record<string, string> = {
  '상태': 'data_state',
  '데이터상태': 'data_state',
  'data_state': 'data_state',
};

const ALIASES: Record<PerformanceDataKind, Record<string, string>> = {
  content_performance: {
    'url': 'canonical_url', '글url': 'canonical_url', '게시물url': 'canonical_url', 'canonical_url': 'canonical_url',
    '콘텐츠id': 'published_content_id', 'published_content_id': 'published_content_id',
    '제목': 'title', '글제목': 'title', 'title': 'title',
    '조회': 'views', '조회수': 'views', 'views': 'views',
    '노출': 'impressions', '노출수': 'impressions', 'impressions': 'impressions',
    '유입': 'inflows', '유입수': 'inflows', '클릭': 'inflows', '클릭수': 'inflows', 'inflows': 'inflows',
    'ctr': 'ctr', '유입률': 'ctr', '클릭률': 'ctr',
    '평균순위': 'average_rank', '평균노출순위': 'average_rank', 'average_rank': 'average_rank',
    '공감': 'likes', '공감수': 'likes', '좋아요': 'likes', '좋아요수': 'likes', 'likes': 'likes',
    '댓글': 'comments', '댓글수': 'comments', 'comments': 'comments',
  },
  query_performance: {
    '검색어': 'query', '키워드': 'query', 'query': 'query',
    'url': 'canonical_url', '글url': 'canonical_url', '게시물url': 'canonical_url', 'canonical_url': 'canonical_url',
    '콘텐츠id': 'published_content_id', 'published_content_id': 'published_content_id',
    '노출': 'impressions', '노출수': 'impressions', 'impressions': 'impressions',
    '유입': 'inflows', '유입수': 'inflows', '클릭': 'inflows', '클릭수': 'inflows', 'inflows': 'inflows',
    'ctr': 'ctr', '유입률': 'ctr', '클릭률': 'ctr',
    '평균순위': 'average_rank', '평균노출순위': 'average_rank', 'average_rank': 'average_rank',
  },
  commerce_attribution: {
    '추적id': 'tracking_id', '추적키': 'tracking_id', 'tracking_id': 'tracking_id',
    'url': 'destination_url', '랜딩url': 'destination_url', '스마트스토어url': 'destination_url', 'destination_url': 'destination_url',
    '콘텐츠id': 'published_content_id', 'published_content_id': 'published_content_id',
    '유입': 'inflows', '유입수': 'inflows', '방문': 'inflows', '방문수': 'inflows', 'inflows': 'inflows',
    '상품조회': 'product_views', '상품조회수': 'product_views', 'product_views': 'product_views',
    '결제건': 'orders', '결제건수': 'orders', '주문': 'orders', '주문수': 'orders', 'orders': 'orders',
    '결제율': 'conversion_rate', '전환율': 'conversion_rate', 'conversion_rate': 'conversion_rate',
    '기여금액': 'attributed_revenue', '기여매출': 'attributed_revenue', 'attributed_revenue': 'attributed_revenue',
  },
  site_performance: {
    'url': 'page_url', '페이지url': 'page_url', 'page_url': 'page_url',
    '수집': 'collected_pages', '수집페이지': 'collected_pages', 'collected_pages': 'collected_pages',
    '색인': 'indexed_pages', '색인페이지': 'indexed_pages', 'indexed_pages': 'indexed_pages',
    '노출': 'impressions', '노출수': 'impressions', 'impressions': 'impressions',
    '클릭': 'clicks', '클릭수': 'clicks', 'clicks': 'clicks',
    'ctr': 'ctr', '클릭률': 'ctr',
  },
};

const TYPES: Record<string, FieldType> = {
  canonical_url: 'text', published_content_id: 'integer', title: 'text', views: 'integer',
  impressions: 'integer', inflows: 'integer', ctr: 'number', average_rank: 'number',
  likes: 'integer', comments: 'integer', query: 'text', tracking_id: 'text',
  destination_url: 'text', product_views: 'integer', orders: 'integer',
  conversion_rate: 'number', attributed_revenue: 'number', page_url: 'text',
  collected_pages: 'integer', indexed_pages: 'integer', clicks: 'integer', data_state: 'state',
};

const STATES = new Set<PerformanceDataState>(['pending', 'partial', 'observed_zero', 'unavailable', 'ready']);

export const PERFORMANCE_TEMPLATES: Record<PerformanceDataKind, string> = {
  content_performance: '게시물 URL\t제목\t조회수\t노출수\t유입수\tCTR\t평균 노출 순위\t공감\t댓글\t상태\nhttps://blog.naver.com/myid/1\t예시 글\t320\t1200\t36\t3\t5.2\t10\t2\tready',
  query_performance: '검색어\t게시물 URL\t노출수\t유입수\tCTR\t평균 노출 순위\t상태\n후쿠오카 여행\thttps://blog.naver.com/myid/1\t500\t25\t5\t4.1\tready',
  commerce_attribution: '추적 ID\t스마트스토어 URL\t유입수\t상품 조회수\t결제 건수\t결제율\t기여 금액\t상태\nnaver.blog.social\thttps://smartstore.naver.com/store/products/1\t100\t80\t4\t4\t120000\tready',
  site_performance: '페이지 URL\t수집 페이지\t색인 페이지\t노출수\t클릭수\tCTR\t상태\nhttps://example.com/guide\t1\t1\t500\t20\t4\tready',
};

function compactHeader(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s·()/-]+/g, '');
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error('따옴표가 닫히지 않은 CSV입니다.');
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function parseNumber(value: string, integer: boolean): number | null {
  const cleaned = value.trim().replace(/,/g, '').replace(/%$/, '');
  if (!cleaned || cleaned === '-') return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('0 이상의 숫자가 아닙니다.');
  if (integer && !Number.isInteger(parsed)) throw new Error('정수여야 합니다.');
  return parsed;
}

function parseCell(value: string, field: string): string | number | null {
  const trimmed = value.trim();
  if (/^[=+@]/.test(trimmed) || /^-[^\d.]/.test(trimmed)) {
    throw new Error('스프레드시트 수식으로 시작하는 값은 가져올 수 없습니다.');
  }
  const type = TYPES[field] ?? 'text';
  if (type === 'integer') return parseNumber(trimmed, true);
  if (type === 'number') return parseNumber(trimmed, false);
  if (type === 'state') {
    if (!trimmed) return null;
    if (!STATES.has(trimmed as PerformanceDataState)) {
      throw new Error('상태는 pending, partial, observed_zero, unavailable, ready 중 하나여야 합니다.');
    }
    return trimmed;
  }
  return trimmed || null;
}

export function parsePerformanceTable(text: string, kind: PerformanceDataKind): PerformanceTableParse {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalizedText = text.replace(/^\uFEFF/, '').trim();
  if (!normalizedText) return { rows: [], headers: [], warnings, errors: ['붙여넣은 표가 비어 있습니다.'] };
  const firstLine = normalizedText.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  let matrix: string[][];
  try {
    matrix = parseDelimited(normalizedText, delimiter);
  } catch (error) {
    return { rows: [], headers: [], warnings, errors: [String(error instanceof Error ? error.message : error)] };
  }
  if (matrix.length < 2) return { rows: [], headers: [], warnings, errors: ['헤더와 데이터 행이 모두 필요합니다.'] };
  const aliases = { ...COMMON_ALIASES, ...ALIASES[kind] };
  const mapped = matrix[0].map((original) => aliases[compactHeader(original)] ?? null);
  const headers = matrix[0].map((original, index) => ({ original: original.trim(), mapped: mapped[index] }));
  const known = mapped.filter(Boolean);
  if (known.length === 0) errors.push('지원되는 열을 찾지 못했습니다. 샘플 양식의 헤더를 사용하세요.');
  const duplicates = known.filter((value, index) => known.indexOf(value) !== index);
  if (duplicates.length) errors.push(`같은 의미로 매핑된 열이 중복됩니다: ${[...new Set(duplicates)].join(', ')}`);
  const ignored = headers.filter((header) => !header.mapped).map((header) => header.original).filter(Boolean);
  if (ignored.length) warnings.push(`지원하지 않는 열은 전송하지 않습니다: ${ignored.join(', ')}`);
  if (matrix.length - 1 > 1000) errors.push('한 번에 최대 1,000행까지 가져올 수 있습니다.');

  const rows: PerformanceImportRow[] = [];
  for (let rowIndex = 1; rowIndex < matrix.length && rowIndex <= 1000; rowIndex += 1) {
    const cells = matrix[rowIndex];
    if (cells.length !== matrix[0].length) {
      errors.push(`${rowIndex + 1}행의 열 개수가 헤더와 다릅니다.`);
      continue;
    }
    const row: Record<string, string | number | null> = {};
    for (let column = 0; column < mapped.length; column += 1) {
      const field = mapped[column];
      if (!field) continue;
      try {
        const value = parseCell(cells[column] ?? '', field);
        if (value !== null) row[field] = value;
      } catch (error) {
        errors.push(`${rowIndex + 1}행 ${matrix[0][column]}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (Object.keys(row).length > 0) rows.push(row as unknown as PerformanceImportRow);
  }
  return { rows, headers, warnings, errors };
}
