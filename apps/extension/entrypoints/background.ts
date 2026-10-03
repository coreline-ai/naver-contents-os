import { browser } from 'wxt/browser';
import { BROWSER_BRIDGE_PROTOCOL, MSG_BROWSER_CONNECTION, type BrowserConnection } from '@ncos/contracts';
import { CoreClient } from '~/lib/core';
import {
  MSG_FETCH_PUBLISH_ASSET,
  MSG_RECORD_PUBLISH_EVENT,
  MSG_RUN_PUBLISH_JOB,
  type FetchPublishAssetMessage,
  type PublisherReply,
  type RecordPublishEventMessage,
  type RunPublishJobMessage,
} from '~/lib/messages';
import { loadSettings } from '~/lib/settings';
import { DebuggerEditorError, DebuggerSmartEditor } from '~/lib/debugger-editor';

type PublishCommand = Awaited<ReturnType<CoreClient['getPublishCommand']>>;

const activeJobs = new Map<number, Promise<PublisherReply>>();
const activeEditorTabs = new Set<number>();
let polling = false;
const WORKER_STORAGE_KEY = 'ncos-publisher-worker-id';
let workerIdentity: Promise<string> | undefined;

class ExtensionBridgeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function belongsToBlog(urlValue: string | undefined, blogId: string): boolean {
  if (!urlValue) return false;
  try {
    const url = new URL(urlValue);
    const firstPath = decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] ?? '');
    return url.hostname === 'blog.naver.com'
      && (firstPath.toLocaleLowerCase() === blogId.toLocaleLowerCase()
        || url.searchParams.get('blogId')?.toLocaleLowerCase() === blogId.toLocaleLowerCase());
  } catch {
    return false;
  }
}

async function publisherWorkerId(): Promise<string> {
  workerIdentity ??= createWorkerId().catch(error => { workerIdentity = undefined; throw error; });
  return workerIdentity;
}

async function createWorkerId(): Promise<string> {
  const stored = await browser.storage.local.get(WORKER_STORAGE_KEY);
  const current = String(stored[WORKER_STORAGE_KEY] ?? '').trim();
  if (current) return `${browser.runtime.id}:${current}`.slice(0, 100);
  const created = crypto.randomUUID();
  await browser.storage.local.set({ [WORKER_STORAGE_KEY]: created });
  return `${browser.runtime.id}:${created}`.slice(0, 100);
}

async function availableEditorBlogIds(): Promise<string[]> {
  const tabs = await browser.tabs.query({ url: ['https://blog.naver.com/*'] });
  const values = new Map<string, number>();
  for (const tab of tabs) {
    if (!tab.url) continue;
    try {
      const url = new URL(tab.url);
      const pathBlogId = decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] ?? '');
      const blogId = url.searchParams.get('blogId') || pathBlogId;
      const editor = url.pathname.toLocaleLowerCase().includes('postwrite')
        || url.searchParams.get('Redirect')?.toLocaleLowerCase() === 'write';
      if (editor && /^[A-Za-z0-9_-]+$/.test(blogId)) {
        const key = blogId.toLocaleLowerCase();
        values.set(key, (values.get(key) ?? 0) + 1);
      }
    } catch {
      // Ignore malformed or transient browser URLs.
    }
  }
  // Polling has no originating window. Ambiguous editors require an explicit
  // app request carrying the trusted runtime sender's window instead.
  return [...values].filter(([, count]) => count === 1).map(([blogId]) => blogId);
}

async function heartbeat(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.token) return;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  await new CoreClient(settings.coreUrl, settings.token).publisherHeartbeat({
    extension_id: await publisherWorkerId(),
    version: browser.runtime.getManifest().version,
    protocol_version: BROWSER_BRIDGE_PROTOCOL,
    build_id: browser.runtime.getManifest().version_name ?? '',
    active_url: active?.url ?? '',
  }).catch(() => undefined);
}

async function connectionInfo(senderUrl?: string): Promise<BrowserConnection> {
  const settings = await loadSettings();
  const denied = { ok: false, worker_id: '', protocol_version: BROWSER_BRIDGE_PROTOCOL, build_id: '', debugger_available: false };
  try {
    const sender = new URL(senderUrl ?? '');
    const ownExtension = sender.protocol === 'chrome-extension:' && sender.hostname === browser.runtime.id;
    if (!ownExtension && (sender.origin !== new URL(settings.coreUrl).origin || !sender.pathname.startsWith('/app/'))) return denied;
  } catch { return denied; }
  if (!settings.token) return { ...denied, detail: '확장 설정에서 Local Core 연결을 먼저 완료하세요.' };
  const reply = {
    ok: true, worker_id: await publisherWorkerId(), protocol_version: BROWSER_BRIDGE_PROTOCOL,
    build_id: browser.runtime.getManifest().version_name ?? '',
    debugger_available: typeof browser.debugger?.attach === 'function',
  };
  await heartbeat();
  return reply;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function proxyPublishEvent(message: RecordPublishEventMessage): Promise<unknown> {
  const event = message.event as typeof message.event & { attempt_id?: string; lease_owner?: string };
  if (!event.attempt_id || !event.lease_owner) throw new ExtensionBridgeError('attempt_metadata_missing', '구형 게시 이벤트는 안전하게 차단했습니다. 확장을 새로고침하세요.');
  const settings = await loadSettings();
  if (!settings.token) throw new ExtensionBridgeError('core_token_missing', '확장 설정에서 Local Core 토큰을 저장하세요.');
  return new CoreClient(settings.coreUrl, settings.token).recordPublishEvent(message.jobId, { ...event, attempt_id: event.attempt_id, lease_owner: event.lease_owner });
}

async function proxyPublishAsset(message: FetchPublishAssetMessage): Promise<{
  ok: boolean;
  data_base64?: string;
  error_code?: string;
  detail?: string;
}> {
  const settings = await loadSettings();
  if (!settings.token) {
    return { ok: false, error_code: 'core_token_missing', detail: '확장 설정에서 Local Core 토큰을 저장하세요.' };
  }
  const jobId = Number(message.jobId);
  const assetId = Number(message.assetId);
  if (!Number.isInteger(jobId) || jobId < 1 || !Number.isInteger(assetId) || assetId < 1) {
    return { ok: false, error_code: 'invalid_asset_request', detail: '올바른 이미지 요청이 아닙니다.' };
  }
  try {
    const response = await fetch(`${settings.coreUrl}/v1/publish-jobs/${jobId}/assets/${assetId}`, {
      credentials: 'omit',
      headers: { 'X-Local-Token': settings.token },
    });
    if (!response.ok) {
      return { ok: false, error_code: 'asset_download_failed', detail: `이미지 다운로드 실패 (${response.status})` };
    }
    return { ok: true, data_base64: arrayBufferToBase64(await response.arrayBuffer()) };
  } catch (error) {
    return {
      ok: false,
      error_code: 'asset_download_failed',
      detail: error instanceof Error ? error.message : '이미지 다운로드 실패',
    };
  }
}

async function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('네이버 글쓰기 탭 새로고침이 완료되지 않았습니다.');
}

async function resolveEditorTab(blogId: string, windowId?: number): Promise<number> {
  const expected = `https://blog.naver.com/${encodeURIComponent(blogId)}/postwrite`;
  const tabs = await browser.tabs.query({ url: ['https://blog.naver.com/*'] });
  const matches = tabs.filter((tab) => tab.id && (windowId === undefined || tab.windowId === windowId) && belongsToBlog(tab.url, blogId)
    && (tab.url?.includes('/postwrite') || tab.url?.includes('Redirect=Write')));
  if (matches.length > 1) throw new ExtensionBridgeError('editor_tab_ambiguous', '같은 창에 대상 블로그 편집기가 여러 개 있습니다. 사용할 편집기 하나만 남겨 주세요. 기존 내용은 변경하지 않았습니다.');
  const matching = matches[0];
  // Never navigate an unrelated active blog tab. It may contain another
  // account's unsaved work. Reuse only an exact target editor or open a new tab.
  const tabId = matching?.id ?? (await browser.tabs.create({ url: expected, active: true, ...(windowId === undefined ? {} : { windowId }) })).id;
  if (matching?.id) await browser.tabs.update(matching.id, { active: true });
  if (!tabId) throw new ExtensionBridgeError('current_chrome_tab_missing', '네이버 글쓰기 탭을 열지 못했습니다.');
  try {
    // The current-Chrome publisher writes through chrome.debugger. Requiring
    // a content-script ping here makes a freshly reloaded unpacked extension
    // fail even though the editor tab itself is ready and debuggable.
    await waitForTabComplete(tabId);
  } catch (error) {
    const current = await browser.tabs.get(tabId);
    if (current.url?.includes('nid.naver.com')) {
      throw new ExtensionBridgeError('naver_login_required', '현재 Chrome에서 네이버 로그인이 필요합니다.');
    }
    throw error;
  }
  const resolved = await browser.tabs.get(tabId);
  if (!belongsToBlog(resolved.url, blogId)) {
    throw new ExtensionBridgeError('blog_id_mismatch', `현재 편집기와 요청 블로그 ID(${blogId})가 일치하지 않습니다.`);
  }
  return tabId;
}

async function verifyInSeparateTab(
  command: PublishCommand,
  client: CoreClient,
  windowId?: number,
): Promise<PublisherReply> {
  const validationTab = await browser.tabs.create({
    url: `https://blog.naver.com/${encodeURIComponent(command.blog_id)}/postwrite`,
    active: true,
    ...(windowId === undefined ? {} : { windowId }),
  });
  if (!validationTab.id) throw new ExtensionBridgeError('verification_tab_missing', '임시저장 검증 탭을 열지 못했습니다.');
  await waitForTabComplete(validationTab.id);
  await client.recordPublishEvent(command.job_id, { attempt_id: command.attempt_id, lease_owner: command.lease_owner, stage: 'reopen_verify', status: 'running' });
  const verification = await new DebuggerSmartEditor(validationTab.id).verify(command);
  const job = await client.recordPublishEvent(command.job_id, {
    attempt_id: command.attempt_id, lease_owner: command.lease_owner,
    stage: 'reopen_verify',
    status: 'passed',
    verification,
  });
  const ok = job.status === 'verified_draft_saved';
  if (ok) await browser.tabs.remove(validationTab.id);
  return {
    ok,
    jobId: command.job_id,
    stage: 'reopen_verify',
    error_code: job.error_code ?? undefined,
    detail: job.detail,
    verification,
  };
}

async function executeJob(jobId: number, prefetchedCommand?: PublishCommand, windowId?: number): Promise<PublisherReply> {
  const settings = await loadSettings();
  if (!settings.token) {
    return { ok: false, jobId, stage: 'browser_attach', error_code: 'core_token_missing', detail: '확장 설정에서 Local Core 토큰을 저장하세요.' };
  }
  const client = new CoreClient(settings.coreUrl, settings.token);
  let command: PublishCommand | undefined;
  let claimedTabId: number | undefined;
  let currentStage = 'browser_attach';
  try {
    await heartbeat();
    const current = await client.getPublishJob(jobId);
    if (current.status === 'verified_draft_saved') {
      return { ok: true, jobId, stage: 'reopen_verify', detail: '이미 검증된 임시저장 작업입니다.', verification: current.verification };
    }
    command = prefetchedCommand ?? await client.getPublishCommand(jobId, await publisherWorkerId());
    if (!command.attempt_id || !command.lease_owner || !command.asset_manifest_hash
      || !['browser_attach', 'upload_images', 'input_tags', 'reopen_verify'].includes(command.resume_stage)) {
      throw new ExtensionBridgeError('attempt_metadata_missing', '안전 실행 계약이 없는 게시 명령은 중단했습니다. 앱과 확장을 업데이트하세요.');
    }
    const boundCommand = command;
    if (command.job_id !== jobId) throw new ExtensionBridgeError('job_id_mismatch', '게시 명령의 작업 ID가 일치하지 않습니다.');
    if (command.resume_stage === 'reopen_verify') { currentStage = 'reopen_verify'; return await verifyInSeparateTab(command, client, windowId); }
    const tabId = await resolveEditorTab(command.blog_id, windowId);
    if (activeEditorTabs.has(tabId)) throw new ExtensionBridgeError('editor_tab_busy', '이 편집기에서 다른 작업이 실행 중입니다.');
    activeEditorTabs.add(tabId); claimedTabId = tabId;
    await client.recordPublishEvent(jobId, {
      attempt_id: command.attempt_id, lease_owner: command.lease_owner,
      stage: 'browser_attach',
      status: 'passed',
      detail: `current Chrome tab ${tabId} connected`,
    });
    const receipts = await new DebuggerSmartEditor(tabId).execute(
      boundCommand,
      (stage, status, detail = '', verification) => {
        currentStage = stage;
        return client.recordPublishEvent(jobId, {
          attempt_id: boundCommand.attempt_id, lease_owner: boundCommand.lease_owner, stage, status, detail, verification,
        });
      },
      async (asset) => {
        const response = await fetch(`${settings.coreUrl}/v1/publish-jobs/${jobId}/assets/${asset.asset_id}`, {
          credentials: 'omit', headers: { 'X-Local-Token': settings.token },
        });
        if (!response.ok) throw new DebuggerEditorError('upload_images', 'asset_download_failed', `이미지 다운로드 실패 (${response.status})`);
        return response.arrayBuffer();
      },
    );
    command = { ...boundCommand, image_receipts: receipts };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    currentStage = 'reopen_verify';
    return await verifyInSeparateTab(command, client, windowId ?? (await browser.tabs.get(tabId)).windowId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '현재 크롬 게시 브리지 실행 오류';
    const errorCode = error instanceof ExtensionBridgeError || error instanceof DebuggerEditorError
      ? error.code
      : 'extension_bridge_failed';
    const stage = error instanceof DebuggerEditorError ? error.stage : currentStage;
    if (command?.attempt_id && command.lease_owner) await client.recordPublishEvent(jobId, {
      attempt_id: command.attempt_id, lease_owner: command.lease_owner,
      stage,
      status: 'failed',
      error_code: errorCode,
      detail,
    }).catch(() => undefined);
    return { ok: false, jobId, stage, error_code: errorCode, detail };
  } finally {
    if (claimedTabId !== undefined) activeEditorTabs.delete(claimedTabId);
  }
}

function runOnce(jobId: number, prefetchedCommand?: PublishCommand, windowId?: number): Promise<PublisherReply> {
  const running = activeJobs.get(jobId);
  if (running) return running;
  const task = executeJob(jobId, prefetchedCommand, windowId).finally(() => activeJobs.delete(jobId));
  activeJobs.set(jobId, task);
  return task;
}

async function pollWaitingJob(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const settings = await loadSettings();
    if (!settings.token) return;
    const blogIds = await availableEditorBlogIds();
    if (!blogIds.length) return;
    const workerId = await publisherWorkerId();
    const command = await new CoreClient(settings.coreUrl, settings.token)
      .nextPublishCommand(workerId, blogIds)
      .catch(() => null);
    if (command) void runOnce(command.job_id, command);
  } finally {
    polling = false;
  }
}

export default defineBackground(() => {
  // Some Chromium browsers lack the optional panel API. Keep the web bridge alive.
  try { void browser.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch(() => undefined); } catch { /* optional surface */ }
  void heartbeat();
  void pollWaitingJob();
  const heartbeatTimer = setInterval(() => void heartbeat(), 10_000);
  const pollTimer = setInterval(() => void pollWaitingJob(), 3_000);

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MSG_BROWSER_CONNECTION) {
      void connectionInfo(_sender.url).then(sendResponse).catch(() => sendResponse({ ok: false, detail: '확장 연결을 확인하지 못했습니다.' }));
      return true;
    }
    if (message?.type === MSG_RECORD_PUBLISH_EVENT) {
      void proxyPublishEvent(message as RecordPublishEventMessage)
        .then((job) => sendResponse({ ok: true, job }))
        .catch((error) => sendResponse({
          ok: false,
          error_code: error instanceof ExtensionBridgeError ? error.code : 'event_proxy_failed',
          detail: error instanceof Error ? error.message : '게시 상태 기록 실패',
        }));
      return true;
    }
    if (message?.type === MSG_FETCH_PUBLISH_ASSET) {
      void proxyPublishAsset(message as FetchPublishAssetMessage).then(sendResponse);
      return true;
    }
    if (message?.type === MSG_RUN_PUBLISH_JOB) {
      const jobId = Number((message as RunPublishJobMessage).jobId);
      if (!Number.isInteger(jobId) || jobId < 1) {
        sendResponse({ ok: false, error_code: 'invalid_job_id', detail: '올바른 작업 ID가 아닙니다.' });
        return false;
      }
      // Never trust a window id supplied by page message data.
      const windowId = _sender.tab?.windowId;
      void runOnce(jobId, undefined, Number.isInteger(windowId) && windowId! >= 0 ? windowId : undefined).then(sendResponse);
      return true;
    }
    return false;
  });

  return () => { clearInterval(heartbeatTimer); clearInterval(pollTimer); };
});
