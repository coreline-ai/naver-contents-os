import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Writer, DraftEditor, type ImprovementInput } from '@ncos/workbench';
import { CoreClient, CoreError } from '@ncos/core-client';
import type { DraftDetail } from '@ncos/contracts';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const detail: DraftDetail = { draft_id: 7, keyword: '후쿠오카 여행', blog_type: 'HOWTO', title: '후쿠오카 여행 안내', source_snapshot_id: 1, user_status: 'editing', fact_pack_id: null, fact_pack_version: null, created_at: '2026-09-06T10:00:00Z', provider: 'test', model: 'fixture', prompt_version: 'fixture', plan: { order: 1, title: '여행 안내', blog_type: 'HOWTO', target_keyword: '후쿠오카 여행', angle: '', reason: '', generation_status: 'ready', series_prev: null, series_next: null }, versions: [{ version: 1, title: '후쿠오카 여행 안내', body: '검수용 본문입니다. 실제 여행 정보가 아닙니다. '.repeat(150), note: '', created_at: '2026-09-06T10:00:00Z' }] };
const composeResult = { draft: { draft_id: 7 }, quality: { score: 94, char_count: 2500, issues: [] }, suggested_tags: ['여행'] };
let preferences = { blogId: '', tags: '', allowSensitiveUnknown: true };
let root: Root, host: HTMLDivElement, query: QueryClient;
let client: { llmStatus: ReturnType<typeof vi.fn>; composeBlog: ReturnType<typeof vi.fn>; getDraft: ReturnType<typeof vi.fn>; addDraftVersion: ReturnType<typeof vi.fn>; specialized: ReturnType<typeof vi.fn>; updatePerformanceRecommendation: ReturnType<typeof vi.fn>; getPublishJob: ReturnType<typeof vi.fn>; latestPublishJob: ReturnType<typeof vi.fn>; startPublishJob: ReturnType<typeof vi.fn>; listDraftAssets: ReturnType<typeof vi.fn>; publisherReadiness: ReturnType<typeof vi.fn>; addDraftAsset: ReturnType<typeof vi.fn>; generateDraftGuideAssets: ReturnType<typeof vi.fn>; deleteDraftAsset: ReturnType<typeof vi.fn> };
let onSaved: ReturnType<typeof vi.fn>, onDirty: ReturnType<typeof vi.fn>;
beforeEach(() => { preferences = { blogId: '', tags: '', allowSensitiveUnknown: true }; });
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); onSaved = vi.fn(); onDirty = vi.fn(); const assets = [0, 1, 2].map(position => ({ asset_id: position + 1, draft_id: 7, draft_version: 1, filename: `image-${position}.png`, mime_type: 'image/png', byte_size: 100, sha256: `hash-${position}`, position, anchor_after: position + 1, rights_status: 'approved', created_at: null })); client = { llmStatus: vi.fn().mockResolvedValue({ ready: true, engine: 'test', model: 'fixture' }), composeBlog: vi.fn().mockResolvedValue(composeResult), getDraft: vi.fn().mockResolvedValue(detail), addDraftVersion: vi.fn().mockResolvedValue({ draft_id: 7, version: 2 }), specialized: vi.fn(), updatePerformanceRecommendation: vi.fn().mockResolvedValue({ status: 'done' }), getPublishJob: vi.fn(), latestPublishJob: vi.fn().mockResolvedValue(null), startPublishJob: vi.fn(), listDraftAssets: vi.fn().mockResolvedValue(assets), publisherReadiness: vi.fn().mockResolvedValue({ current_chrome_extension: { ready: true }, dedicated_chrome_cdp: { ready: false, url: '' } }), addDraftAsset: vi.fn(), generateDraftGuideAssets: vi.fn().mockResolvedValue(assets), deleteDraftAsset: vi.fn() }; });
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
it('uses tags suggested for the new draft instead of stale tags from the previous publish', async () => {
  preferences = { ...preferences, tags: '책상정리,오래된태그' };
  await render(); await input('#topic', '후쿠오카 여행'); await click('완성 글 만들기');
  expect((host.querySelector('#publish-tags') as HTMLInputElement).value).toBe('여행');
});
it('can create three original guide images through the app', async () => {
  const generated = [0, 1, 2].map(position => ({ asset_id: position + 11, draft_id: 7, draft_version: 1, filename: `app-guide-${position + 1}.png`, mime_type: 'image/png', byte_size: 1400, sha256: `generated-${position}`, position, anchor_after: (position + 1) * 3, rights_status: 'approved', created_at: null }));
  client.listDraftAssets.mockResolvedValueOnce([]).mockResolvedValue(generated);
  await render(7);
  await click('앱이 안내 이미지 3장 만들기');
  expect(client.generateDraftGuideAssets).toHaveBeenCalledWith(7, 1);
  expect(host.textContent).toContain('본문 이미지 · 3/3');
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
  expect(host.textContent).toContain('구형 저장 응답 수신 · 재열기 미검증'); expect(client.startPublishJob).toHaveBeenCalledTimes(1);
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


function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const activeJob = { job_id: 21, draft_id: 7, status: 'running', stage: 'upload_images', detail: '', history: [] };
function editable() { return ['#draft-title', '#draft-body', '#version-note', '#blog-id', '#publish-tags'].map(selector => host.querySelector(selector) as HTMLInputElement); }
function checkMutationLock() {
  expect(editable().every(element => element.disabled)).toBe(true);
  expect((host.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(true);
  expect([...host.querySelectorAll('button')].filter(element => element.textContent === '삭제').every(element => element.disabled)).toBe(true);
  expect(button('수정 내용 저장').disabled).toBe(true);
  expect((button('네이버에 임시저장') || button('작업 요청 중…')).disabled).toBe(true);
}
it('defaults to 3500 characters and explains the 3000-character verified-save minimum', async () => {
  await render(); expect((host.querySelector('#length') as HTMLSelectElement).value).toBe('3500');
  expect(host.textContent).toContain('실제 본문 3,000자 이상');
  expect(host.querySelector('option[value="2500"]')?.textContent).toContain('짧은 로컬 원고');
  await input('#topic', '검수 주제'); await click('완성 글 만들기');
  expect(client.composeBlog).toHaveBeenCalledWith(expect.objectContaining({ target_chars: 3500 }));
});
it.each([2999, 3000])('uses the actual %i-character body for the save boundary, not the target length', async chars => {
  client.getDraft.mockResolvedValue({ ...detail, versions: [{ ...detail.versions[0], body: '가'.repeat(chars) }] });
  await render(7); await input('#blog-id', 'test_blog');
  expect(button('네이버에 임시저장').disabled).toBe(chars < 3000);
  if (chars < 3000) expect(host.textContent).toContain('본문이 1자 더 필요합니다');
});
it.each(['pending', 'running', 'waiting_extension'])('locks all editing and asset mutations for an existing %s job', async status => {
  client.latestPublishJob.mockResolvedValue({ ...activeJob, status }); client.getPublishJob.mockResolvedValue({ ...activeJob, status });
  await render(7); await settle(); checkMutationLock();
  await click('삭제');
  expect(client.deleteDraftAsset).not.toHaveBeenCalled(); expect(client.startPublishJob).not.toHaveBeenCalled();
  expect(host.textContent).toContain('원고와 이미지를 변경할 수 없습니다');
});
it('locks mutations during previous-job lookup and its refetch, including a same-tick publish click', async () => {
  const lookup = deferred<null>(); client.latestPublishJob.mockReturnValueOnce(lookup.promise);
  preferences.blogId = 'test_blog'; await render(7); checkMutationLock();
  await act(async () => lookup.resolve(null)); await settle();
  expect((host.querySelector('#draft-title') as HTMLInputElement).disabled).toBe(false);
  const refresh = deferred<null>(); client.latestPublishJob.mockReturnValueOnce(refresh.promise);
  await act(async () => { button('기존 임시저장 작업 다시 확인').click(); button('네이버에 임시저장').click(); });
  await settle(); checkMutationLock(); expect(client.startPublishJob).not.toHaveBeenCalled();
  await act(async () => refresh.resolve(null)); await settle();
  expect((host.querySelector('#draft-title') as HTMLInputElement).disabled).toBe(false);
});
it('keeps editing and assets locked when the previous-job lookup fails', async () => {
  client.latestPublishJob.mockRejectedValue(new Error('최근 작업 연결 끊김'));
  await render(7); checkMutationLock(); expect(host.textContent).toContain('최근 작업 연결 끊김');
});
it('locks mutations while publishing is requested and until the active job becomes terminal', async () => {
  preferences.blogId = 'test_blog'; vi.spyOn(window, 'confirm').mockReturnValue(true);
  const requested = deferred<unknown>(); client.startPublishJob.mockReturnValue(requested.promise); client.getPublishJob.mockResolvedValue(activeJob);
  await render(7);
  await act(async () => { button('네이버에 임시저장').click(); button('삭제').click(); button('네이버에 임시저장').click(); });
  checkMutationLock(); expect(client.startPublishJob).toHaveBeenCalledTimes(1); expect(client.deleteDraftAsset).not.toHaveBeenCalled();
  await act(async () => requested.resolve(activeJob)); await settle(); checkMutationLock();
  await act(async () => query.setQueryData(['workbench-publish', 21], { ...activeJob, status: 'verified_draft_saved', stage: 'reopen_verify' })); await settle();
  expect((host.querySelector('#draft-title') as HTMLInputElement).disabled).toBe(false);
  expect(host.textContent).toContain('재열기 검증까지 완료');
});
it('locks guide generation in an active job even when there are fewer than three assets', async () => {
  client.listDraftAssets.mockResolvedValue([]); client.latestPublishJob.mockResolvedValue(activeJob); client.getPublishJob.mockResolvedValue(activeJob);
  await render(7); await settle(); expect(button('앱이 안내 이미지 3장 만들기').disabled).toBe(true);
  await click('앱이 안내 이미지 3장 만들기'); expect(client.generateDraftGuideAssets).not.toHaveBeenCalled();
});
it('blocks a publisher POST in the same tick that deletion starts', async () => {
  preferences.blogId = 'test_blog'; vi.spyOn(window, 'confirm').mockReturnValue(true);
  const deletion = deferred<void>(); client.deleteDraftAsset.mockReturnValue(deletion.promise);
  await render(7);
  await act(async () => { button('삭제').click(); button('네이버에 임시저장').click(); button('삭제').click(); });
  expect(client.deleteDraftAsset).toHaveBeenCalledTimes(1); expect(client.startPublishJob).not.toHaveBeenCalled(); checkMutationLock();
  await act(async () => deletion.resolve()); await settle();
  expect((host.querySelector('#draft-title') as HTMLInputElement).disabled).toBe(false);
});
it('blocks saving an edited version while an asset mutation is in flight', async () => {
  await render(7); await input('#draft-body', detail.versions[0].body + '수정');
  const deletion = deferred<void>(); client.deleteDraftAsset.mockReturnValue(deletion.promise);
  await act(async () => { button('삭제').click(); button('수정 내용 저장').click(); });
  expect(client.deleteDraftAsset).toHaveBeenCalledOnce(); expect(client.addDraftVersion).not.toHaveBeenCalled();
  await act(async () => deletion.resolve()); await settle();
});
it('blocks deleting assets in the same tick that a version save starts', async () => {
  await render(7); await input('#draft-body', detail.versions[0].body + '수정');
  const saving = deferred<unknown>(); client.addDraftVersion.mockReturnValue(saving.promise);
  await act(async () => { button('수정 내용 저장').click(); button('삭제').click(); });
  expect(client.addDraftVersion).toHaveBeenCalledOnce(); expect(client.deleteDraftAsset).not.toHaveBeenCalled();
  await act(async () => saving.resolve({ draft_id: 7, version: 2 })); await settle();
});
it('blocks a second guide generation and edits synchronously until the asset refresh finishes', async () => {
  client.listDraftAssets.mockResolvedValue([]); const generated = deferred<unknown>(); client.generateDraftGuideAssets.mockReturnValue(generated.promise);
  await render(7); const original = detail.versions[0].title;
  await act(async () => { button('앱이 안내 이미지 3장 만들기').click(); button('앱이 안내 이미지 3장 만들기').click(); });
  checkMutationLock(); expect(client.generateDraftGuideAssets).toHaveBeenCalledTimes(1);
  await input('#draft-title', '처리 중 바꿀 제목');
  expect((host.querySelector('#draft-title') as HTMLInputElement).value).toBe(original);
  await act(async () => generated.resolve([])); await settle();
});
it('locks mutations after an uncertain publisher response and unlocks only after a newer terminal job is found', async () => {
  preferences.blogId = 'test_blog'; vi.spyOn(window, 'confirm').mockReturnValue(true); client.startPublishJob.mockRejectedValue(new Error('응답 유실'));
  await render(7); await click('네이버에 임시저장'); checkMutationLock();
  await click('기존 임시저장 작업 다시 확인'); checkMutationLock();
  client.latestPublishJob.mockResolvedValue({ ...activeJob, status: 'failed' }); client.getPublishJob.mockResolvedValue({ ...activeJob, status: 'failed' });
  await click('기존 임시저장 작업 다시 확인'); await settle();
  expect((host.querySelector('#draft-title') as HTMLInputElement).disabled).toBe(false);
  expect(client.startPublishJob).toHaveBeenCalledTimes(1);
});
it('blocks asset mutation and publisher requests when the asset list cannot be verified', async () => {
  preferences.blogId = 'test_blog'; client.listDraftAssets.mockRejectedValue(new Error('이미지 목록 연결 실패'));
  await render(7); expect(button('앱이 안내 이미지 3장 만들기').disabled).toBe(true);
  expect(button('네이버에 임시저장').disabled).toBe(true);
  expect(host.textContent).toContain('이미지 목록을 확인하지 못해 변경과 임시저장을 막았습니다');
});
it('never labels a legacy save ACK as reopen-verified success', async () => {
  client.latestPublishJob.mockResolvedValue({ ...activeJob, status: 'draft_saved' }); client.getPublishJob.mockResolvedValue({ ...activeJob, status: 'draft_saved' });
  await render(7); await settle();
  expect(host.textContent).toContain('구형 저장 응답 수신 · 재열기 미검증');
  expect(host.textContent).toContain('완전한 저장 성공으로 판단하지 마세요');
  expect(host.textContent).not.toContain('재열기 검증까지 완료');
});
it('ignores an older latest-comparison response that returns after the newer request', async () => {
  await render(7); await input('#draft-body', '사용자 원고'); client.addDraftVersion.mockRejectedValue(new Error('비교 필요'));
  await click('수정 내용 저장');
  const older = deferred<DraftDetail>(), newer = deferred<DraftDetail>();
  client.getDraft.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  await click('최신 원고와 비교'); await click('최신 원고와 비교');
  await act(async () => newer.resolve({ ...detail, versions: [{ ...detail.versions[0], version: 3, title: '최신 v3' }] })); await settle();
  await act(async () => older.resolve({ ...detail, versions: [{ ...detail.versions[0], version: 2, title: '늦은 v2' }] })); await settle();
  expect(host.textContent).toContain('서버 최신 v3'); expect(host.textContent).not.toContain('늦은 v2');
  expect((host.querySelector('#draft-body') as HTMLTextAreaElement).value).toBe('사용자 원고');
});
it('ignores comparison responses and errors after the editor version changes', async () => {
  const updated = { ...detail, versions: [...detail.versions, { ...detail.versions[0], version: 2, title: '저장된 v2' }] };
  const onUpdated = vi.fn();
  const editor = (draft: DraftDetail) => <QueryClientProvider client={query}><DraftEditor client={client as unknown as CoreClient} draft={draft} quality={null} suggestedTags={[]} preferences={preferences} onPreferences={vi.fn()} onDirtyChange={vi.fn()} onUpdated={onUpdated} disabled={false}/></QueryClientProvider>;
  await act(async () => root.render(editor(detail))); await settle();
  await input('#draft-body', '수정 원고'); client.addDraftVersion.mockRejectedValue(new Error('비교 필요')); await click('수정 내용 저장');
  const pendingComparison = deferred<DraftDetail>(); client.getDraft.mockReturnValueOnce(pendingComparison.promise); await click('최신 원고와 비교');
  await act(async () => root.render(editor(updated))); await settle();
  await act(async () => pendingComparison.resolve({ ...detail, versions: [{ ...detail.versions[0], version: 9, title: '이전 요청 결과' }] })); await settle();
  expect(host.textContent).not.toContain('서버 최신 v9'); expect((host.querySelector('#draft-title') as HTMLInputElement).value).toBe('저장된 v2');
});
it('rejects comparison data belonging to another draft', async () => {
  await render(7); await input('#draft-body', '수정 원고'); client.addDraftVersion.mockRejectedValue(new Error('비교 필요')); await click('수정 내용 저장');
  client.getDraft.mockResolvedValue({ ...detail, draft_id: 999 }); await click('최신 원고와 비교');
  expect(host.textContent).toContain('다른 원고의 비교 응답'); expect(host.textContent).not.toContain('서버 최신 v1');
});

it('blocks synchronous save/publish/delete while uploading an approved file', async () => {
  preferences.blogId = 'test_blog'; vi.spyOn(window, 'confirm').mockReturnValue(true);
  const upload = deferred<unknown>(); client.addDraftAsset.mockReturnValue(upload.promise);
  await render(7); await input('#draft-body', detail.versions[0].body + '수정');
  await act(async () => [...host.querySelectorAll('label')].find(label => label.textContent?.includes('내 파일을 추가할 경우'))!.querySelector('input')!.click());
  const file = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(file, 'files', { configurable: true, value: [new File(['image'], 'my-photo.png', { type: 'image/png' })] });
  await act(async () => { file.dispatchEvent(new Event('change', { bubbles: true })); button('수정 내용 저장').click(); button('삭제').click(); }); await settle();
  expect(client.addDraftAsset).toHaveBeenCalledOnce(); expect(client.addDraftVersion).not.toHaveBeenCalled(); expect(client.deleteDraftAsset).not.toHaveBeenCalled();
  checkMutationLock(); await act(async () => upload.resolve({ asset_id: 4 })); await settle();
  expect((host.querySelector('#draft-title') as HTMLInputElement).disabled).toBe(false);
});
it('fills a free image slot after deleting an earlier image instead of colliding with the last position', async () => {
  const original = await client.listDraftAssets();
  client.listDraftAssets.mockResolvedValue(original.filter((asset: { position: number }) => asset.position !== 0));
  client.addDraftAsset.mockResolvedValue({ asset_id: 4 });
  await render(7);
  await act(async () => [...host.querySelectorAll('label')].find(label => label.textContent?.includes('내 파일을 추가할 경우'))!.querySelector('input')!.click());
  const file = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(file, 'files', { configurable: true, value: [new File(['image'], 'replacement.png', { type: 'image/png' })] });
  await act(async () => file.dispatchEvent(new Event('change', { bubbles: true })));
  await settle();
  expect(client.addDraftAsset).toHaveBeenCalledWith(7, expect.objectContaining({ position: 0, anchor_after: 1 }));
});
it('blocks publish when an approved file starts uploading before React renders its busy state', async () => {
  preferences.blogId = 'test_blog'; vi.spyOn(window, 'confirm').mockReturnValue(true);
  const upload = deferred<unknown>(); client.addDraftAsset.mockReturnValue(upload.promise);
  await render(7); await act(async () => [...host.querySelectorAll('label')].find(label => label.textContent?.includes('내 파일을 추가할 경우'))!.querySelector('input')!.click());
  const file = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(file, 'files', { configurable: true, value: [new File(['image'], 'my-photo.png', { type: 'image/png' })] });
  await act(async () => { file.dispatchEvent(new Event('change', { bubbles: true })); button('네이버에 임시저장').click(); }); await settle();
  expect(client.addDraftAsset).toHaveBeenCalledOnce(); expect(client.startPublishJob).not.toHaveBeenCalled();
  await act(async () => upload.resolve({ asset_id: 4 })); await settle();
});
it('recovers an unknown job query with the explicit previous-job check', async () => {
  client.latestPublishJob.mockResolvedValue({ ...activeJob, status: 'draft_saved' }); client.getPublishJob.mockRejectedValue(new Error('작업 확인 실패'));
  await render(7); await settle(); checkMutationLock();
  client.latestPublishJob.mockResolvedValue({ ...activeJob, status: 'verified_draft_saved', stage: 'reopen_verify' });
  await click('기존 임시저장 작업 다시 확인'); await settle();
  expect((host.querySelector('#draft-title') as HTMLInputElement).disabled).toBe(false);
  expect(host.textContent).toContain('재열기 검증까지 완료');
});
it('lets users recover a failed asset lookup without recreating the draft', async () => {
  client.listDraftAssets.mockRejectedValueOnce(new Error('목록 실패')).mockResolvedValue([]);
  await render(7); expect(button('앱이 안내 이미지 3장 만들기').disabled).toBe(true);
  await click('이미지 목록 다시 확인');
  expect(button('앱이 안내 이미지 3장 만들기').disabled).toBe(false);
  expect(client.composeBlog).not.toHaveBeenCalled();
});
it('discards a late comparison error after changing the draft identity', async () => {
  const other = { ...detail, draft_id: 9, versions: [{ ...detail.versions[0], title: '다른 원고' }] };
  const editor = (draft: DraftDetail) => <QueryClientProvider client={query}><DraftEditor client={client as unknown as CoreClient} draft={draft} quality={null} suggestedTags={[]} preferences={preferences} onPreferences={vi.fn()} onDirtyChange={vi.fn()} onUpdated={vi.fn()} disabled={false}/></QueryClientProvider>;
  await act(async () => root.render(editor(detail))); await settle();
  await input('#draft-body', '수정 원고'); client.addDraftVersion.mockRejectedValue(new Error('비교 필요')); await click('수정 내용 저장');
  const comparison = deferred<DraftDetail>(); client.getDraft.mockReturnValueOnce(comparison.promise); await click('최신 원고와 비교');
  await act(async () => root.render(editor(other))); await settle();
  await act(async () => comparison.reject(new Error('이전 원고 비교 실패'))); await settle();
  expect(host.textContent).not.toContain('이전 원고 비교 실패');
  expect((host.querySelector('#draft-title') as HTMLInputElement).value).toBe('다른 원고');
});

it('locks mutations on a mismatched job ID even if the response belongs to the same draft', async () => {
  client.latestPublishJob.mockResolvedValue({ ...activeJob, status: 'draft_saved' });
  client.getPublishJob.mockResolvedValue({ ...activeJob, job_id: 99, status: 'draft_saved' });
  await render(7); await settle(); checkMutationLock();
  expect(host.textContent).toContain('다른 원고 또는 작업의 응답');
});
