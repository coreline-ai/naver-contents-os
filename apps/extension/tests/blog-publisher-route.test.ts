import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ listener: vi.fn(), sendMessage: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { onMessage: { addListener: mocks.listener }, sendMessage: mocks.sendMessage } } }));
let listener: (message: unknown, sender: unknown, reply: (value: unknown) => void) => unknown;
beforeEach(async () => {
  vi.clearAllMocks(); vi.resetModules();
  vi.stubGlobal('defineContentScript', (config: { main: () => void }) => config);
  const script = await import('../entrypoints/blog.content');
  (script.default as unknown as { main: () => void }).main(); listener = mocks.listener.mock.calls[0][0];
  document.body.innerHTML = '<p>사용자 작성 내용</p><button class="publish_btn__WEpYf">공개 발행</button>';
  mocks.sendMessage.mockResolvedValue({ ok: true, jobId: 1, stage: 'reopen_verify' });
});
afterEach(() => vi.unstubAllGlobals());
describe('legacy content messages use the authoritative background transport', () => {
  it.each(['NCOS_EXECUTE_PUBLISH_JOB', 'NCOS_VERIFY_PUBLISH_JOB'])('routes %s without local DOM/event side effects', async type => {
    const before = document.body.innerHTML;
    const result = await new Promise(resolve => listener({ type, command: { job_id: 1, attempt_id: 'attempt', lease_owner: 'owner' } }, {}, resolve));
    expect(result).toMatchObject({ ok: true, stage: 'reopen_verify' });
    expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'NCOS_RUN_PUBLISH_JOB', jobId: 1 });
    expect(document.body.innerHTML).toBe(before);
  });
  it('rejects commands without attempt identity before any side effect', async () => {
    const before = document.body.innerHTML;
    const result = await new Promise(resolve => listener({ type: 'NCOS_EXECUTE_PUBLISH_JOB', command: { job_id: 1 } }, {}, resolve));
    expect(result).toMatchObject({ ok: false, error_code: 'attempt_metadata_missing' });
    expect(mocks.sendMessage).not.toHaveBeenCalled(); expect(document.body.innerHTML).toBe(before);
  });
});
