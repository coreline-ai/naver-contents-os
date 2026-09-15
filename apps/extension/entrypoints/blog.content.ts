import { browser } from 'wxt/browser';
import type { PublishCommandAsset } from '@ncos/contracts';
import type { ExecutePublishJobMessage, PublisherReply, VerifyPublishJobMessage } from '~/lib/messages';
import {
  MSG_EXECUTE_PUBLISH_JOB,
  MSG_FETCH_PUBLISH_ASSET,
  MSG_GET_BLOG,
  MSG_PING_EDITOR,
  MSG_RECORD_PUBLISH_EVENT,
  MSG_VERIFY_PUBLISH_JOB,
} from '~/lib/messages';
import { parseBlogPost } from '~/lib/parsers/blog';
import {
  dismissEditorPopups,
  inputBody,
  inputTags,
  inputTitle,
  saveDraft,
  SmartEditorError,
  uploadImages,
  readEditorVerification,
  validateCommand,
  waitForEditor,
} from '~/lib/smarteditor';

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function recordEvent(
  jobId: number,
  event: {
    stage: string;
    status: 'running' | 'passed' | 'failed';
    detail?: string;
    error_code?: string;
    verification?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const reply = await browser.runtime.sendMessage({ type: MSG_RECORD_PUBLISH_EVENT, jobId, event }) as {
    ok: boolean;
    job?: Record<string, unknown>;
    error_code?: string;
    detail?: string;
  };
  if (!reply?.ok) throw new Error(reply?.detail || reply?.error_code || '게시 상태 기록 실패');
  return reply.job ?? {};
}

async function loadAsset(jobId: number, asset: PublishCommandAsset): Promise<ArrayBuffer> {
  const reply = await browser.runtime.sendMessage({
    type: MSG_FETCH_PUBLISH_ASSET,
    jobId,
    assetId: asset.asset_id,
  }) as { ok: boolean; data_base64?: string; error_code?: string; detail?: string };
  if (!reply?.ok || !reply.data_base64) {
    throw new SmartEditorError(
      'upload_images',
      reply?.error_code || 'asset_download_failed',
      reply?.detail || `이미지 ${asset.position + 1} 다운로드에 실패했습니다.`,
    );
  }
  return base64ToArrayBuffer(reply.data_base64);
}

async function executePublish(message: ExecutePublishJobMessage): Promise<PublisherReply> {
  const { command } = message;
  const report = (
    stage: string,
    status: 'running' | 'passed' | 'failed',
    detail = '',
    error_code?: string,
  ) => recordEvent(command.job_id, { stage, status, detail, error_code });
  const step = async (stage: string, action: () => void | Promise<void>) => {
    await report(stage, 'running');
    await action();
    await report(stage, 'passed');
  };

  try {
    validateCommand(command);
    await step('health_check', () => waitForEditor(document));
    await step('prepare_editor', () => dismissEditorPopups(document));
    await step('input_title', () => inputTitle(document, command.title));
    await step('input_body', () => inputBody(document, command.body));
    await step('upload_images', () => uploadImages(document, command, (asset) => loadAsset(command.job_id, asset)));
    await step('input_tags', () => inputTags(document, command.tags));
    await step('draft_save', () => saveDraft(document));
    return { ok: true, jobId: command.job_id, stage: 'draft_save' };
  } catch (error) {
    const failure = error instanceof SmartEditorError
      ? error
      : new SmartEditorError('prepare_editor', 'extension_runtime_error', error instanceof Error ? error.message : '확장 실행 오류');
    await report(failure.stage, 'failed', failure.message, failure.code).catch(() => undefined);
    return {
      ok: false,
      jobId: command.job_id,
      stage: failure.stage,
      error_code: failure.code,
      detail: failure.message,
    };
  }
}

async function verifyPublish(message: VerifyPublishJobMessage): Promise<PublisherReply> {
  const { command } = message;
  try {
    await recordEvent(command.job_id, { stage: 'reopen_verify', status: 'running' });
    const verification = await readEditorVerification(document, command);
    const job = await recordEvent(command.job_id, {
      stage: 'reopen_verify',
      status: 'passed',
      verification,
    });
    return {
      ok: job.status === 'verified_draft_saved',
      jobId: command.job_id,
      stage: 'reopen_verify',
      error_code: typeof job.error_code === 'string' ? job.error_code : undefined,
      detail: typeof job.detail === 'string' ? job.detail : undefined,
      verification,
    };
  } catch (error) {
    const failure = error instanceof SmartEditorError
      ? error
      : new SmartEditorError('reopen_verify', 'verification_runtime_error', error instanceof Error ? error.message : '재열기 검증 오류');
    await recordEvent(command.job_id, {
      stage: 'reopen_verify',
      status: 'failed',
      error_code: failure.code,
      detail: failure.message,
    }).catch(() => undefined);
    return { ok: false, jobId: command.job_id, stage: failure.stage, error_code: failure.code, detail: failure.message };
  }
}

export default defineContentScript({
  matches: ['*://blog.naver.com/*'],
  allFrames: true, // the post body lives in the mainFrame iframe (docs/05 dual path)
  main() {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === MSG_GET_BLOG) {
        const parsed = parseBlogPost(document);
        if (!parsed.found) return false; // let the frame that has the post answer
        sendResponse({ ...parsed, url: window.location.href });
        return false;
      }
      if (message?.type === MSG_PING_EDITOR) {
        sendResponse({ ok: true, url: window.location.href });
        return false;
      }
      if (message?.type === MSG_EXECUTE_PUBLISH_JOB) {
        void executePublish(message as ExecutePublishJobMessage).then(sendResponse);
        return true;
      }
      if (message?.type === MSG_VERIFY_PUBLISH_JOB) {
        void verifyPublish(message as VerifyPublishJobMessage).then(sendResponse);
        return true;
      }
      return false;
    });
  },
});
