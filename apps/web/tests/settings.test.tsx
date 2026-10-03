import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import type { CoreClient } from '@ncos/core-client';
import { SettingsPanel } from '../src/SettingsPanel';
import { menuLocations } from '../src/MenuGuide';
vi.mock('../../../packages/workbench/src/browser-connection', () => ({ browserConnection: vi.fn(async () => ({ ok: true, worker_id: 'ego-worker', build_id: 'test-build', protocol_version: 3, debugger_available: true })) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('explains settings, configured versus verified, quota and storage without returning secrets', async () => {
  const host = document.createElement('div'), root = createRoot(host), prefs = vi.fn(), disconnect = vi.fn(); document.body.append(host);
  const client = { publisherReadiness: vi.fn().mockResolvedValue({ current_chrome_extension: { ready: true, extension_id: 'ego-worker', build_id: 'test-build' } }), health: vi.fn().mockResolvedValue({ status: 'ok', config: { arbitrary_internal_name: 'should-not-render' } }), llmStatus: vi.fn().mockResolvedValue({ ready: true, provider: 'codex_cli', model: 'fixture-model', message: '검수 준비' }), capabilities: vi.fn().mockResolvedValue({ providers: { hub_search: { status: 'configured', quota: { monthly: { used: 42, limit: 50000 }, daily: null, blocked: false, warning: false } }, searchad: { status: 'unconfigured', quota: null } } }) };
  try {
    await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SettingsPanel client={client as unknown as CoreClient} preferences={{ blogId: '', tags: '', allowSensitiveUnknown: true }} onPreferences={prefs} onDisconnect={disconnect}/></QueryClientProvider>));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(host.textContent).toContain('메뉴를 추가하거나 숨기는 기능이 아닙니다'); expect(host.textContent).toContain('설정됨 · 실제 권한 미검증'); expect(host.textContent).toContain('42 / 50,000'); expect(host.textContent).not.toContain('should-not-render'); expect(host.textContent).toContain('0회라는 의미가 아닙니다');
    expect(host.textContent).toContain('동일 브라우저 연결 확인 · test-build'); expect(client.publisherReadiness).toHaveBeenCalledWith('ego-worker'); expect(client.capabilities).toHaveBeenCalledOnce(); expect(prefs).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled();
    await act(async () => { const input = host.querySelector('#default-blog-id')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sence4u'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(prefs).toHaveBeenCalledWith(expect.objectContaining({ blogId: 'sence4u' }));
  } finally { await act(async () => root.unmount()); host.remove(); }
});
it('maps every old menu including the connected ads screen', () => {
  for (const label of ['오늘의 작업', '콘텐츠 작업함', '발행 콘텐츠', '근거 브리프', '의도별 키워드 · 키워드 맵', '급상승', 'Watchlist', '특화 분석', '광고 성과']) expect(menuLocations.some(i => i.old === label)).toBe(true);
  const ads = menuLocations.find(i => i.old === '광고 성과')!; expect(ads.destination).toEqual({ area: 'performance', view: 'ads' }); expect(ads.location).toContain('광고 계정 성과');
});
