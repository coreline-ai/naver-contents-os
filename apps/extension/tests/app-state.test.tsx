import type { AnalyzeResponse, DraftCreateResponse, DraftDetail } from '@ncos/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserMock = vi.hoisted(() => ({
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
    },
  },
  tabs: {
    query: vi.fn(),
    sendMessage: vi.fn(),
  },
}));

vi.mock('wxt/browser', () => ({ browser: browserMock }));

import App from '../entrypoints/sidepanel/App';
import { useSettings } from '../lib/settings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const planItem = {
  order: 1,
  title: '안정화 방법',
  blog_type: 'HOWTO',
  target_keyword: '테스트',
  angle: '검증',
  reason: '회귀 확인',
  generation_status: 'ready' as const,
  series_prev: null,
  series_next: null,
};

function analysis(keyword: string): AnalyzeResponse {
  return {
    keyword,
    snapshot_id: 7,
    collected_at: '2026-09-02T00:00:00Z',
    data_status: { searchad: 'ok', hub_search: 'ok', hub_trend: 'ok' },
    metric: null,
    related_keywords: [],
    landscape: null,
    trend: null,
    serp: null,
    score: {
      value: null,
      score_version: 'v1',
      coverage_weight: 0,
      available_component_count: 0,
      total_component_count: 8,
      confidence: 'unavailable',
      contributions: [],
      missing: ['volume'],
    },
    questions: [],
    clusters: [],
    plan: [planItem],
  };
}

function analysisWithSuggestions(keyword: string): AnalyzeResponse {
  const result = analysis(keyword);
  return {
    ...result,
    related_keywords: [
      {
        source: 'SEARCH_AD',
        collected_at: '2026-09-02T00:00:00Z',
        keyword: '연관 키워드',
        monthly_pc_searches: 10,
        monthly_mobile_searches: 90,
        volume_masked: false,
        ad_competition: '중간',
        ad_click_metrics: {},
      },
    ],
    clusters: [{ label: '클러스터', keywords: ['클러스터 키워드'], total_volume: 100 }],
  };
}

const draft: DraftCreateResponse = {
  draft_id: 11,
  version: 1,
  title: '생성된 제목',
  body: '생성된 본문',
  source_snapshot_id: 7,
  fact_pack_id: null,
  fact_pack_version: null,
  provider: 'skeleton',
  model: '',
  prompt_version: 'v1',
};

const draftDetail: DraftDetail = {
  draft_id: draft.draft_id,
  keyword: '테스트',
  blog_type: 'HOWTO',
  title: draft.title,
  source_snapshot_id: draft.source_snapshot_id,
  user_status: 'editing',
  fact_pack_id: null,
  fact_pack_version: null,
  created_at: '2026-09-02T00:00:00Z',
  plan: planItem,
  provider: draft.provider,
  model: draft.model,
  prompt_version: draft.prompt_version,
  versions: [
    {
      version: 1,
      title: draft.title,
      body: draft.body,
      note: 'V1 원본',
      created_at: '2026-09-02T00:00:00Z',
    },
  ],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function wrapper(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('sidepanel keyword state', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.restoreAllMocks();
    browserMock.storage.local.get.mockResolvedValue({
      'ncos-settings': {
        coreUrl: 'http://127.0.0.1:3719',
        token: 'token',
        allowLlmWhenSensitiveUnknown: false,
      },
    });
    browserMock.storage.local.set.mockResolvedValue(undefined);
    browserMock.tabs.query.mockResolvedValue([{ id: 1 }]);
    browserMock.tabs.sendMessage.mockResolvedValue(null);
    useSettings.setState({
      coreUrl: 'http://127.0.0.1:3719',
      token: 'token',
      allowLlmWhenSensitiveUnknown: false,
      loaded: true,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('debounces provider suggestions and renders them after local-first input', async () => {
    const suggestBodies: Array<{ query: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/handshake')) return response({ status: 'ok' });
        if (url.endsWith('/v1/keywords/suggest')) {
          suggestBodies.push(JSON.parse(String(init?.body)));
          return response({
            query: '러닝화',
            status: 'ok',
            data_status: { searchad: 'ok' },
            suggestions: [{
              keyword: '러닝화추천', source: 'searchad', monthly_searches: 1200,
              volume_masked: false, competition: '중간', from_cache: false,
              collected_at: '2026-09-02T00:00:00Z',
            }],
            collected_at: '2026-09-02T00:00:00Z',
          });
        }
        return response({}, 404);
      }),
    );
    await act(async () => root.render(wrapper(<App />)));
    await settle();

    vi.useFakeTimers();
    const input = container.querySelector<HTMLInputElement>('input[placeholder="키워드 입력"]')!;
    await act(async () => setInput(input, '러닝화'));
    await act(async () => { await vi.advanceTimersByTimeAsync(699); });
    expect(suggestBodies).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await Promise.resolve(); });
    expect(suggestBodies).toEqual([{ query: '러닝화', limit: 8 }]);
    expect(container.textContent).toContain('러닝화추천');
  });

  it('clears analysis and draft when the keyword changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/handshake')) return response({ status: 'ok' });
        if (url.endsWith('/v1/keywords/analyze')) {
          const body = JSON.parse(String(init?.body));
          return response(analysis(body.keyword));
        }
        if (url.endsWith('/v1/drafts')) return response(draft, 201);
        if (url.endsWith('/v1/drafts/11')) return response(draftDetail);
        return response({}, 404);
      }),
    );
    await act(async () => root.render(wrapper(<App />)));
    await settle();

    const input = container.querySelector<HTMLInputElement>('input[placeholder="키워드 입력"]')!;
    await act(async () => setInput(input, '첫 키워드'));
    await act(async () => button(container, '분석').click());
    await settle();
    expect(container.textContent).toContain('15편 콘텐츠 플랜');

    await act(async () => button(container, '구조 초안').click());
    await settle();
    expect(container.textContent).toContain('생성된 초안 v1');

    await act(async () => setInput(input, '둘째 키워드'));
    expect(container.textContent).not.toContain('15편 콘텐츠 플랜');
    expect(container.textContent).not.toContain('생성된 초안 v1');
  });

  it('restores a recent draft after extension state is recreated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/v1/handshake')) return response({ status: 'ok' });
        if (url.includes('/v1/drafts?limit=3')) return response({
          items: [{
            draft_id: 11,
            keyword: '테스트',
            title: '생성된 제목',
            blog_type: 'HOWTO',
            latest_version: 1,
            latest_version_at: '2026-09-02T00:00:00Z',
            user_status: 'editing',
            latest_job_status: 'none',
            latest_job_id: null,
            latest_job_stage: null,
            latest_job_error: null,
            source_snapshot_id: 7,
          }],
          next_cursor: null,
        });
        if (url.endsWith('/v1/drafts/11')) return response(draftDetail);
        return response({}, 404);
      }),
    );
    await act(async () => root.render(wrapper(<App />)));
    await settle();
    await settle();
    expect(container.textContent).toContain('최근 작업 계속');
    const resume = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('이어쓰기'))!;
    await act(async () => resume.click());
    await settle();
    expect(container.textContent).toContain('생성된 초안 v1');
    expect(container.querySelector<HTMLInputElement>('input[placeholder="키워드 입력"]')?.value).toBe('테스트');
  });

  it('ignores an old analysis response after the keyword changes', async () => {
    let finishAnalysis: ((value: Response) => void) | undefined;
    const pendingAnalysis = new Promise<Response>((resolve) => {
      finishAnalysis = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        if (String(input).endsWith('/v1/handshake')) {
          return Promise.resolve(response({ status: 'ok' }));
        }
        return pendingAnalysis;
      }),
    );
    await act(async () => root.render(wrapper(<App />)));
    await settle();

    const input = container.querySelector<HTMLInputElement>('input[placeholder="키워드 입력"]')!;
    await act(async () => setInput(input, '이전 키워드'));
    await act(async () => button(container, '분석').click());
    await act(async () => setInput(input, '새 키워드'));
    finishAnalysis?.(response(analysis('이전 키워드')));
    await settle();

    expect(input.value).toBe('새 키워드');
    expect(container.textContent).not.toContain('15편 콘텐츠 플랜');
  });

  it('resets old results when pulling the current search and uses the displayed keyword for refresh', async () => {
    const analyzeBodies: Array<{ keyword: string; force_refresh: boolean }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/handshake')) return response({ status: 'ok' });
        if (url.endsWith('/v1/keywords/analyze')) {
          const body = JSON.parse(String(init?.body));
          analyzeBodies.push(body);
          return response(analysis(body.force_refresh ? body.keyword : '서버 정규화 키워드'));
        }
        return response({}, 404);
      }),
    );
    await act(async () => root.render(wrapper(<App />)));
    await settle();

    const input = container.querySelector<HTMLInputElement>('input[placeholder="키워드 입력"]')!;
    await act(async () => setInput(input, '입력 키워드'));
    await act(async () => button(container, '분석').click());
    await settle();
    await act(async () => button(container, '강제 새로고침').click());
    await settle();
    expect(analyzeBodies.at(-1)).toMatchObject({
      keyword: '서버 정규화 키워드',
      force_refresh: true,
    });

    browserMock.tabs.sendMessage.mockResolvedValueOnce({
      ok: true,
      query: '현재 검색어',
      results: [
        {
          rank: 1,
          result_type: 'blog',
          title: '결과',
          url: 'https://example.com',
          blog_id: 'blog',
          description: '',
          posted_at: '',
          is_ad: false,
        },
      ],
    });
    await act(async () => button(container, '현재 검색어 가져오기').click());
    await settle();

    expect(input.value).toBe('현재 검색어');
    expect(container.textContent).toContain('SERP 1건 첨부됨');
    expect(container.textContent).not.toContain('15편 콘텐츠 플랜');

    await act(async () => button(container, '분석').click());
    await settle();
    expect(container.textContent).toContain('15편 콘텐츠 플랜');
    browserMock.tabs.sendMessage.mockRejectedValueOnce(new Error('content script unavailable'));
    await act(async () => button(container, '현재 검색어 가져오기').click());
    await settle();
    expect(container.textContent).not.toContain('SERP 1건 첨부됨');
    expect(container.textContent).not.toContain('15편 콘텐츠 플랜');

    browserMock.tabs.sendMessage.mockResolvedValueOnce({
      ok: false,
      error: 'unsupported_serp_dom',
      query: '알 수 없는 화면',
      results: [],
    });
    await act(async () => button(container, '현재 검색어 가져오기').click());
    await settle();
    expect(container.textContent).toContain('현재 네이버 검색 화면 구조를 인식하지 못했습니다.');
  });

  it('reanalyzes related and cluster keywords without carrying stale SERP state', async () => {
    const analyzeBodies: Array<{ keyword: string; serp: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/handshake')) return response({ status: 'ok' });
        if (url.endsWith('/v1/keywords/analyze')) {
          const body = JSON.parse(String(init?.body));
          analyzeBodies.push(body);
          const suggested = body.keyword.startsWith('시작');
          return response(suggested ? analysisWithSuggestions(body.keyword) : analysis(body.keyword));
        }
        return response({}, 404);
      }),
    );
    await act(async () => root.render(wrapper(<App />)));
    await settle();

    const input = container.querySelector<HTMLInputElement>('input[placeholder="키워드 입력"]')!;
    await act(async () => setInput(input, '시작 키워드'));
    await act(async () => button(container, '분석').click());
    await settle();
    await act(async () => button(container, '재분석').click());
    await settle();
    expect(input.value).toBe('연관 키워드');
    expect(analyzeBodies.at(-1)).toMatchObject({ keyword: '연관 키워드', serp: null });

    await act(async () => setInput(input, '시작 클러스터'));
    await act(async () => button(container, '분석').click());
    await settle();
    await act(async () => button(container, '클러스터 키워드').click());
    await settle();
    expect(input.value).toBe('클러스터 키워드');
    expect(analyzeBodies.at(-1)).toMatchObject({ keyword: '클러스터 키워드', serp: null });
  });

  it('allows an explicit local override when sensitive classification is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/handshake')) return response({ status: 'ok' });
        if (url.endsWith('/v1/keywords/preflight')) {
          return response({
            keyword: '판별 실패',
            correction: null,
            sensitive: null,
            data_status: { errata: 'ok', adult: 'request' },
            collected_at: '2026-09-02T00:00:00Z',
          });
        }
        if (url.endsWith('/v1/keywords/analyze')) {
          const body = JSON.parse(String(init?.body));
          return response(analysis(body.keyword));
        }
        return response({}, 404);
      }),
    );
    await act(async () => root.render(wrapper(<App />)));
    await settle();

    const input = container.querySelector<HTMLInputElement>('input[placeholder="키워드 입력"]')!;
    await act(async () => setInput(input, '판별 실패'));
    await act(async () => button(container, '분석').click());
    await settle();
    expect(container.textContent).toContain('민감 키워드 판별 API가 응답하지 않았습니다.');
    expect(button(container, 'AI 초안').disabled).toBe(true);

    await act(async () => button(container, '이 기기에서 AI 초안 허용').click());
    await settle();
    expect(button(container, 'AI 초안').disabled).toBe(false);
    expect(browserMock.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
      'ncos-settings': expect.objectContaining({ allowLlmWhenSensitiveUnknown: true }),
    }));
  });
});
