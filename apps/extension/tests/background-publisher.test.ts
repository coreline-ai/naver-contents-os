import { setImmediate as realImmediate } from 'node:timers';
import type { PublishCommand } from '@ncos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: {
    getPublishJob: vi.fn(), getPublishCommand: vi.fn(), nextPublishCommand: vi.fn(),
    publisherHeartbeat: vi.fn(), recordPublishEvent: vi.fn(),
  },
  browser: {
    runtime: { id: 'test-extension', getManifest: vi.fn(() => ({ version: 'test', version_name: 'test-build' })), onMessage: { addListener: vi.fn() } },
    debugger: { attach: vi.fn() },
    storage: { local: { get: vi.fn(async () => ({ 'ncos-publisher-worker-id': 'worker' })), set: vi.fn() } },
    sidePanel: { setPanelBehavior: vi.fn() },
    tabs: { query: vi.fn(), get: vi.fn(), update: vi.fn(), create: vi.fn(), remove: vi.fn() },
  },
  execute: vi.fn(), verify: vi.fn(), loadSettings: vi.fn(),
}));
vi.mock('wxt/browser', () => ({ browser: mocks.browser }));
vi.mock('~/lib/settings', () => ({ loadSettings: mocks.loadSettings }));
vi.mock('~/lib/core', () => ({ CoreClient: class { constructor() { return mocks.client; } } }));
vi.mock('~/lib/debugger-editor', () => ({
  DebuggerEditorError: class extends Error { constructor(public stage: string, public code: string, message: string) { super(message); } },
  DebuggerSmartEditor: class { execute = mocks.execute; verify = mocks.verify; },
}));

let command: PublishCommand;
let cleanup: (() => void) | undefined;
let listener: (message: unknown, sender: unknown, reply: (value: unknown) => void) => unknown;

async function flush(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve(); }
async function settle<T>(task: Promise<T>): Promise<T> {
  let finished = false;
  const outcome = task.then(value => ({ value }), error => ({ error })); void outcome.then(() => { finished = true; });
  for (let i = 0; i < 20 && !finished; i++) { await new Promise<void>(r => realImmediate(r)); await vi.advanceTimersByTimeAsync(200); }
  const result = await outcome; if ('error' in result) throw result.error; return result.value;
}

async function start(): Promise<void> {
  vi.stubGlobal('defineBackground', (callback: () => () => void) => callback);
  const background = await import('../entrypoints/background');
  cleanup = (background.default as unknown as () => () => void)();
  listener = mocks.browser.runtime.onMessage.addListener.mock.calls[0][0];
  await flush();
}
function run(jobId = 1, sender: unknown = {}): Promise<Record<string, unknown>> {
  return new Promise(resolve => listener({ type: 'NCOS_RUN_PUBLISH_JOB', jobId }, sender, reply => resolve(reply as Record<string, unknown>)));
}

beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks();
  command = {
    job_id: 1, draft_id: 1, draft_version: 2, blog_id: 'sence4u', title: '완성 원고', body: '내용'.repeat(1600), body_chars: 3200,
    title_hash: 'title', body_hash: 'body', tags: ['여행'], assets: [], image_receipts: [],
    attempt_id: 'attempt-2', lease_owner: 'test-extension:worker', resume_stage: 'browser_attach', asset_manifest_hash: 'manifest',
  };
  mocks.loadSettings.mockResolvedValue({ coreUrl: 'http://127.0.0.1:3719', token: 'fixture-token' });
  mocks.browser.tabs.query.mockResolvedValue([{ id: 10, url: 'https://blog.naver.com/sence4u/postwrite', status: 'complete' }]);
  mocks.browser.tabs.get.mockResolvedValue({ id: 10, url: 'https://blog.naver.com/sence4u/postwrite', status: 'complete' });
  mocks.browser.tabs.create.mockResolvedValue({ id: 20 });
  mocks.client.getPublishJob.mockResolvedValue({ status: 'running', stage: 'browser_attach', verification: {} });
  mocks.client.getPublishCommand.mockImplementation(async () => command);
  mocks.client.nextPublishCommand.mockResolvedValue(null);
  mocks.client.publisherHeartbeat.mockResolvedValue({});
  mocks.client.recordPublishEvent.mockImplementation(async (_id, event) => ({ status: event.stage === 'reopen_verify' && event.status === 'passed' ? 'verified_draft_saved' : 'running', error_code: null, detail: '' }));
  mocks.verify.mockResolvedValue({ actual_tags: ['여행'], image_receipts: [], asset_manifest_hash: 'manifest' });
  mocks.execute.mockImplementation(async (_command, report) => { await report('upload_images', 'passed', 'remote confirmed', { image_receipts: [] }); return []; });
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('background command / attempt contract', () => {
  it('selects the initiating app window rather than another window with the same blog', async () => {
    mocks.browser.tabs.query.mockResolvedValue([
      { id: 11, windowId: 100, url: 'https://blog.naver.com/sence4u/postwrite' },
      { id: 10, windowId: 200, url: 'https://blog.naver.com/sence4u/postwrite' },
    ]);
    await start();
    expect(mocks.client.nextPublishCommand).not.toHaveBeenCalled();
    expect((await settle(run(1, { tab: { windowId: 200 } }))).ok).toBe(true);
    expect(mocks.browser.tabs.update).toHaveBeenCalledWith(10, { active: true });
    expect(mocks.browser.tabs.update).not.toHaveBeenCalledWith(11, expect.anything());
    expect(mocks.browser.tabs.create).toHaveBeenCalledWith({ url: 'https://blog.naver.com/sence4u/postwrite', active: true, windowId: 200 });
  });

  it('rejects duplicate editors without a unique window target before any editor input', async () => {
    mocks.browser.tabs.query.mockResolvedValue([
      { id: 10, windowId: 100, url: 'https://blog.naver.com/sence4u/postwrite' },
      { id: 11, windowId: 100, url: 'https://blog.naver.com/sence4u/postwrite' },
    ]);
    await start();
    expect(await settle(run(1, { tab: { windowId: 100 } }))).toMatchObject({ ok: false, error_code: 'editor_tab_ambiguous' });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.browser.tabs.update).not.toHaveBeenCalled();
    expect(mocks.client.nextPublishCommand).not.toHaveBeenCalled();
  });

  it('uses prefetched resume checkpoint despite the job row already being running/browser_attach', async () => {
    command.resume_stage = 'reopen_verify';
    mocks.client.nextPublishCommand.mockResolvedValueOnce(command);
    await start();
    const result = await settle(run());
    expect(result.ok).toBe(true);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.client.getPublishCommand).not.toHaveBeenCalled();
    expect(mocks.browser.tabs.update).not.toHaveBeenCalled();
    expect(mocks.browser.tabs.create).toHaveBeenCalledWith({ url: 'https://blog.naver.com/sence4u/postwrite', active: true });
    expect(mocks.client.recordPublishEvent.mock.calls.map(c => c[1].stage)).toEqual(['reopen_verify', 'reopen_verify']);
    for (const [, event] of mocks.client.recordPublishEvent.mock.calls) expect(event).toMatchObject({ attempt_id: command.attempt_id, lease_owner: command.lease_owner });
  });

  it('binds every normal event to the command attempt and forwards receipts to a fresh validation tab', async () => {
    const receipts = [{ asset_id: 3, sha256: 'hash', remote_url: 'https://blogfiles.pstatic.net/asset.png' }];
    mocks.execute.mockImplementationOnce(async (_command, report) => { await report('upload_images', 'passed', 'remote confirmed', { image_receipts: receipts }); return receipts; });
    await start(); expect((await settle(run())).ok).toBe(true);
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ image_receipts: receipts }));
    expect(mocks.client.recordPublishEvent).toHaveBeenCalledWith(1, expect.objectContaining({ stage: 'upload_images', verification: { image_receipts: receipts } }));
    for (const [, event] of mocks.client.recordPublishEvent.mock.calls) expect(event).toMatchObject({ attempt_id: command.attempt_id, lease_owner: command.lease_owner });
    expect(mocks.browser.tabs.remove).toHaveBeenCalledWith(20);
  });

  it('does not claim save success when reopening fails and records attempt-bound failure', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('저장본 불일치'));
    await start(); expect((await settle(run())).ok).toBe(false);
    expect(mocks.client.recordPublishEvent.mock.calls.some(c => c[1].stage === 'reopen_verify' && c[1].status === 'passed')).toBe(false);
    expect(mocks.client.recordPublishEvent).toHaveBeenLastCalledWith(1, expect.objectContaining({ stage: 'reopen_verify', status: 'failed', attempt_id: command.attempt_id, lease_owner: command.lease_owner }));
  });

  it('blocks legacy commands before touching an editor', async () => {
    delete (command as Partial<PublishCommand>).attempt_id;
    await start(); expect(await settle(run())).toMatchObject({ ok: false, error_code: 'attempt_metadata_missing' });
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.browser.tabs.update).not.toHaveBeenCalled(); expect(mocks.browser.tabs.create).not.toHaveBeenCalled();
    expect(mocks.client.recordPublishEvent).not.toHaveBeenCalled();
  });

  it('rejects legacy runtime events without attempt identity before proxying', async () => {
    await start();
    const result = await new Promise(resolve => listener({ type: 'NCOS_RECORD_PUBLISH_EVENT', jobId: 1, event: { stage: 'health_check', status: 'running' } }, {}, resolve));
    expect(result).toMatchObject({ ok: false, error_code: 'attempt_metadata_missing' });
    expect(mocks.client.recordPublishEvent).not.toHaveBeenCalled();
  });

  it('coalesces duplicate requests for the same job', async () => {
    let release: (() => void) | undefined;
    mocks.execute.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }).then(() => []));
    await start(); const first = run(); const second = run(); for (let i = 0; i < 30 && !release; i++) await flush(); expect(release).toBeDefined(); release!();
    expect((await settle(first)).ok).toBe(true); expect((await settle(second)).ok).toBe(true);
    expect(mocks.execute).toHaveBeenCalledTimes(1); expect(mocks.client.getPublishCommand).toHaveBeenCalledTimes(1);
  });

  it('reports this browser identity and build without exposing its token', async () => {
    await start();
    const result = await new Promise(resolve => listener({ type: 'NCOS_BROWSER_CONNECTION' }, { url: 'http://127.0.0.1:3719/app/write' }, resolve));
    expect(result).toEqual({ ok: true, worker_id: 'test-extension:worker', protocol_version: 3, build_id: 'test-build', debugger_available: true });
    expect(JSON.stringify(result)).not.toContain('fixture-token');
    expect(mocks.client.publisherHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ extension_id: 'test-extension:worker', protocol_version: 3, build_id: 'test-build' }));
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(['https://evil.invalid/app/write', 'http://127.0.0.1:3720/app/write', 'http://127.0.0.1:3719/not-the-app', 'chrome-extension://another-extension/panel.html'])('rejects connection diagnostics from %s', async url => {
    await start();
    const result = await new Promise(resolve => listener({ type: 'NCOS_BROWSER_CONNECTION' }, { url }, resolve));
    expect(result).toMatchObject({ ok: false, worker_id: '' });
  });

  it('keeps web diagnostics available when the optional side panel fails', async () => {
    mocks.browser.sidePanel.setPanelBehavior.mockImplementationOnce(() => { throw new Error('unsupported API'); });
    await start();
    const result = await new Promise(resolve => listener({ type: 'NCOS_BROWSER_CONNECTION' }, { url: 'chrome-extension://test-extension/sidepanel.html' }, resolve));
    expect(result).toMatchObject({ ok: true });
  });
});
