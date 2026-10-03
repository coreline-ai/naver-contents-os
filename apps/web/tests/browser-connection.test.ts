import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { browserConnection } from '../../../packages/workbench/src/browser-connection';

const valid = { ok: true, worker_id: 'ego-worker', protocol_version: 3, build_id: 'source-hash', debugger_available: true };
let sent: ReturnType<typeof vi.spyOn>;
beforeEach(() => { vi.useFakeTimers(); sent = vi.spyOn(window, 'postMessage').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function response(reply = valid, extra: Record<string, unknown> = {}, origin = window.location.origin, source: Window | null = window) {
  const request = sent.mock.calls.at(-1)![0] as Record<string, unknown>;
  window.dispatchEvent(new MessageEvent('message', { origin, source, data: { ...request, source: 'naver-content-os-extension', reply, ...extra } }));
}
it('accepts only the matching same-window nonce and clears its timer', async () => {
  const result = browserConnection();
  response(); expect(await result).toEqual(valid); expect(vi.getTimerCount()).toBe(0);
});
it.each(['origin', 'source', 'nonce', 'type', 'sender'])('ignores invalid %s and times out instead of reporting ready', async invalid => {
  const result = browserConnection(10); const failure = expect(result).rejects.toThrow('확장 응답이 없습니다');
  response(valid, invalid === 'nonce' ? { requestId: 'stale' } : invalid === 'type' ? { type: 'OTHER' } : invalid === 'sender' ? { source: 'evil' } : {}, invalid === 'origin' ? 'https://evil.invalid' : window.location.origin, invalid === 'source' ? null : window);
  await vi.advanceTimersByTimeAsync(10); await failure;
});
it.each([{ protocol_version: 2 }, { debugger_available: false }, { build_id: '' }, { worker_id: '' }, { ok: false }])('rejects an incompatible reply %j', async patch => {
  const result = browserConnection(); const failure = expect(result).rejects.toThrow('확장을 업데이트');
  response({ ...valid, ...patch }); await failure; expect(vi.getTimerCount()).toBe(0);
});
it('does not accept an old reply for a subsequent request', async () => {
  const first = browserConnection(); const previous = (sent.mock.calls[0][0] as { requestId: string }).requestId;
  response(); await first;
  const second = browserConnection(10); const failure = expect(second).rejects.toThrow();
  response(valid, { requestId: previous }); await vi.advanceTimersByTimeAsync(10); await failure;
});
