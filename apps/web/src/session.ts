import { CoreError } from '@ncos/core-client';
export type WebSession = { connected: boolean; mode: 'live' };
export async function sessionRequest(method: 'GET' | 'POST' | 'DELETE', code?: string): Promise<WebSession> {
  let response: Response;
  try {
    response = await fetch(`/web/session${method === 'POST' ? '/connect' : ''}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-NCOS-Web': '1' },
      ...(code ? { body: JSON.stringify({ code }) } : {}),
    });
  } catch { throw new CoreError(0, 'unreachable', '앱 서버에 연결할 수 없습니다. 실행기가 켜져 있는지 확인하세요.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new CoreError(response.status, body?.detail?.code ?? 'session', body?.detail?.message ?? '앱 연결 상태를 확인하지 못했습니다.');
  }
  return response.status === 204 ? { connected: false, mode: 'live' } : response.json();
}
