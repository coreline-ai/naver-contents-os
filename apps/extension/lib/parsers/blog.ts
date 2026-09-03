/** Public blog post inspector. Runs both against the SmartEditor ONE render
 * (.se-main-container) and the legacy render (#postViewArea) — the iframe/direct
 * dual path noted in docs/05. Missing values stay null, never fake zeros. */

export interface BlogParse {
  ok: boolean;
  error?: string;
  found: boolean;
  title: string;
  posted_at: string;
  body_chars: number;
  image_count: number;
  video_count: number;
  link_count: number;
  likes: number | null;
  comments: number | null;
  url?: string;
}

export const BLOG_SELECTORS = {
  container: ['.se-main-container', '#postViewArea', '.post_ct'],
  title: ['.se-title-text', '.pcol1 .se-fs-fs32', 'h3.se_textarea', '.itemSubjectBoldfont', '.pcol1'],
  postedAt: ['.se_publishDate', '.blog2_container span.se_publishDate', '.date.fil5', '.blog2_series time'],
  image: ['img.se-image-resource', '.se-module-image img', '#postViewArea img'],
  video: ['.se-module-video', 'iframe[src*="tv.naver"]', 'video'],
  link: ['.se-module-oglink a', '.se-link', '#postViewArea a'],
  likes: ['.u_cnt._count', 'em.u_cnt._count'],
  comments: ['#commentCount', '._commentCount', 'em#commentCount'],
} as const;

function pick(doc: Document, candidates: readonly string[]): Element | null {
  for (const selector of candidates) {
    const found = doc.querySelector(selector);
    if (found) return found;
  }
  return null;
}

function count(doc: Document, candidates: readonly string[]): number {
  for (const selector of candidates) {
    const found = doc.querySelectorAll(selector);
    if (found.length > 0) return found.length;
  }
  return 0;
}

function parseCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, '');
  return digits ? Number(digits) : null;
}

export function parseBlogPost(doc: Document): BlogParse {
  try {
    const container = pick(doc, BLOG_SELECTORS.container);
    if (!container) {
      // top frame of blog.naver.com (post lives in the mainFrame iframe) or not a post page
      return emptyParse(true);
    }
    return {
      ok: true,
      found: true,
      title: pick(doc, BLOG_SELECTORS.title)?.textContent?.trim() ?? '',
      posted_at: pick(doc, BLOG_SELECTORS.postedAt)?.textContent?.trim() ?? '',
      body_chars: (container.textContent ?? '').replace(/\s+/g, ' ').trim().length,
      image_count: count(doc, BLOG_SELECTORS.image),
      video_count: count(doc, BLOG_SELECTORS.video),
      link_count: count(doc, BLOG_SELECTORS.link),
      likes: parseCount(pick(doc, BLOG_SELECTORS.likes)?.textContent),
      comments: parseCount(pick(doc, BLOG_SELECTORS.comments)?.textContent),
    };
  } catch (error) {
    return { ...emptyParse(false), error: String(error) };
  }
}

function emptyParse(ok: boolean): BlogParse {
  return {
    ok,
    found: false,
    title: '',
    posted_at: '',
    body_chars: 0,
    image_count: 0,
    video_count: 0,
    link_count: 0,
    likes: null,
    comments: null,
  };
}
