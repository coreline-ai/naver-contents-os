import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DraftCreateRequest } from '@ncos/contracts';
import { CoreClient } from '../lib/core';

afterEach(() => vi.unstubAllGlobals());

describe('CoreClient draft contract', () => {
  it('posts a draft request with the local token', async () => {
    const responseBody = {
      draft_id: 1,
      version: 1,
      title: '초안',
      body: '본문',
      source_snapshot_id: 3,
      provider: 'skeleton',
      model: '',
      prompt_version: 'v1',
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => responseBody });
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreClient('http://127.0.0.1:3719', 'token');
    const input: DraftCreateRequest = {
      keyword: '테스트',
      snapshot_id: 3,
      plan_item: {
        order: 1,
        title: '테스트 글',
        blog_type: 'HOWTO',
        target_keyword: '테스트',
        angle: '',
        reason: '',
        generation_status: 'ready',
        series_prev: null,
        series_next: null,
      },
      questions: [],
      generation_mode: 'skeleton',
    };

    await expect(client.createDraft(input)).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3719/v1/drafts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Local-Token': 'token' }),
        body: JSON.stringify(input),
      }),
    );
  });

  it('maps validation detail messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ detail: [{ msg: 'Value error, invalid plan' }] }),
      }),
    );
    const client = new CoreClient('http://127.0.0.1:3719', 'token');
    await expect(client.analyze('')).rejects.toMatchObject({
      status: 422,
      code: '422',
      message: 'Value error, invalid plan',
    });
  });

  it('starts and reads publish jobs without putting content in the request', async () => {
    const job = {
      job_id: 9,
      draft_id: 3,
      status: 'pending',
      stage: '',
      error_code: null,
      detail: '',
      history: [],
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => job });
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreClient('http://127.0.0.1:3719', 'token');

    await expect(
      client.startPublishJob(3, { blog_id: 'target_blog', tags: ['태그'] }),
    ).resolves.toEqual(job);
    await expect(client.getPublishJob(9)).resolves.toEqual(job);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3719/v1/drafts/3/publish-jobs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ blog_id: 'target_blog', tags: ['태그'] }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:3719/v1/publish-jobs/9',
      expect.not.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock.mock.calls[0][1]?.body).not.toContain('본문');
  });

  it('uses explicit research routes and handles empty DELETE responses', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).endsWith('/v1/watchlist/3')) {
        return { ok: true, status: 204, json: async () => { throw new Error('no body'); } };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'ok', nodes: [], edges: [] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreClient('http://127.0.0.1:3719', 'token');

    await client.graph('러닝화', 7);
    await expect(client.deleteWatchlist(3)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3719/v1/research/graph',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ keyword: '러닝화', snapshot_id: 7, force_refresh: false }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:3719/v1/watchlist/3',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
