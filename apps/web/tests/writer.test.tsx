import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Writer, type ImprovementInput } from '@ncos/workbench';
import { CoreClient, CoreError } from '@ncos/core-client';
import type { DraftDetail } from '@ncos/contracts';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const detail: DraftDetail = { draft_id: 7, keyword: '후쿠오카 여행', blog_type: 'HOWTO', title: '후쿠오카 여행 안내', source_snapshot_id: 1, user_status: 'editing', fact_pack_id: null, fact_pack_version: null, created_at: '2026-09-06T10:00:00Z', provider: 'test', model: 'fixture', prompt_version: 'fixture', plan: { order: 1, title: '여행 안내', blog_type: 'HOWTO', target_keyword: '후쿠오카 여행', angle: '', reason: '', generation_status: 'ready', series_prev: null, series_next: null }, versions: [{ version: 1, title: '후쿠오카 여행 안내', body: '검수용 본문입니다. 실제 여행 정보가 아닙니다.', note: '', created_at: '2026-09-06T10:00:00Z' }] };
const composeResult = { draft: { draft_id: 7 }, quality: { score: 94, char_count: 2500, issues: [] }, suggested_tags: ['여행'] };
const preferences = { blogId: '', tags: '', allowSensitiveUnknown: true };
let root: Root, host: HTMLDivElement, query: QueryClient;
let client: { llmStatus: ReturnType<typeof vi.fn>; composeBlog: ReturnType<typeof vi.fn>; getDraft: ReturnType<typeof vi.fn>; addDraftVersion: ReturnType<typeof vi.fn>; specialized: ReturnType<typeof vi.fn>; updatePerformanceRecommendation: ReturnType<typeof vi.fn>; getPublishJob: ReturnType<typeof vi.fn>; latestPublishJob: ReturnType<typeof vi.fn>; startPublishJob: ReturnType<typeof vi.fn> };
let onSaved: ReturnType<typeof vi.fn>, onDirty: ReturnType<typeof vi.fn>;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); onSaved = vi.fn(); onDirty = vi.fn(); client = { llmStatus: vi.fn().mockResolvedValue({ ready: true, engine: 'test', model: 'fixture' }), composeBlog: vi.fn().mockResolvedValue(composeResult), getDraft: vi.fn().mockResolvedValue(detail), addDraftVersion: vi.fn().mockResolvedValue({ draft_id: 7, version: 2 }), specialized: vi.fn(), updatePerformanceRecommendation: vi.fn().mockResolvedValue({ status: 'done' }), getPublishJob: vi.fn(), latestPublishJob: vi.fn().mockResolvedValue(null), startPublishJob: vi.fn() }; });
afterEach(async () => { await act(async () => root.unmount()); query.clear(); host.remove(); vi.restoreAllMocks(); });
async function settle() { await act(async () => { await new Promise(r => setTimeout(r, 15)); }); }
async function render(id?: number, improvementRequest?: { input: ImprovementInput; nonce: number }) { await act(async () => { root.render(<QueryClientProvider client={query}><Writer client={client as unknown as CoreClient} improvementRequest={improvementRequest} openRequest={id ? { id, nonce: id } : null} onSaved={onSaved} onDirtyChange={onDirty} preferences={preferences} onPreferences={() => {}}/></QueryClientProvider>); }); await settle(); }
async function input(selector: string, value: string) { await act(async () => { const element = host.querySelector(selector) as HTMLInputElement; const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }); }
function button(text: string) { return [...host.querySelectorAll('button')].find(b => b.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); await settle(); }
it('creates through the real client contract with all quick-writing options', async () => {
  await render(); await input('#topic', '후쿠오카 여행'); await input('#notes', '직접 확인한 내용');
  await act(async () => { const select = host.querySelector('#length') as HTMLSelectElement; select.value = '4000'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('완성 글 만들기');
  expect(client.composeBlog).toHaveBeenCalledWith({ keyword: '후쿠오카 여행', user_notes: '직접 확인한 내용', style: 'auto', target_chars: 4000, allow_sensitive_unknown: true });
  expect((host.querySelector('#draft-body') as HTMLTextAreaElement).value).toBe(detail.versions[0].body);
  expect(host.textContent).toContain('사실성·상위 노출을 보증하지 않습니다');
  expect(onSaved).toHaveBeenCalledWith(7, true);
});
it('saves the edited text with its expected version and preserves original history', async () => {
  await render(7); await input('#draft-body', '사용자가 수정한 본문');
  const updated = { ...detail, versions: [...detail.versions, { ...detail.versions[0], version: 2, body: '사용자가 수정한 본문' }] };
  client.getDraft.mockResolvedValue(updated);
  await click('수정 내용 저장');
  expect(client.addDraftVersion).toHaveBeenCalledWith(7, expect.objectContaining({ body: '사용자가 수정한 본문', expected_version: 1 }));
  expect(host.textContent).toContain('버전 이력 · 2개');
  expect(host.textContent).toContain('로컬 저장됨');
});
it('keeps unsaved text after a conflict and never retries the write automatically', async () => {
  await render(7); await input('#draft-body', '잃으면 안 되는 편집 내용');
  client.addDraftVersion.mockRejectedValue(new CoreError(409, 'draft_version_conflict', '다른 화면에서 새 버전을 저장했습니다.'));
  await click('수정 내용 저장');
  expect((host.querySelector('#draft-body') as HTMLTextAreaElement).value).toBe('잃으면 안 되는 편집 내용');
  expect(host.textContent).toContain('최신 원고와 비교');
  expect(client.addDraftVersion).toHaveBeenCalledTimes(1);
  expect(onDirty).toHaveBeenLastCalledWith(true);
});
it('cannot replace another selected draft with a late compose response', async () => {
  let resolve!: (value: unknown) => void;
  client.composeBlog.mockImplementation(() => new Promise(r => { resolve = r; }));
  await render(); await input('#topic', '이전 주제'); await click('완성 글 만들기');
  client.getDraft.mockResolvedValue({ ...detail, draft_id: 9, title: '다른 원고', versions: [{ ...detail.versions[0], title: '다른 원고' }] });
  await render(9);
  await act(async () => resolve(composeResult)); await settle();
  expect((host.querySelector('#draft-title') as HTMLInputElement).value).toBe('다른 원고');
  expect(onSaved).toHaveBeenCalledWith(7, false);
});
it('shows uncertain read-after-save separately and can reopen without regeneration', async () => {
  await render(); await input('#topic', '후쿠오카 여행'); client.getDraft.mockRejectedValue(new CoreError(0, 'unreachable', '연결 실패'));
  await click('완성 글 만들기');
  expect(host.textContent).toContain('생성·저장 응답은 받았지만');
  client.getDraft.mockResolvedValue(detail); await click('저장된 원고 다시 열기');
  expect(client.composeBlog).toHaveBeenCalledTimes(1);
  expect(host.querySelector('#draft-body')).not.toBeNull();
});
it('does not query reference images or publish just by opening a draft', async () => {
  await render(7);
  expect(client.specialized).not.toHaveBeenCalled(); expect(client.startPublishJob).not.toHaveBeenCalled();
});
it('blocks duplicate generation and reports elapsed time without fake percentages', async () => {
  client.composeBlog.mockReturnValue(new Promise(() => {}));
  await render(); await input('#topic', '후쿠오카 여행');
  await act(async () => { button('완성 글 만들기').click(); host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(client.composeBlog).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('정확한 진행률을 알 수 없습니다');
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
});
it('blocks generation when the configured AI is not ready', async () => {
  client.llmStatus.mockResolvedValue({ ready: false, message: 'AI 로그인 필요', action: '설정 확인' });
  await render(); await input('#topic', '후쿠오카 여행');
  expect(button('완성 글 만들기').disabled).toBe(true);
  expect(client.composeBlog).not.toHaveBeenCalled();
});

const improvement: ImprovementInput = { keyword: '후쿠오카 여행', notes: '성과 기반 최신화 요청', recommendationId: 51, sourceDraftId: 3, sourceDraftMode: 'revision', label: '본문 최신화' };
it.each(['revision', 'followup'] as const)('preserves %s source lineage and only completes the originating recommendation after save', async sourceDraftMode => {
  const context = { ...improvement, sourceDraftMode, keyword: sourceDraftMode === 'followup' ? '후쿠오카 교통패스' : improvement.keyword };
  await render(undefined, { input: context, nonce: 1 });
  expect(client.composeBlog).not.toHaveBeenCalled(); expect(client.updatePerformanceRecommendation).not.toHaveBeenCalled();
  await click('완성 글 만들기');
  expect(client.composeBlog).toHaveBeenCalledWith(expect.objectContaining({ keyword: context.keyword, source_draft_id: 3, source_draft_mode: sourceDraftMode }));
  expect(client.updatePerformanceRecommendation).toHaveBeenCalledWith(51, 'done');
});
it('clears recommendation/source and generated notes on manual topic change, even if typed back', async () => {
  await render(undefined, { input: improvement, nonce: 1 }); await input('#topic', '다른 주제'); await input('#topic', improvement.keyword);
  await click('완성 글 만들기');
  expect(client.composeBlog.mock.calls[0][0]).not.toHaveProperty('source_draft_id');
  expect(client.composeBlog.mock.calls[0][0].user_notes).toBe('');
  expect(client.updatePerformanceRecommendation).not.toHaveBeenCalled();
});
it('late improvement result marks only its own recommendation, not the newly selected one', async () => {
  let resolve!: (value: unknown) => void;
  client.composeBlog.mockImplementation(() => new Promise(r => { resolve = r; }));
  await render(undefined, { input: improvement, nonce: 1 }); await click('완성 글 만들기');
  await render(undefined, { input: { ...improvement, keyword: '다른 추천 주제', recommendationId: 99 }, nonce: 2 });
  await act(async () => resolve(composeResult)); await settle();
  expect(client.updatePerformanceRecommendation).toHaveBeenCalledWith(51, 'done');
  expect(client.updatePerformanceRecommendation).not.toHaveBeenCalledWith(99, 'done');
  expect((host.querySelector('#topic') as HTMLInputElement).value).toBe('다른 추천 주제');
  expect(onSaved).toHaveBeenCalledWith(7, false);
});
it('can retry a failed completion marker without generating another article', async () => {
  client.updatePerformanceRecommendation.mockRejectedValueOnce(new Error('네트워크 끊김'));
  await render(undefined, { input: improvement, nonce: 1 }); await click('완성 글 만들기');
  expect(host.textContent).toContain('원고 #7은 저장됐지만 추천 #51 완료 표시');
  await click('추천 완료 표시만 다시 시도');
  expect(client.composeBlog).toHaveBeenCalledTimes(1); expect(client.updatePerformanceRecommendation).toHaveBeenCalledTimes(2);
});
it.each(['할당량 초과', '시간 초과', '품질 기준 미달'])('does not mark recommendations done or open a draft after compose failure: %s', async error => {
  client.composeBlog.mockRejectedValue(new Error(error));
  await render(undefined, { input: improvement, nonce: 1 }); await click('완성 글 만들기');
  expect(client.getDraft).not.toHaveBeenCalled(); expect(client.updatePerformanceRecommendation).not.toHaveBeenCalled(); expect(host.textContent).toContain(error);
});
it('recovers the previous active publisher job on reopening and blocks a duplicate start', async () => {
  const job = { job_id: 21, draft_id: 7, status: 'pending', stage: 'waiting', detail: '', history: [] };
  client.latestPublishJob.mockResolvedValue(job); client.getPublishJob.mockResolvedValue(job);
  await render(7); await settle(); await input('#blog-id', 'test_blog');
  expect(host.textContent).toContain('작업 #21'); expect(button('네이버에 임시저장').disabled).toBe(true);
  expect(client.startPublishJob).not.toHaveBeenCalled();
});
it('lost publisher response locks retry; recovering the new job never sends another POST', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  client.startPublishJob.mockRejectedValue(new Error('응답 연결 끊김'));
  await render(7); await input('#blog-id', 'test_blog'); await click('네이버에 임시저장');
  expect(button('네이버에 임시저장').disabled).toBe(true);
  await click('기존 임시저장 작업 다시 확인'); expect(button('네이버에 임시저장').disabled).toBe(true);
  const job = { job_id: 22, draft_id: 7, status: 'draft_saved', stage: 'saved', detail: '', history: [] };
  client.latestPublishJob.mockResolvedValue(job); client.getPublishJob.mockResolvedValue(job);
  await click('기존 임시저장 작업 다시 확인'); await settle();
  expect(host.textContent).toContain('네이버 임시저장 확인됨'); expect(client.startPublishJob).toHaveBeenCalledTimes(1);
});
it('definitive publisher version conflict offers latest comparison rather than an uncertainty deadlock', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  client.startPublishJob.mockRejectedValue(new CoreError(409, 'draft_version_conflict', '원고 버전 충돌'));
  await render(7); await input('#blog-id', 'test_blog'); await click('네이버에 임시저장');
  expect(host.textContent).toContain('요청이 거부되었습니다'); expect(host.textContent).toContain('서버 최신 v1');
  expect(host.textContent).not.toContain('응답이 끊긴 요청의 생성 여부는');
});
it('rejects another drafts latest job instead of showing or using it', async () => {
  client.latestPublishJob.mockResolvedValue({ job_id: 30, draft_id: 999, status: 'draft_saved' });
  await render(7); await input('#blog-id', 'test_blog');
  expect(host.textContent).toContain('다른 원고의 최근 작업 응답'); expect(button('네이버에 임시저장').disabled).toBe(true);
  expect(client.startPublishJob).not.toHaveBeenCalled();
});
