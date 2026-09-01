/** Naver SERP parser (content-script side).
 *
 * The SERP is not an API contract: selectors are candidate lists, every field is
 * optional, and a parse failure returns { ok: false } instead of throwing so the
 * extension never crashes on a DOM change (docs/12).
 */

export interface ParsedSerpResult {
  rank: number;
  result_type: string;
  title: string;
  url: string;
  blog_id: string;
  description: string;
  posted_at: string;
  is_ad: boolean;
}

export interface SerpParse {
  ok: boolean;
  error?: string;
  query: string;
  results: ParsedSerpResult[];
}

/** Candidate selectors, newest layout first. Update here when Naver changes DOM. */
export const SERP_SELECTORS = {
  queryInput: ['input#nx_query', 'input#query'],
  item: ['div.fds-ugc-block-mod', 'li.bx', 'div.total_wrap'],
  titleLink: [
    'a.fds-comps-right-image-text-title',
    '.title_area > a',
    'a.title_link',
    '.total_tit a',
    'a.api_txt_lines.total_tit',
  ],
  description: ['.fds-comps-right-image-text-content', '.dsc_area', '.api_txt_lines.dsc_txt', '.total_dsc'],
  author: ['.fds-info-inner-text', '.user_info > a.name', '.sub_txt.sub_name', '.user_box .name'],
  postedAt: ['.fds-info-sub-inner-text', '.user_info span.sub', 'span.sub_time', '.date'],
  adBadge: ['.link_ad', '.spview .ad_label', '.fds-ad-badge', '.ad_area'],
} as const;

function pick(root: Element | Document, candidates: readonly string[]): Element | null {
  for (const selector of candidates) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

function text(root: Element | Document, candidates: readonly string[]): string {
  return pick(root, candidates)?.textContent?.trim() ?? '';
}

export function extractBlogId(url: string): string {
  const match = /blog\.naver\.com\/([A-Za-z0-9_-]+)/.exec(url);
  return match ? match[1] : '';
}

export function parseQuery(doc: Document, locationHref: string): string {
  for (const selector of SERP_SELECTORS.queryInput) {
    const input = doc.querySelector<HTMLInputElement>(selector);
    if (input?.value) return input.value.trim();
  }
  try {
    return new URL(locationHref).searchParams.get('query')?.trim() ?? '';
  } catch {
    return '';
  }
}

export function parseSerp(doc: Document, locationHref: string, limit = 20): SerpParse {
  try {
    const query = parseQuery(doc, locationHref);
    const results: ParsedSerpResult[] = [];

    // One page renders one layout: the first item selector that yields results wins,
    // otherwise nested containers (li.bx > .total_wrap) would parse twice.
    for (const itemSelector of SERP_SELECTORS.item) {
      for (const element of Array.from(doc.querySelectorAll(itemSelector))) {
        if (results.length >= limit) break;

        const link = pick(element, SERP_SELECTORS.titleLink) as HTMLAnchorElement | null;
        const title = link?.textContent?.trim() ?? '';
        if (!title) continue; // not a UGC result block

        const url = link?.getAttribute('href') ?? '';
        results.push({
          rank: results.length + 1,
          result_type: url.includes('blog.naver.com')
            ? 'blog'
            : url.includes('cafe.naver.com')
              ? 'cafe'
              : 'web',
          title,
          url,
          blog_id: extractBlogId(url),
          description: text(element, SERP_SELECTORS.description),
          posted_at: text(element, SERP_SELECTORS.postedAt),
          is_ad: pick(element, SERP_SELECTORS.adBadge) !== null,
        });
      }
      if (results.length > 0) break;
    }
    return { ok: true, query, results };
  } catch (error) {
    return { ok: false, error: String(error), query: '', results: [] };
  }
}
