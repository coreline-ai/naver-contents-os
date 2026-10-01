import { browser } from 'wxt/browser';
import type { ExecutePublishJobMessage, PublisherReply, VerifyPublishJobMessage } from '~/lib/messages';
import {
  MSG_EXECUTE_PUBLISH_JOB,
  MSG_GET_BLOG,
  MSG_PING_EDITOR,
  MSG_RUN_PUBLISH_JOB,
  MSG_VERIFY_PUBLISH_JOB,
} from '~/lib/messages';
import { parseBlogPost } from '~/lib/parsers/blog';

// Keep existing message callers, but use only the authoritative current-Chrome
// publisher. Local DOM replacement/readback is not an independent strict-save
// transport: background fetches the server command, binds its attempt identity,
// protects existing text and verifies the saved draft in a separate tab.
async function routePublish(message: ExecutePublishJobMessage | VerifyPublishJobMessage): Promise<PublisherReply> {
  const command = message.command;
  if (!Number.isInteger(command?.job_id) || command.job_id < 1 || !command.attempt_id || !command.lease_owner) {
    return { ok: false, error_code: 'attempt_metadata_missing', detail: '구형 게시 명령은 차단했습니다. 앱과 확장을 업데이트하세요.' };
  }
  try {
    return await browser.runtime.sendMessage({ type: MSG_RUN_PUBLISH_JOB, jobId: command.job_id }) as PublisherReply;
  } catch (error) {
    return { ok: false, jobId: command.job_id, error_code: 'publisher_route_failed', detail: error instanceof Error ? error.message : '안전 게시 실행 연결에 실패했습니다.' };
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
        void routePublish(message as ExecutePublishJobMessage).then(sendResponse);
        return true;
      }
      if (message?.type === MSG_VERIFY_PUBLISH_JOB) {
        void routePublish(message as VerifyPublishJobMessage).then(sendResponse);
        return true;
      }
      return false;
    });
  },
});
