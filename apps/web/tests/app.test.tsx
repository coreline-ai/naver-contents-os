import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../src/App';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); history.replaceState(null, '', '/app/drafts'); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() {
  await act(async () => { root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App/></QueryClientProvider>); await new Promise(r => setTimeout(r, 20)); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
}
it('opens directly to a real saved list without browser/Chrome globals', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/web/session' ? { connected: true, mode: 'live' } : String(url).includes('/work/today') ? { items: [], calculated_at: '2026-09-06T11:00:00Z', limit: 5 } : { items: [{ draft_id: 7, title: '기존 원고 보존', keyword: '여행', latest_version: 3, user_status: 'editing' }], next_cursor: null }))));
  await render();
  expect(host.textContent).toContain('기존 원고 보존');
  expect(host.querySelector('h1')?.textContent).toBe('내 원고');
  expect(host.querySelectorAll('nav[aria-label="주요 작업"] button')).toHaveLength(4);
  expect(host.textContent).not.toContain('토큰을 설정하세요');
});
it('requires pairing before any private Core API call', async () => {
  const fetch = vi.fn(async (_url: string) => new Response('{"connected":false,"mode":"live"}')); vi.stubGlobal('fetch', fetch);
  await render();
  expect(host.querySelector('#pairing-code')).not.toBeNull();
  expect(fetch.mock.calls.every(call => String(call[0]).startsWith('/web/'))).toBe(true);
});
it('routes migrated keyword tools in the same tab and prepares a topic without auto generating', async () => {
  history.replaceState(null, '', '/app/keywords');
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/web/session' ? { connected: true, mode: 'live' } : String(url).includes('/work/today') ? { items: [], limit: 5 } : String(url).includes('/rising/recent') ? { runs: [], read_only: true } : String(url).includes('/llm/status') ? { ready: false, message: 'AI 없음' } : String(url).includes('/capabilities') ? { providers: {} } : { items: [] })));
  vi.stubGlobal('fetch', fetch); await render();
  expect(host.querySelector('h1')?.textContent).toBe('키워드 찾기'); expect(host.textContent).toContain('최신·급상승 키워드 후보'); expect(host.textContent).toContain('공식 실시간 인기 검색어 순위가 아닙니다');
  await act(async () => (host.querySelector('[aria-label="Watchlist 기능으로 이동"]') as HTMLButtonElement).click());
  expect(window.location.pathname).toBe('/app/keywords'); expect(host.querySelector('button[aria-pressed=true]')?.textContent).not.toBeNull();
  expect(fetch.mock.calls.every(call => !String(call[0]).includes('/blogs/compose') && !String(call[0]).includes('/research/specialized'))).toBe(true);
});
it('connects the old ads menu and quick-writer recommendations within the same app',async()=>{
  history.replaceState(null,'','/app/write');
  const fetch=vi.fn(async(url:string)=>new Response(JSON.stringify(url==='/web/session'?{connected:true,mode:'live'}:url.includes('/capabilities')?{providers:{}}:url.includes('/rising/recent')?{runs:[]}:url.includes('/llm/status')?{ready:false}:{items:[]})));vi.stubGlobal('fetch',fetch);await render();
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="광고 성과 기능으로 이동"]')!.click());await act(async()=>{await new Promise(r=>setTimeout(r,30));});
  expect(window.location.pathname).toBe('/app/performance');expect([...host.querySelectorAll('[aria-pressed=true]')].some(b=>b.textContent==='광고 계정 성과')).toBe(true);expect(fetch.mock.calls.some(c=>c[0].includes('/research/ad-performance'))).toBe(false);
  await act(async()=>[...host.querySelectorAll('nav button')].find(b=>b.textContent==='글쓰기')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='키워드 추천 보기')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));await act(async()=>{await new Promise(r=>setTimeout(r,30));});
  expect(window.location.pathname).toBe('/app/keywords');expect(fetch.mock.calls.some(c=>c[0].includes('/blogs/compose'))).toBe(false);
});
it('changes theme in settings while preserving unsaved topic and draft DOM, with no write or generation', async () => {
  localStorage.clear(); history.replaceState(null, '', '/app/write?draft_id=7');
  const detail = { draft_id:7,keyword:'검수 여행',blog_type:'HOWTO',title:'검수 원고',source_snapshot_id:1,user_status:'editing',provider:'fixture',model:'fixture',plan:{},versions:[{version:1,title:'검수 원고',body:'원본 본문',created_at:'2026-09-06T10:00:00Z'}] };
  const fetch = vi.fn(async (url:string) => new Response(JSON.stringify(url==='/web/session'?{connected:true,mode:'live'}:url==='/v1/drafts/7'?detail:url.includes('publish-jobs')?null:url.includes('/llm/status')?{ready:false}:url.includes('/capabilities')?{providers:{}}:{items:[]})));
  vi.stubGlobal('fetch',fetch); await render(); await act(async()=>{await new Promise(r=>setTimeout(r,30));});
  const topic=host.querySelector<HTMLInputElement>('#topic')!,body=host.querySelector<HTMLTextAreaElement>('#draft-body')!;
  expect(body).not.toBeNull();
  await act(async()=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(topic,'미저장 주제');topic.dispatchEvent(new Event('input',{bubbles:true}));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(body,'지켜야 할 미저장 본문');body.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await act(async()=>host.querySelector<HTMLButtonElement>('.settings-link')!.click());
  await act(async()=>{await new Promise(r=>setTimeout(r,30));});
  const calls=fetch.mock.calls.length;
  await act(async()=>host.querySelector<HTMLInputElement>('input[aria-label="다크"]')!.click());
  expect(document.documentElement.dataset.theme).toBe('dark');expect(localStorage.getItem('ncos-web-theme')).toBe('dark');
  expect(fetch.mock.calls.length).toBe(calls);
  await act(async()=>host.querySelector<HTMLButtonElement>('nav button')!.click());
  expect(host.querySelector('#draft-body')).toBe(body);expect(body.value).toBe('지켜야 할 미저장 본문');expect(topic.value).toBe('미저장 주제');
  expect(fetch.mock.calls.some(c=>c[0].includes('/blogs/compose'))).toBe(false);
  localStorage.clear();
});
it('allows appearance selection before pairing without calling private APIs', async()=>{
  localStorage.clear();history.replaceState(null,'','/app/settings');
  const fetch=vi.fn(async()=>new Response('{"connected":false,"mode":"live"}'));vi.stubGlobal('fetch',fetch);await render();
  await act(async()=>host.querySelector<HTMLInputElement>('input[aria-label="다크"]')!.click());
  expect(document.documentElement.dataset.theme).toBe('dark');expect(host.querySelector('#pairing-code')).not.toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);localStorage.clear();
});
it('keeps unsaved performance input when changing appearance and returning to imports', async()=>{
  localStorage.clear();history.replaceState(null,'','/app/performance');
  const fetch=vi.fn(async(url:string)=>new Response(JSON.stringify(url==='/web/session'?{connected:true,mode:'live'}:url.includes('/llm/status')?{ready:false}:url.includes('/capabilities')?{providers:{}}:{items:[]})));
  vi.stubGlobal('fetch',fetch);await render();
  await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='자료 가져오기·채널')!.click());
  const input=host.querySelector<HTMLTextAreaElement>('[aria-label="성과 표 붙여넣기"]')!;
  expect(input).not.toBeNull();
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'제목\t조회수\n검수\t12');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>host.querySelector<HTMLButtonElement>('.settings-link')!.click());await act(async()=>{await new Promise(r=>setTimeout(r,30));});
  const calls=fetch.mock.calls.length;
  await act(async()=>host.querySelector<HTMLInputElement>('[aria-label="다크"]')!.click());expect(fetch.mock.calls.length).toBe(calls);
  await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('nav button')].find(b=>b.textContent==='성과')!.click());
  expect(host.querySelector('[aria-label="성과 표 붙여넣기"]')).toBe(input);expect(input.value).toBe('제목\t조회수\n검수\t12');
  localStorage.clear();
});
