import type { AnalyzeResponse, DraftCreateResponse } from '@ncos/contracts';
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
    score: { value: null, score_version: 'v1', contributions: [], missing: ['volume'] },
    questions: [],
    clusters: [],
    plan: [planItem],
  };
}

const draft: DraftCreateResponse = {
  draft_id: 11,
  version: 1,
  title: '생성된 제목',
  body: '생성된 본문',
  source_snapshot_id: 7,
  provider: 'skeleton',
  model: '',
  prompt_version: 'v1',
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
      'ncos-settings': { coreUrl: 'http://127.0.0.1:3719', token: 'token' },
    });
    browserMock.storage.local.set.mockResolvedValue(undefined);
    browserMock.tabs.query.mockResolvedValue([{ id: 1 }]);
    browserMock.tabs.sendMessage.mockResolvedValue(null);
    useSettings.setState({
      coreUrl: 'http://127.0.0.1:3719',
      token: 'token',
      loaded: true,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
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
  });
});
