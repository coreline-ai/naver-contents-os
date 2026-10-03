import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient, CoreError } from '@ncos/core-client';
import { sessionRequest } from '../src/session';

afterEach(() => vi.unstubAllGlobals());
describe('shared Core client authentication', () => {
  it('fetches private image bytes using authenticated headers, never a token URL', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetch);
    const result = await new CoreClient('', { kind: 'web-session' }).draftAssetContent(7, 2);
    expect(result.size).toBe(3);
    expect(fetch.mock.calls[0][0]).toBe('/v1/drafts/7/assets/2/content');
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', headers: { 'X-NCOS-Web': '1' } });
    await expect(new CoreClient('https://example.com', { kind: 'web-session' }).draftAssetContent(7, 2)).rejects.toMatchObject({ code: 'unsafe_origin' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps extension token requests and uses cookies only for the same-origin web client', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"status":"ok"}'));
    vi.stubGlobal('fetch', fetch);
    await new CoreClient('http://127.0.0.1:3719', 'extension-token').handshake();
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', headers: { 'X-Local-Token': 'extension-token' } });
    fetch.mockResolvedValue(new Response('{"status":"ok"}'));
    await new CoreClient('', { kind: 'web-session' }).handshake();
    expect(fetch.mock.calls[1][0]).toBe('/v1/handshake');
    expect(fetch.mock.calls[1][1]).toMatchObject({ credentials: 'same-origin', headers: { 'X-NCOS-Web': '1' } });
    expect(fetch.mock.calls[1][1].headers).not.toHaveProperty('X-Local-Token');
  });
  it('never sends a web session to a caller-configured URL', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(new CoreClient('https://example.com', { kind: 'web-session' }).handshake()).rejects.toMatchObject({ code: 'unsafe_origin' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves abort and normalizes network/auth errors without retries', async () => {
    const controller = new AbortController(); controller.abort();
    const aborted = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted));
    await expect(new CoreClient('', { kind: 'web-session' }).suggestKeywords('여행', controller.signal)).rejects.toBe(aborted);
    await expect(new CoreClient('', { kind: 'web-session' }).handshake()).rejects.toMatchObject({ code: 'unreachable' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"detail":{"code":"web_session","message":"다시 연결"}}', { status: 401 })));
    await expect(new CoreClient('', { kind: 'web-session' }).handshake()).rejects.toMatchObject({ status: 401, message: '다시 연결' });
  });
  it('exchanges a code in a POST body, never a URL or localStorage', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"connected":true,"mode":"live"}')); vi.stubGlobal('fetch', fetch);
    expect(await sessionRequest('POST', 'one-time-code')).toEqual({ connected: true, mode: 'live' });
    expect(fetch.mock.calls[0][0]).toBe('/web/session/connect');
    expect(fetch.mock.calls[0][1].body).toBe('{"code":"one-time-code"}');
    expect(localStorage.length).toBe(0);
  });
});
it('serializes optional performance scope without changing old unfiltered clients', async () => {
  const fetch=vi.fn(async()=>new Response('{}'));vi.stubGlobal('fetch',fetch);const c=new CoreClient('',{kind:'web-session'});
  await c.performanceOverview();await c.performanceOverview(2,8);await c.contentPerformance(8,2);await c.queryPerformance(undefined,2);await c.listPerformanceImports(100,2);await c.performanceRecommendations('done',2);
  expect(fetch.mock.calls.map((c:any[])=>c[0])).toEqual(['/v1/performance/overview','/v1/performance/overview?import_id=8&channel_id=2','/v1/performance/contents?import_id=8&channel_id=2','/v1/performance/queries?channel_id=2','/v1/performance/imports?limit=100&channel_id=2','/v1/performance/recommendations?status=done&channel_id=2']);
});
