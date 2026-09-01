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
});
