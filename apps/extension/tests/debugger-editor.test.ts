import { setImmediate as realImmediate } from 'node:timers';
import type { PublishCommand, PublishCommandAsset } from '@ncos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(),
  onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
}));
vi.mock('wxt/browser', () => ({ browser: { debugger: api, tabs: { get: vi.fn(async () => ({ url: 'https://blog.naver.com/sence4u/postwrite' })) } } }));
import { DebuggerSmartEditor } from '../lib/debugger-editor';
import { contentHash } from '../lib/smarteditor';

const body = '본문 내용입니다. '.repeat(350);
let command: PublishCommand;
let editor: DebuggerSmartEditor;
let finalPublish: ReturnType<typeof vi.fn>;
let listeners: Array<(source: { tabId: number }, method: string, params: Record<string, unknown>) => void>;
let inputEnabled: boolean;
let targetNode: HTMLElement | null;

// Run the production Runtime.evaluate expressions against a DOM. Only CDP's
// native click/key/file bridge is mocked, not editor guards or DOM readers.
function runtime(expression: string): unknown {
  return Function('document', 'window', `return (${expression});`)(document, window);
}

function image(source: string, complete = true): HTMLImageElement {
  const img = document.createElement('img'); img.src = source;
  Object.defineProperties(img, { complete: { value: complete, configurable: true }, naturalWidth: { value: complete ? 600 : 0, configurable: true } });
  return img;
}

function state(): Promise<{ title: string; body: string; images: Array<{ source: string; anchor_after: number }>; image_count: number }> {
  return (editor as unknown as { editorState: typeof state }).editorState();
}

beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks();
  inputEnabled = true; targetNode = null; listeners = [];
  document.body.innerHTML = `<div class="se-container">
    <section class="se-documentTitle"><p class="se-text-paragraph"><span class="se-placeholder">제목을 입력하세요</span></p></section>
    <div class="se-main-container"><section class="se-section-text"><p class="se-text-paragraph"><span class="se-placeholder">본문을 입력하세요</span></p></section></div>
    <button data-click-area="tpb.publish">발행</button><button data-click-area="tpb.save">임시저장</button>
    <button data-name="image">사진</button><button data-click-area="tpb*s.count">임시저장된 글</button>
    <div class="tag_area" style="display:none"><input id="tag-input"><button id="final-publish">공개 발행</button></div>
    <input id="photo" type="file" accept="image/png">
  </div>`;
  const positions = new WeakMap<Element, number>(); let counter = 0;
  vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (!positions.has(this)) positions.set(this, ++counter * 100);
    const y = positions.get(this)!;
    return { x: 0, y, top: y, left: 0, width: 100, height: 40, right: 100, bottom: y + 40, toJSON() {} };
  });
  vi.spyOn(window.HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined);
  document.querySelector('[data-click-area="tpb.publish"]')!.addEventListener('click', () => { (document.querySelector('.tag_area') as HTMLElement).style.display = 'block'; });
  document.querySelector('[data-name="image"]')!.addEventListener('click', () => listeners.forEach(listener => listener({ tabId: 1 }, 'Page.fileChooserOpened', { backendNodeId: 10 })));
  const tagInput = document.querySelector<HTMLInputElement>('#tag-input')!;
  tagInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && inputEnabled) { const chip = document.createElement('span'); chip.setAttribute('data-tag', tagInput.value); document.querySelector('.tag_area')!.append(chip); tagInput.value = ''; }
  });
  finalPublish = vi.fn(); document.querySelector('#final-publish')!.addEventListener('click', finalPublish);
  api.attach.mockImplementation((_t, _v, callback) => callback());
  api.detach.mockImplementation((_t, callback) => callback());
  api.onEvent.addListener.mockImplementation(listener => listeners.push(listener));
  api.onEvent.removeListener.mockImplementation(listener => { listeners = listeners.filter(l => l !== listener); });
  api.sendCommand.mockImplementation((_target, method, params, callback) => {
    if (method === 'Runtime.evaluate') {
      try {
        const value = runtime(params.expression);
        if (value && typeof value === 'object' && 'x' in value && 'y' in value) {
          targetNode = [...document.querySelectorAll<HTMLElement>('*')].find(node => {
            const rect = node.getBoundingClientRect(); return rect.left + rect.width / 2 === value.x && rect.top + rect.height / 2 === value.y;
          }) ?? null;
        }
        callback({ result: { value } });
      } catch (e) { callback({ exceptionDetails: { text: String(e) } }); }
      return;
    }
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      targetNode?.focus(); targetNode?.click();
      if (targetNode?.matches('p')) { const range = document.createRange(); range.selectNodeContents(targetNode); range.collapse(false); const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
    }
    if (method === 'Input.insertText' && inputEnabled) {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement) { active.value = params.text; }
      else { const selection = document.getSelection(); if (selection?.rangeCount) { const range = selection.getRangeAt(0); range.deleteContents(); range.insertNode(document.createTextNode(params.text)); } }
    }
    if (method === 'Input.dispatchKeyEvent' && params.type === 'rawKeyDown') document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: params.key, bubbles: true }));
    if (method === 'DOM.resolveNode') { callback({ object: { objectId: 'file-input' } }); return; }
    if (method === 'Runtime.callFunctionOn') {
      const fn = Function(`return (${params.functionDeclaration});`)();
      callback({ result: { value: fn.call(document.querySelector('#photo'), ...params.arguments.map((a: { value: unknown }) => a.value)) } }); return;
    }
    callback({});
  });
  command = {
    job_id: 1, draft_id: 1, draft_version: 1, blog_id: 'sence4u', title: '완성된 제목', body,
    title_hash: await contentHash('완성된 제목'), body_hash: await contentHash(body), body_chars: body.length,
    tags: [], assets: [], attempt_id: 'attempt-1', lease_owner: 'worker', resume_stage: 'browser_attach', asset_manifest_hash: 'manifest', image_receipts: [],
  };
  editor = new DebuggerSmartEditor(1);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = ''; });

async function settle<T>(task: Promise<T>): Promise<T> {
  const outcome = task.then(value => ({ value }), error => ({ error }));
  let finished = false; void outcome.then(() => { finished = true; });
  for (let i = 0; i < 100 && !finished; i++) {
    await new Promise<void>(resolve => realImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1_000);
  }
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}

async function asset(): Promise<{ asset: PublishCommandAsset; bytes: ArrayBuffer }> {
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  return { bytes, asset: { asset_id: 1, draft_id: 1, draft_version: 1, filename: 'image.png', mime_type: 'image/png', byte_size: 4, sha256, position: 0, anchor_after: 1, rights_status: 'approved', created_at: null, native_path: '/not-used.png', download_url: '/v1/publish-jobs/1/assets/1' } };
}

function preparedBody(): void {
  document.querySelector('.se-documentTitle p')!.textContent = command.title;
  document.querySelector('.se-main-container')!.innerHTML = '<section class="se-section-text"><p class="se-text-paragraph">첫 문단</p><p class="se-text-paragraph"><span class="se-placeholder">안내</span></p></section><section class="se-section-text"><p class="se-text-paragraph">뒤 문단</p><p class="se-text-paragraph"> </p></section>';
}

describe('current Chrome production safety gates', () => {
  it.each(['title', 'body', 'image', 'resume-prompt'])('protects existing %s without typing, file upload or save', async kind => {
    if (kind === 'title') document.querySelector('.se-documentTitle p')!.textContent = '사용자가 쓴 제목';
    if (kind === 'body') document.querySelector('.se-main-container p')!.textContent = '사용자가 쓴 본문';
    if (kind === 'image') document.querySelector('.se-main-container')!.append(image('blob:existing'));
    if (kind === 'resume-prompt') document.body.append('작성 중인 글이 있습니다');
    const before = document.body.innerHTML; const report = vi.fn(async (_stage: string, _status: string) => undefined);
    await expect(settle(editor.execute(command, report, vi.fn()))).rejects.toMatchObject({ code: 'existing_draft_protected' });
    expect(document.body.innerHTML).toBe(before);
    expect(api.sendCommand.mock.calls.some(c => ['Input.insertText', 'DOM.setFileInputFiles', 'Runtime.callFunctionOn'].includes(c[1]))).toBe(false);
  });

  it('accepts placeholder-only blank editor but stops before upload when input readback fails', async () => {
    inputEnabled = false; const report = vi.fn(async (_stage: string, _status: string) => undefined);
    await expect(settle(editor.execute(command, report, vi.fn()))).rejects.toMatchObject({ code: 'input_readback_mismatch', stage: 'input_title' });
    expect(report.mock.calls.some(c => c[0] === 'prepare_editor' && c[1] === 'passed')).toBe(true);
    expect(report.mock.calls.some(c => c[0] === 'input_body')).toBe(false);
  });

  it('rejects missing selection/caret acknowledgement before inserting text', async () => {
    vi.spyOn(document, 'getSelection').mockReturnValue(null);
    await expect(settle(editor.inputTitle('제목'))).rejects.toMatchObject({ code: 'input_caret_unconfirmed' });
    expect(api.sendCommand.mock.calls.some(c => c[1] === 'Input.insertText')).toBe(false);
  });

  it('hash-checks downloaded bytes before invoking a file chooser', async () => {
    const value = await asset(); preparedBody();
    await expect(editor.uploadImages([value.asset], async () => new Uint8Array([9, 9, 9, 9]).buffer)).rejects.toMatchObject({ code: 'asset_hash_mismatch' });
    expect(api.sendCommand.mock.calls.some(c => c[1] === 'Page.setInterceptFileChooserDialog')).toBe(false);
  });

  it.each([0, 2])('uses whole-document original paragraphs at anchor %i and transfers checked bytes', async anchor => {
    preparedBody(); const value = await asset(); value.asset.anchor_after = anchor;
    const input = document.querySelector<HTMLInputElement>('#photo')!;
    input.addEventListener('change', () => {
      const selection = document.getSelection()!; const range = selection.getRangeAt(0);
      const img = image('https://blogfiles.pstatic.net/checked.png?type=w800');
      // Editor wraps images as sibling components, never as children of a paragraph.
      const paragraph = selection.anchorNode!.nodeType === 1 ? selection.anchorNode as Element : selection.anchorNode!.parentElement!;
      const p = paragraph.closest('p')!;
      if (range.startOffset === 0) p.before(img); else p.after(img);
    });
    const receipts = await settle(editor.uploadImages([value.asset], async () => value.bytes));
    expect(receipts).toEqual([{ asset_id: 1, sha256: value.asset.sha256, remote_url: 'https://blogfiles.pstatic.net/checked.png' }]);
    expect((await state()).images[0].anchor_after).toBe(anchor);
    expect(new Uint8Array(await input.files![0].arrayBuffer())).toEqual(new Uint8Array(value.bytes));
    expect(api.sendCommand.mock.calls.some(c => c[1] === 'DOM.setFileInputFiles')).toBe(false);
  });

  it('does not count blob placeholders as completed upload', async () => {
    preparedBody(); const value = await asset();
    document.querySelector('#photo')!.addEventListener('change', () => document.querySelector('.se-main-container')!.append(image('blob:pending', false)));
    await expect(settle(editor.uploadImages([value.asset], async () => value.bytes))).rejects.toMatchObject({ code: 'remote_image_timeout' });
  });

  it('rejects ambiguous active editor roots instead of reading stale images', async () => {
    const root = document.querySelector('.se-main-container')!.cloneNode(true); document.body.append(root);
    await expect(settle(editor.execute(command, vi.fn(async () => undefined), vi.fn()))).rejects.toMatchObject({ code: 'editor_root_ambiguous' });
  });

  it('does not accept click/delay or saving label as a save acknowledgement', async () => {
    document.querySelector('[data-click-area="tpb.save"]')!.addEventListener('click', e => { (e.target as HTMLElement).textContent = '저장 중'; });
    await expect(settle(editor.saveDraft())).rejects.toMatchObject({ code: 'draft_save_unconfirmed' });
  });

  it('requires a fresh save-completion signal and never clicks final public submit', async () => {
    document.querySelector('[data-click-area="tpb.save"]')!.addEventListener('click', () => {
      const ack = document.createElement('span'); ack.className = 'save_complete'; ack.textContent = '저장 완료'; document.body.append(ack);
    });
    await expect(settle(editor.saveDraft())).resolves.toBeUndefined();
    await expect(settle(editor.inputTags(['여행 준비']))).resolves.toBeUndefined();
    expect(finalPublish).not.toHaveBeenCalled();
  });

  it('fails when Enter did not produce the expected tag chips', async () => {
    // Keep text typing working while removing tag commit listener by replacing the input.
    const input = document.querySelector('#tag-input')!; input.replaceWith(input.cloneNode(true));
    await expect(settle(editor.inputTags(['여행']))).rejects.toMatchObject({ code: 'tag_readback_mismatch' });
    expect(finalPublish).not.toHaveBeenCalled();
  });
  it('rejects an old unchanged save-completion toast', async () => {
    const ack = document.createElement('span'); ack.className = 'save_complete'; ack.textContent = '저장 완료'; document.body.append(ack);
    await expect(settle(editor.saveDraft())).rejects.toMatchObject({ code: 'draft_save_unconfirmed' });
  });

  it('recomputes iframe offsets after scrolling the actual target', async () => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    const inner = frame.contentDocument!; inner.body.innerHTML = '<p id="frame-title">제목</p>';
    let frameTop = 500;
    frame.getBoundingClientRect = () => ({ top: frameTop, left: 20, width: 300, height: 200 } as DOMRect);
    const p = inner.querySelector<HTMLElement>('p')!;
    p.getBoundingClientRect = () => ({ top: 10, left: 5, width: 100, height: 40 } as DOMRect);
    p.scrollIntoView = () => { frameTop = 100; };
    const point = await (editor as unknown as { locate: (s: string[], stage: string, code: string, msg: string) => Promise<{ x: number; y: number }> }).locate(['#frame-title'], 'input_title', 'missing', 'missing');
    expect(point).toMatchObject({ x: 75, y: 130 });
  });

  it.each([0, 2])('reopens and verifies image identity, tags and original paragraph anchor %i', async anchor => {
    preparedBody(); const value = await asset(); value.asset.anchor_after = anchor;
    const img = image('https://blogfiles.pstatic.net/saved.png?type=w600');
    const paragraphs = [...document.querySelectorAll('.se-main-container p')].filter(p => !p.querySelector('.se-placeholder') && p.textContent?.trim());
    if (anchor === 0) paragraphs[0].before(img); else paragraphs[anchor - 1].after(img);
    command.assets = [value.asset]; command.image_receipts = [{ asset_id: 1, sha256: value.asset.sha256, remote_url: 'https://blogfiles.pstatic.net/saved.png?type=w800' }];
    command.body = (await state()).body; command.body_hash = await contentHash(command.body);
    command.tags = ['여행']; const chip = document.createElement('span'); chip.setAttribute('data-tag', '여행'); document.querySelector('.tag_area')!.append(chip);
    const saved = document.createElement('button'); saved.textContent = command.title;
    document.querySelector('[data-click-area="tpb*s.count"]')!.addEventListener('click', () => document.body.append(saved));
    const open = vi.fn(); saved.addEventListener('click', open);
    const result = await settle(editor.verify(command));
    expect(result).toMatchObject({ actual_tags: ['여행'], image_receipts: [{ asset_id: 1, sha256: value.asset.sha256, remote_url: 'https://blogfiles.pstatic.net/saved.png' }], title_hash_match: true, body_hash_match: true });
    expect(open).toHaveBeenCalledTimes(1); // A matching currently-open title alone is never proof.
    expect(finalPublish).not.toHaveBeenCalled();
  });

  it.each(['wrong-url', 'wrong-anchor', 'blob', 'missing-tag'])('fails reopened draft with %s despite equal image count', async problem => {
    preparedBody(); const value = await asset(); value.asset.anchor_after = 0;
    const img = image(problem === 'wrong-url' ? 'https://blogfiles.pstatic.net/other.png' : problem === 'blob' ? 'blob:pending' : 'https://blogfiles.pstatic.net/saved.png');
    const first = document.querySelector('.se-main-container p')!;
    if (problem === 'wrong-anchor') first.after(img); else first.before(img);
    command.assets = [value.asset]; command.image_receipts = [{ asset_id: 1, sha256: value.asset.sha256, remote_url: 'https://blogfiles.pstatic.net/saved.png' }];
    command.body_hash = await contentHash((await state()).body); command.tags = ['여행'];
    const chip = document.createElement('span'); chip.setAttribute('data-tag', '여행'); if (problem !== 'missing-tag') document.querySelector('.tag_area')!.append(chip);
    const saved = document.createElement('button'); saved.textContent = command.title;
    document.querySelector('[data-click-area="tpb*s.count"]')!.addEventListener('click', () => document.body.append(saved));
    await expect(settle(editor.verify(command))).rejects.toMatchObject({ code: problem === 'missing-tag' ? 'tags_mismatch' : 'image_receipts_mismatch' });
    expect(finalPublish).not.toHaveBeenCalled();
  });

  it('never clicks a final submit sharing the old generic publish_btn__ class', async () => {
    document.querySelector('[data-click-area="tpb.publish"]')!.remove();
    const final = document.querySelector<HTMLButtonElement>('#final-publish')!; final.className = 'publish_btn__WEpYf';
    (document.querySelector('.tag_area') as HTMLElement).style.display = 'block';
    await expect(settle(editor.inputTags(['여행']))).rejects.toMatchObject({ code: 'publish_layer_already_open' });
    expect(finalPublish).not.toHaveBeenCalled();
    document.querySelector('.tag_area')!.remove();
    document.body.append(final); // A standalone final button with the shared class is not a toolbar opener.
    await expect(settle(editor.inputTags(['여행']))).rejects.toMatchObject({ code: 'publish_toolbar_not_found' });
    expect(finalPublish).not.toHaveBeenCalled();
  });

  it('stops before any content mutation when a publish confirmation layer is already open', async () => {
    (document.querySelector('.tag_area') as HTMLElement).style.display = 'block';
    const before = document.body.innerHTML;
    await expect(settle(editor.execute(command, vi.fn(async () => undefined), vi.fn()))).rejects.toMatchObject({ code: 'publish_layer_already_open' });
    expect(document.body.innerHTML).toBe(before); expect(finalPublish).not.toHaveBeenCalled();
    expect(api.sendCommand.mock.calls.some(c => c[1] === 'Input.insertText')).toBe(false);
  });

});
