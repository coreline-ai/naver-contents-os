import { BROWSER_BRIDGE_PROTOCOL, MSG_BROWSER_CONNECTION, type BrowserConnection } from '@ncos/contracts';

/** Diagnostic only: server authentication and target-worker checks remain mandatory. */
export function browserConnection(timeoutMs = 2500): Promise<BrowserConnection> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, value?: BrowserConnection) => {
      clearTimeout(timer); window.removeEventListener('message', receive);
      if (error) reject(error); else resolve(value!);
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (data?.source !== 'naver-content-os-extension' || data.type !== MSG_BROWSER_CONNECTION || data.requestId !== requestId) return;
      const reply = data.reply as BrowserConnection | undefined;
      if (!reply?.ok || reply.protocol_version !== BROWSER_BRIDGE_PROTOCOL || typeof reply.worker_id !== 'string' || !reply.worker_id || reply.worker_id.length > 100 || typeof reply.build_id !== 'string' || !reply.build_id || reply.build_id.length > 100 || reply.debugger_available !== true) {
        finish(new Error(reply?.detail || '이 브라우저의 확장을 업데이트하고 Local Core 연결을 확인하세요.'));
      } else finish(undefined, reply);
    };
    const timer = setTimeout(() => finish(new Error('이 브라우저에서 확장 응답이 없습니다. 확장을 설치/새로고침한 뒤 이 페이지도 새로고침하세요.')), timeoutMs);
    window.addEventListener('message', receive);
    window.postMessage({ source: 'naver-content-os-web', type: MSG_BROWSER_CONNECTION, requestId }, window.location.origin);
  });
}
