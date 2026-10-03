import type { BlogComposeResponse, DraftDetail, TodayWorkItem } from '@ncos/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserMock = vi.hoisted(() => ({
  runtime: { sendMessage: vi.fn(async () => ({ ok: true, worker_id: 'fixture-worker', protocol_version: 3, build_id: 'test-build', debugger_available: true })) },
  storage: { local: { get: vi.fn(), set: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn(), create: vi.fn() },
}));

vi.mock('wxt/browser', () => ({ browser: browserMock }));

import App, { composeFailureHint, SidepanelTodayWork } from '../entrypoints/sidepanel/App';
import { CoreError } from '../lib/core';
import { useSettings } from '../lib/settings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plan = {
  order: 1,
  title: '제주도 가족여행 준비물 완벽 안내',
  blog_type: 'HOWTO',
  target_keyword: '제주도 가족여행',
  angle: '초보 가족을 위한 안내',
  reason: '자동 선택',
  generation_status: 'ready' as const,
  series_prev: null,
  series_next: null,
};

const composed: BlogComposeResponse = {
  keyword: '제주도 가족여행',
  snapshot_id: 17,
  draft: {
    draft_id: 31,
    version: 1,
    title: plan.title,
    body: '제주도 가족여행 완성 본문과 준비물을 차근차근 확인합니다. '.repeat(150),
    source_snapshot_id: 17,
    fact_pack_id: 8,
    fact_pack_version: 2,
    provider: 'ollama',
    model: 'qwen3:4b',
    prompt_version: 'v2-complete',
  },
  quality: {
    passed: true,
    score: 95,
    char_count: 2520,
    target_chars: 2500,
    paragraph_count: 11,
    keyword_count: 3,
    issues: [],
    checks: { length_ready: true },
    repair_attempted: false,
  },
  suggested_tags: ['제주도가족여행', '제주여행준비물'],
  analysis_summary: {
    monthly_searches: 1200,
    related_keyword_count: 2,
    question_count: 1,
    data_status: { hub_search: 'ok' },
  },
  fact_pack_id: 8,
  fact_pack_version: 2,
  preflight: {
    keyword: '제주도 가족여행',
    correction: null,
    sensitive: false,
    data_status: { adult: 'ok' },
    collected_at: '2026-09-04T00:00:00Z',
  },
};

const detail: DraftDetail = {
  draft_id: 31,
  keyword: composed.keyword,
  blog_type: 'HOWTO',
  title: plan.title,
  source_snapshot_id: 17,
  user_status: 'editing',
  fact_pack_id: 8,
  fact_pack_version: 2,
  created_at: '2026-09-04T00:00:00Z',
  plan,
  provider: 'ollama',
  model: 'qwen3:4b',
  prompt_version: 'v2-complete',
  versions: [{
    version: 1,
    title: plan.title,
    body: composed.draft.body,
    note: 'V1 원본',
    created_at: '2026-09-04T00:00:00Z',
  }],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('one-action complete blog flow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    browserMock.storage.local.get.mockResolvedValue({
      'ncos-settings': {
        coreUrl: 'http://127.0.0.1:3719',
        token: 'token',
        allowLlmWhenSensitiveUnknown: true,
        blogId: 'sence4u',
        defaultTags: '',
      },
    });
    browserMock.storage.local.set.mockResolvedValue(undefined);
    useSettings.setState({
      coreUrl: 'http://127.0.0.1:3719',
      token: 'token',
      allowLlmWhenSensitiveUnknown: true,
      blogId: 'sence4u',
      defaultTags: '',
      loaded: true,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('keeps advanced tools closed and creates a quality-checked complete article', async () => {
    let composeBody: Record<string, unknown> | null = null;
    let imageCalls = 0;
    let publishCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/handshake')) return response({ status: 'ok' });
      if (url.endsWith('/v1/llm/status')) return response({
        ready: true,
        provider: 'codex_cli',
        model: 'gpt-5.6-sol',
        message: '준비됨',
        action: '',
        engine: 'codex_cli',
        auth: 'chatgpt',
        quality_tier: 'high',
      });
      if (url.includes('/v1/drafts?limit=3')) return response({ items: [], next_cursor: null });
      if (url.endsWith('/v1/blogs/compose')) {
        composeBody = JSON.parse(String(init?.body));
        return response(composed, 201);
      }
      if (url.endsWith('/v1/drafts/31')) return response(detail);
      if (url.includes('/v1/drafts/31/assets?draft_version=1')) return response(
        [0, 1, 2].map((position) => ({
          asset_id: position + 1,
          draft_id: 31,
          draft_version: 1,
          filename: `image-${position + 1}.png`,
          mime_type: 'image/png',
          byte_size: 1024,
          sha256: `hash-${position + 1}`,
          position,
          anchor_after: position + 1,
          rights_status: 'approved',
          created_at: '2026-09-04T00:00:00Z',
        })),
      );
      if (url.endsWith('/v1/drafts/31/publish-jobs')) {
        publishCalls += 1;
        return response({
          job_id: 42, draft_id: 31, status: 'draft_saved', stage: 'draft_save',
          error_code: null, detail: '', history: [],
        }, 202);
      }
      if (url.endsWith('/v1/publish-jobs/42')) return response({
        job_id: 42, draft_id: 31, status: 'draft_saved', stage: 'draft_save',
        error_code: null, detail: '', history: [],
      });
      if (url.endsWith('/v1/research/specialized')) {
        imageCalls += 1;
        return response({
          mode: 'image', keyword: composed.keyword, status: 'ok',
          items: [{ title: '원본 사진', link: 'https://example.com/original', thumbnail: 'https://example.com/thumb.jpg', width: 800, height: 600 }],
          rights_notice: '권리 확인 필요',
        });
      }
      return response({}, 404);
    }));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>));
    await settle();

    expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(container.textContent).toContain('오늘 쓸 글은 무엇인가요?');
    expect(container.textContent).toContain('Codex 고품질 AI 연결됨 · ChatGPT 로그인');
    const input = container.querySelector<HTMLInputElement>('#compose-keyword')!;
    await act(async () => setInput(input, '제주도 가족여행'));
    await act(async () => button(container, '완성 글 만들기').click());
    await settle();
    await settle();

    expect(composeBody).toMatchObject({
      keyword: '제주도 가족여행',
      style: 'auto',
      target_chars: 2500,
      allow_sensitive_unknown: true,
    });
    expect(container.textContent).toContain('완성된 글');
    expect(container.textContent).toContain('자동 검사 95점');
    expect(container.textContent).toContain('사실 정확성과 표현은 임시저장 전에 직접 확인해 주세요.');
    expect(container.querySelector<HTMLInputElement>('#simple-blog-id')?.value).toBe('sence4u');
    expect(imageCalls).toBe(0);

    await act(async () => button(container, '참고 사진 찾기').click());
    await settle();
    expect(imageCalls).toBe(1);
    expect(container.textContent).toContain('자동 삽입되지 않습니다.');
    expect(container.textContent).toContain('원본 사진');

    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    await act(async () => button(container, '네이버에 임시저장').click());
    await settle();
    expect(publishCalls).toBe(1);
    expect(container.textContent).toContain('네이버 임시저장을 확인했습니다.');
  });

  it.each([false, true])('binds recommendation completion to the submitted topic (edited=%s)', async (edited) => {
    const params = new URLSearchParams({ compose_keyword: '원래 여행 주제', recommendation_id: '9', source_draft_id: '12', source_draft_mode: 'followup' });
    window.history.replaceState(null, '', `/?${params}`);
    const requests: Record<string, unknown>[] = [];
    const completed: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/handshake')) return response({ status: 'ok' });
      if (url.endsWith('/v1/llm/status')) return response({ ready: true, engine: 'codex_cli', provider: 'codex_cli', model: 'test', auth: 'chatgpt' });
      if (url.includes('/v1/drafts?') || url.includes('/v1/work/today')) return response({ items: [] });
      if (url.endsWith('/v1/blogs/compose')) { requests.push(JSON.parse(String(init?.body))); return response(composed, 201); }
      if (url.endsWith('/v1/drafts/31')) return response(detail);
      if (url.endsWith('/v1/drafts/12')) return response({ ...detail, draft_id: 12, keyword: '원래 여행 주제' });
      if (url.endsWith('/v1/performance/recommendations/9')) { completed.push(JSON.parse(String(init?.body))); return response({ id: 9, status: 'done' }); }
      return response({}, 404);
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>));
    await settle(); await settle();
    if (edited) await act(async () => setInput(container.querySelector<HTMLInputElement>('#compose-keyword')!, '전혀 다른 주제'));
    await act(async () => button(container, '완성 글 만들기').click());
    await settle(); await settle();
    expect(requests[0]?.source_draft_id).toBe(edited ? null : 12);
    expect(requests[0]?.source_draft_mode).toBe(edited ? 'revision' : 'followup');
    expect(requests[0]).not.toHaveProperty('recommendationId');
    expect(completed).toHaveLength(edited ? 0 : 1);
    // A second draft is allowed, but must not repeatedly complete an old action.
    await act(async () => button(container, '완성 글 만들기').click());
    await settle(); await settle();
    expect(completed).toHaveLength(edited ? 0 : 1);
  });

  it('explains why creation is disabled when the AI is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/handshake')) return response({ status: 'ok' });
      if (url.endsWith('/v1/llm/status')) return response({
        ready: false,
        provider: 'codex_cli',
        model: '',
        message: 'Codex CLI 로그인이 필요합니다.',
        action: '터미널에서 `codex login`을 실행하세요.',
        engine: 'codex_cli',
        auth: 'missing',
        quality_tier: 'high',
      });
      if (url.includes('/v1/drafts?limit=3')) return response({ items: [], next_cursor: null });
      return response({}, 404);
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>));
    await settle();
    await settle();

    const input = container.querySelector<HTMLInputElement>('#compose-keyword')!;
    await act(async () => setInput(input, '테스트 주제'));
    expect(button(container, '완성 글 만들기').disabled).toBe(true);
    expect(container.textContent).toContain('글쓰기 AI를 준비해야 합니다.');
    expect(container.textContent).toContain('codex login');
  });

  it('explains that a rejected Codex result was not saved or downgraded', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/handshake')) return response({ status: 'ok' });
      if (url.endsWith('/v1/llm/status')) return response({
        ready: true, provider: 'codex_cli', model: 'gpt-5.6-sol', message: '준비됨', action: '',
        engine: 'codex_cli', auth: 'chatgpt', quality_tier: 'high',
      });
      if (url.includes('/v1/drafts?limit=3')) return response({ items: [], next_cursor: null });
      if (url.endsWith('/v1/blogs/compose')) return response({
        error: { code: 'llm_unavailable', message: '완성 글 품질 검사를 통과하지 못했습니다.', provider: 'codex_cli' },
      }, 503);
      return response({}, 404);
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>));
    await settle();
    const input = container.querySelector<HTMLInputElement>('#compose-keyword')!;
    await act(async () => setInput(input, '품질 검사 주제'));
    await act(async () => button(container, '완성 글 만들기').click());
    await settle();

    expect(container.textContent).toContain('검사에 미달한 원고는 저장하지 않았으며');
    expect(container.textContent).toContain('저품질 AI로 자동 전환하지 않았습니다.');
    expect(container.textContent).not.toContain('완성된 글');
  });
});

describe('composeFailureHint', () => {
  it.each([
    ['Codex 사용량 한도에 도달했습니다.', '사용량이 갱신된 뒤'],
    ['Codex 글 작성이 300초를 초과했습니다.', '시간 초과 요청은 종료'],
    ['Codex CLI 로그인이 필요합니다. codex login', '터미널에서 codex login'],
  ])('maps %s to a user action', (message, expected) => {
    expect(composeFailureHint(new CoreError(503, 'llm_unavailable', message))).toContain(expected);
  });
});

describe('sidepanel today work', () => {
  it('shows at most three tasks and only runs the clicked task', async () => {
    const items: TodayWorkItem[] = Array.from({ length: 4 }, (_, index) => ({
      id: `performance:${index}`,
      priority: 4,
      source_type: 'performance_recommendation',
      source_id: index + 1,
      keyword: `키워드 ${index}`,
      title: `작업 ${index}`,
      reason: '성과 근거',
      action: 'open_performance',
      stale: false,
      draft_id: null,
      publish_job_id: null,
      published_content_id: null,
      published_url: null,
      calculated_at: '2026-09-06T00:00:00Z',
    }));
    const onAction = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(
      <SidepanelTodayWork items={items} loading={false} onAction={onAction} onDetails={vi.fn()} />,
    ));
    expect(container.querySelectorAll('article')).toHaveLength(3);
    expect(container.textContent).toContain('최대 3개');
    expect(onAction).not.toHaveBeenCalled();
    await act(async () => (container.querySelector('article button') as HTMLButtonElement).click());
    expect(onAction).toHaveBeenCalledWith(items[0]);
    await act(async () => root.unmount());
  });
});
