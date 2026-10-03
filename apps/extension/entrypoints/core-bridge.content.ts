import { browser } from 'wxt/browser';
import { MSG_BROWSER_CONNECTION } from '@ncos/contracts';
import { MSG_RUN_PUBLISH_JOB, type PublisherReply } from '~/lib/messages';

const REQUEST_SOURCE = 'naver-content-os-web';
const RESPONSE_SOURCE = 'naver-content-os-extension';

export default defineContentScript({
  matches: ['http://127.0.0.1/*', 'http://localhost/*'],
  main() {
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data as { source?: string; type?: string; jobId?: unknown; requestId?: unknown };
      if (data?.source !== REQUEST_SOURCE) return;
      if (data.type === MSG_BROWSER_CONNECTION) {
        if (typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.requestId)) return;
        void browser.runtime.sendMessage({ type: MSG_BROWSER_CONNECTION }).then(reply => {
          window.postMessage({ source: RESPONSE_SOURCE, type: data.type, requestId: data.requestId, reply }, window.location.origin);
        }).catch(() => {
          window.postMessage({ source: RESPONSE_SOURCE, type: data.type, requestId: data.requestId, reply: { ok: false, detail: '확장 연결을 확인하세요.' } }, window.location.origin);
        });
        return;
      }
      if (data.type !== MSG_RUN_PUBLISH_JOB) return;
      const jobId = Number(data.jobId);
      if (!Number.isInteger(jobId) || jobId < 1) return;
      void browser.runtime.sendMessage({ type: MSG_RUN_PUBLISH_JOB, jobId })
        .then((reply: PublisherReply) => {
          window.postMessage({ source: RESPONSE_SOURCE, type: MSG_RUN_PUBLISH_JOB, jobId, reply }, window.location.origin);
        })
        .catch((error: unknown) => {
          window.postMessage({
            source: RESPONSE_SOURCE,
            type: MSG_RUN_PUBLISH_JOB,
            jobId,
            reply: { ok: false, detail: error instanceof Error ? error.message : '확장 연결 오류' },
          }, window.location.origin);
        });
    });
  },
});
