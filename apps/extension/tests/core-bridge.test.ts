import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: mocks.sendMessage } } }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });
async function handler() {
  vi.stubGlobal('defineContentScript', (value: unknown) => value);
  const listen = vi.spyOn(window, 'addEventListener');
  const module = await import('../entrypoints/core-bridge.content');
  (module.default as unknown as { main: () => void }).main();
  const callback = listen.mock.calls.at(-1)![1] as (e: MessageEvent) => void;
  window.removeEventListener('message', callback);
  return callback;
}
const request = { source: 'naver-content-os-web', type: 'NCOS_BROWSER_CONNECTION', requestId: 'a1111111-1111-4111-8111-111111111111' };
it('echoes only the request nonce with the diagnostic response', async () => {
  const callback = await handler(); const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  mocks.sendMessage.mockResolvedValue({ ok: true, worker_id: 'ego' });
  callback(new MessageEvent('message', { source: window, origin: window.location.origin, data: request }));
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.sendMessage).toHaveBeenCalledWith({ type: request.type });
  expect(post).toHaveBeenCalledWith({ source: 'naver-content-os-extension', type: request.type, requestId: request.requestId, reply: { ok: true, worker_id: 'ego' } }, window.location.origin);
});
it.each(['origin', 'source', 'nonce', 'sender'])('does not forward a malformed %s', async invalid => {
  const callback = await handler();
  callback(new MessageEvent('message', { source: invalid === 'source' ? null : window, origin: invalid === 'origin' ? 'https://evil.invalid' : window.location.origin, data: { ...request, ...(invalid === 'nonce' ? { requestId: 'invalid' } : invalid === 'sender' ? { source: 'evil' } : {}) } }));
  expect(mocks.sendMessage).not.toHaveBeenCalled();
});
