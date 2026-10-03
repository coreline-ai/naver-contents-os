import type { PublishCommand, PublishCommandAsset } from '@ncos/contracts';
import { browser } from 'wxt/browser';
import { contentHash, normalizeRemoteImageUrl, normalizedTags, validateCommand } from './smarteditor';

type Debuggee = { tabId: number };
type DebuggerEvent = (source: Debuggee, method: string, params?: Record<string, unknown>) => void;
type DebuggerApi = {
  attach(target: Debuggee, requiredVersion: string, callback: () => void): void;
  detach(target: Debuggee, callback: () => void): void;
  sendCommand<T = unknown>(target: Debuggee, method: string, commandParams: Record<string, unknown>, callback: (result?: T) => void): void;
  onEvent: {
    addListener(listener: DebuggerEvent): void;
    removeListener(listener: DebuggerEvent): void;
  };
};

const debuggerApi = (browser as unknown as { debugger: DebuggerApi }).debugger;

function lastRuntimeError(): string {
  return (globalThis as unknown as { chrome?: { runtime?: { lastError?: { message?: string } } } })
    .chrome?.runtime?.lastError?.message ?? '';
}

function debuggerCall<T>(invoke: (callback: (value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      invoke((value) => {
        const message = lastRuntimeError();
        if (message) reject(new Error(message));
        else resolve(value as T);
      });
    } catch (error) {
      reject(error);
    }
  });
}

const SELECTORS = {
  title: [
    '.se-documentTitle .se-text-paragraph',
    '.se-title-text .se-text-paragraph',
    '.se-title-text',
    '[contenteditable="true"][data-placeholder*="제목"]',
  ],
  body: [
    '.se-section-text .se-text-paragraph',
    '.se-component.se-text .se-text-paragraph',
    '[contenteditable="true"][data-placeholder*="본문"]',
  ],
  bodyContainer: ['.se-section-text', '.se-main-container', '#SE-canvas'],
  imageButton: [
    'button.se-image-toolbar-button',
    'button[data-name="image"]',
    '.se-toolbar-item-image button',
  ],
  // Only the explicit toolbar opener. Final publish controls may share CSS classes.
  publishButton: ['button[data-click-area="tpb.publish"]'],
  tagInput: ['#tag-input', 'input.tag_input', '.tag_area input'],
  tagChip: ['[id^="tag-item-"][aria-label]', '.tag_area .tag', '.tag_area [class*="tag_item"]', '[class*="tag_list"] [class*="tag_item"]', '[data-tag]'],
  saveSuccess: ['span[class^="autosave_message__"][class*="is_show__"]', '[class*="save_complete"]'],
  saveButton: [
    'button.save_btn__bzc5B',
    'button[class^="save_btn__"]',
    'button[class*=" save_btn__"]',
    '.save_area button.save_btn',
    'button[data-click-area="tpb.save"]',
  ],
  savedDraftListButton: [
    'button[data-click-area="tpb*s.count"]',
    'button[aria-label*="임시저장된 글"]',
    'button[class^="save_count_btn__"]',
    'button[class*=" save_count_btn__"]',
  ],
  savedDraftItem: ['button[data-click-area="tpb*s.tlist"]'],
  closeHelp: ['button.se-help-panel-close-button', '.se-popup-button-cancel', 'button[data-name="close"]'],
} as const;

// Current SmartEditor uses a class-based canvas; older editor variants used
// #SE-canvas / .se-main-container. Share this scope for reads and image anchors.
const EDITOR_ROOT_SELECTOR = '.se-main-container, #SE-canvas, .se-canvas';

export class DebuggerEditorError extends Error {
  constructor(public stage: string, public code: string, message: string) {
    super(message);
  }
}

type ElementInfo = { x: number; y: number; text: string; tag: string; caret_ack?: boolean };
type ImageReceipt = { asset_id: number; sha256: string; remote_url: string };
type EditorImage = { source: string; anchor_after: number; complete: boolean };
type EditorState = {
  title: string; body: string; image_count: number; remote_image_count: number;
  images: EditorImage[]; root_count: number; non_text_count: number; resume_prompt: boolean;
};

function normalize(value: string): string {
  return (value || '').replace(/[\s\u200b-\u200d\ufeff]+/g, '');
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class DebuggerSmartEditor {
  private readonly target: Debuggee;
  private attached = false;

  constructor(private readonly tabId: number) {
    this.target = { tabId };
  }

  private async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    try {
      return await debuggerCall<T>((callback) => debuggerApi.sendCommand<T>(this.target, method, params ?? {}, callback));
    } catch (error) {
      throw new Error(`${method}: ${error instanceof Error ? error.message : 'Chrome debugger command failed'}`);
    }
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<{
      result?: { value?: T; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || response.result?.description
        || '페이지 스크립트 실행 실패',
      );
    }
    return response.result?.value as T;
  }

  async attach(): Promise<void> {
    if (this.attached) return;
    if (!debuggerApi) throw new DebuggerEditorError('browser_attach', 'debugger_unavailable', 'Chrome 디버거 입력 기능을 사용할 수 없습니다.');
    try {
      await debuggerCall<void>((callback) => debuggerApi.attach(this.target, '1.3', callback));
      this.attached = true;
      await this.send('Runtime.enable');
      await this.send('Page.enable');
      await this.send('DOM.enable');
    } catch (error) {
      throw new DebuggerEditorError(
        'browser_attach',
        'debugger_attach_failed',
        `현재 Chrome 편집기에 자동 입력 권한을 연결하지 못했습니다: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  async detach(): Promise<void> {
    if (!this.attached) return;
    this.attached = false;
    await debuggerCall<void>((callback) => debuggerApi.detach(this.target, callback)).catch(() => undefined);
  }

  private elementExpression(
    selectors: readonly string[],
    options: { focus?: boolean; selectContents?: boolean; textIncludes?: string; closestClickable?: boolean; unique?: boolean } = {},
  ): string {
    return `(() => {
      const selectors = ${JSON.stringify(selectors)};
      const textIncludes = ${JSON.stringify(options.textIncludes ?? '')};
      const roots = [];
      const visit = (doc, frames) => {
        roots.push({ doc, frames });
        for (const frame of doc.querySelectorAll('iframe')) {
          try {
            if (!frame.contentDocument) continue;
            visit(frame.contentDocument, [...frames, frame]);
          } catch (_) {}
        }
      };
      visit(document, []);
      const visible = (element) => {
        // Elements inside SmartEditor's same-origin iframe belong to that
        // iframe's JavaScript realm. A top-window instanceof check
        // therefore rejects valid editor nodes even though they are visible.
        const view = element.ownerDocument && element.ownerDocument.defaultView;
        if (!view || !(element instanceof view.HTMLElement)) return false;
        const style = view.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && !element.hasAttribute('disabled');
      };
      for (const root of roots) {
        let candidates = [];
        if (selectors.length) {
          for (const selector of selectors) candidates.push(...root.doc.querySelectorAll(selector));
        } else {
          candidates = [...root.doc.querySelectorAll('button,a,[role="button"],li')];
        }
        const matching = [...new Set(candidates)].filter((candidate) => visible(candidate)
          && (!textIncludes || (candidate.innerText || candidate.textContent || '').replace(/\\s+/g, ' ').includes(textIncludes)));
        if (${Boolean(options.unique)} && matching.length > 1) return null;
        let element = matching[0];
        if (!element) continue;
        if (${Boolean(options.closestClickable)}) {
          element = element.closest('button,a,[role="button"],li') || element;
        }
        element.scrollIntoView({ block: 'center', inline: 'center' });
        if (${Boolean(options.focus)}) element.focus({ preventScroll: true });
        if (${Boolean(options.selectContents)} && 'select' in element && /^(INPUT|TEXTAREA)$/.test(element.tagName)) element.select();
        else if (${Boolean(options.selectContents)}) {
          const selection = element.ownerDocument.getSelection();
          const range = element.ownerDocument.createRange();
          range.selectNodeContents(element);
          if (!selection) return null;
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const rect = element.getBoundingClientRect();
        const offset = root.frames.reduce((sum, frame) => {
          const frameRect = frame.getBoundingClientRect();
          return { x: sum.x + frameRect.left + frame.clientLeft, y: sum.y + frameRect.top + frame.clientTop };
        }, { x: 0, y: 0 });
        const selection = element.ownerDocument.getSelection();
        const caretAck = /^(INPUT|TEXTAREA)$/.test(element.tagName)
          ? element.ownerDocument.activeElement === element
          : !!selection && selection.rangeCount > 0 && element.contains(selection.anchorNode) && element.contains(selection.focusNode);
        return {
          x: offset.x + rect.left + rect.width / 2,
          y: offset.y + rect.top + rect.height / 2,
          caret_ack: caretAck,
          text: element.innerText || element.textContent || '',
          tag: element.tagName,
        };
      }
      return null;
    })()`;
  }

  private async locate(
    selectors: readonly string[],
    stage: string,
    code: string,
    message: string,
    options: { focus?: boolean; selectContents?: boolean; textIncludes?: string; closestClickable?: boolean; unique?: boolean } = {},
    timeoutMs = 15_000,
  ): Promise<ElementInfo> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const info = await this.evaluate<ElementInfo | null>(this.elementExpression(selectors, options));
      if (info) return info;
      await sleep(200);
    }
    throw new DebuggerEditorError(stage, code, message);
  }

  private async clickPoint(point: ElementInfo): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }

  private async click(
    selectors: readonly string[],
    stage: string,
    code: string,
    message: string,
    options: { textIncludes?: string; closestClickable?: boolean; unique?: boolean } = {},
    timeoutMs = 15_000,
  ): Promise<void> {
    await this.clickPoint(await this.locate(selectors, stage, code, message, options, timeoutMs));
  }

  private async selectAllAndInsert(value: string, paragraphBreaks = false, clearSelected = true): Promise<void> {
    // locate(..., selectContents: true) already scopes the selection to the
    // requested title/body node. Meta+A would expand it to the whole editor
    // document and can erase the title while replacing the body.
    if (clearSelected) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      });
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      });
    }
    // SmartEditor treats a multiline insertText payload as one paragraph.
    // Native Enter events create actual editor paragraphs for image anchors.
    const lines = paragraphBreaks ? value.replace(/\r\n?/g, '\n').split('\n') : [value];
    for (let index = 0; index < lines.length; index++) {
      if (index) await this.pressKey('Enter', 'Enter', 13);
      if (lines[index]) await this.send('Input.insertText', { text: lines[index] });
    }
  }

  private async readText(selectors: readonly string[]): Promise<string> {
    return await this.evaluate<string>(`(() => {
      const selectors = ${JSON.stringify(selectors)};
      const docs = [document];
      for (let index = 0; index < docs.length; index += 1) {
        for (const frame of docs[index].querySelectorAll('iframe')) {
          try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
        }
      }
      for (const doc of docs) {
        for (const selector of selectors) {
          for (const element of doc.querySelectorAll(selector)) {
            const view = element.ownerDocument && element.ownerDocument.defaultView;
            const rect = element.getBoundingClientRect();
            if (!view || !(element instanceof view.HTMLElement)) continue;
            const style = view.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) continue;
            return /^(INPUT|TEXTAREA)$/.test(element.tagName) ? element.value : element.innerText || element.textContent || '';
          }
        }
      }
      return '';
    })()`);
  }

  private async replaceText(
    selectors: readonly string[],
    value: string,
    stage: string,
    code: string,
    message: string,
  ): Promise<void> {
    await this.clickPoint(await this.locate(selectors, stage, code, message));
    const clicked = await this.locate(selectors, stage, code, message);
    if (!clicked.caret_ack) throw new DebuggerEditorError(stage, 'input_caret_unconfirmed', '실제 클릭 후 입력 커서를 확인하지 못했습니다.');
    const focused = await this.locate(selectors, stage, code, message, { focus: true, selectContents: true });
    if (!focused.caret_ack) throw new DebuggerEditorError(stage, 'input_caret_unconfirmed', '입력 위치를 확인하지 못해 원고 변경을 중단했습니다.');
    // Backspace in an empty tag input removes the previous chip. Native
    // insertText already replaces a selected INPUT/TEXTAREA value safely.
    await this.selectAllAndInsert(value, stage === 'input_body', !/^(INPUT|TEXTAREA)$/.test(focused.tag));
    const expected = normalize(value);
    const started = Date.now();
    let matched = false;
    while (Date.now() - started < 3_000) {
      const actual = stage === 'input_body' ? (await this.editorState()).body : await this.readText(selectors);
      if (normalize(actual) === expected) {
        if (matched) return;
        matched = true;
      } else matched = false;
      await sleep(200);
    }
    throw new DebuggerEditorError(stage, 'input_readback_mismatch', '자동 입력한 내용과 편집기 내용이 달라 다음 단계를 중단했습니다.');
  }

  private async editorDiagnostics(): Promise<string> {
    return await this.evaluate<string>(`(() => {
      const docs = [document];
      for (let index = 0; index < docs.length; index += 1) {
        for (const frame of docs[index].querySelectorAll('iframe')) {
          try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
        }
      }
      const rows = [];
      for (const doc of docs) {
        rows.push('DOC ' + (doc.location && doc.location.href || 'unknown'));
        const elements = doc.querySelectorAll('[contenteditable],textarea,input,.se-documentTitle,.se-title-text,.se-main-container,#SE-canvas');
        for (const element of [...elements].slice(0, 24)) {
          const rect = element.getBoundingClientRect();
          rows.push([
            element.tagName,
            element.id ? '#' + element.id : '',
            element.className && typeof element.className === 'string' ? '.' + element.className.replace(/\\s+/g, '.') : '',
            'ce=' + String(element.getAttribute('contenteditable')),
            'role=' + String(element.getAttribute('role')),
            'ph=' + String(element.getAttribute('data-placeholder') || element.getAttribute('placeholder') || element.getAttribute('aria-label') || ''),
            'rect=' + [Math.round(rect.width), Math.round(rect.height)].join('x'),
            'text=' + String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').slice(0, 50),
          ].join(' '));
        }
      }
      return rows.join(' | ').slice(0, 1700);
    })()`);
  }

  async waitUntilReady(): Promise<void> {
    try {
      await this.locate(SELECTORS.title, 'health_check', 'title_not_found', 'SmartEditor 제목 입력란을 찾지 못했습니다.');
    } catch (error) {
      if (!(error instanceof DebuggerEditorError)) throw error;
      const diagnostics = await this.editorDiagnostics().catch(() => 'diagnostics unavailable');
      throw new DebuggerEditorError('health_check', 'title_not_found', `SmartEditor 제목 입력란을 찾지 못했습니다. ${diagnostics}`);
    }
    await this.locate(SELECTORS.body, 'health_check', 'body_not_found', 'SmartEditor 본문 입력란을 찾지 못했습니다.');
    await this.locate(SELECTORS.saveButton, 'health_check', 'draft_save_not_found', 'SmartEditor 임시저장 버튼을 찾지 못했습니다.');
  }

  async dismissPopups(): Promise<void> {
    await this.evaluate(`(() => {
      const selectors = ${JSON.stringify(SELECTORS.closeHelp)};
      const docs = [document];
      for (let index = 0; index < docs.length; index += 1) {
        for (const frame of docs[index].querySelectorAll('iframe')) {
          try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
        }
      }
      for (const doc of docs) for (const selector of selectors) doc.querySelector(selector)?.click();
      return true;
    })()`);
  }

  async inputTitle(title: string): Promise<void> {
    await this.replaceText(SELECTORS.title, title.trim(), 'input_title', 'title_input', '제목 자동 입력에 실패했습니다.');
  }

  async inputBody(body: string): Promise<void> {
    await this.replaceText(SELECTORS.body, body.trim(), 'input_body', 'body_input', '본문 자동 입력에 실패했습니다.');
  }

  private async placeImageCaret(anchorAfter: number): Promise<void> {
    const selectors = SELECTORS.body;
    const point = await this.evaluate<(ElementInfo & { paragraphCount: number }) | null>(`(() => {
      const docs = [document];
      for (let i = 0; i < docs.length; i++) for (const frame of docs[i].querySelectorAll('iframe')) {
        try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
      }
      for (const doc of docs) {
        const roots = [...doc.querySelectorAll(${JSON.stringify(EDITOR_ROOT_SELECTOR)})].filter(root => {
          const rect = root.getBoundingClientRect();
          const style = doc.defaultView.getComputedStyle(root);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        }).filter(root => !root.parentElement?.closest(${JSON.stringify(EDITOR_ROOT_SELECTOR)}));
        if (roots.length !== 1) continue;
        const paragraphs = [...roots[0].querySelectorAll(${JSON.stringify(selectors.join(','))})]
          .filter(p => !p.closest('.se-section-documentTitle, .se-documentTitle, .se-section-image') && !p.querySelector('.se-placeholder') && (p.innerText || p.textContent || '').replace(/[\\s\\u200b-\\u200d\\ufeff]/g, ''));
        if (!Number.isInteger(${anchorAfter}) || ${anchorAfter} < 0 || ${anchorAfter} > paragraphs.length) return null;
        const target = paragraphs[Math.max(${anchorAfter} - 1, 0)];
        if (!target) return null;
        target.scrollIntoView({ block: 'center' });
        // Clicking the paragraph centre lands in the middle of a sentence.
        // Read the actual first/last glyph box (including wrapped/nested spans)
        // and let a native click update the editor model, not just DOM selection.
        const walker = doc.createTreeWalker(target), texts = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.nodeType === 3 && /[^\\s\\u200b-\\u200d\\ufeff]/.test(node.textContent || '')) texts.push(node);
        }
        const node = ${anchorAfter} === 0 ? texts[0] : texts[texts.length - 1];
        if (!node) return null;
        const value = node.textContent || '';
        const index = ${anchorAfter} === 0 ? value.search(/[^\\s\\u200b-\\u200d\\ufeff]/) : value.search(/[^\\s\\u200b-\\u200d\\ufeff](?=[\\s\\u200b-\\u200d\\ufeff]*$)/);
        if (index < 0) return null;
        const glyph = doc.createRange(); glyph.setStart(node, index); glyph.setEnd(node, index + 1);
        const rect = glyph.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const inset = Math.min(1, rect.width / 4);
        let x = ${anchorAfter} === 0 ? rect.left + inset : rect.right - inset, y = rect.top + rect.height / 2;
        for (let view = doc.defaultView; view?.frameElement; view = view.parent) {
          const frame = view.frameElement, r = frame.getBoundingClientRect(); x += r.left + frame.clientLeft; y += r.top + frame.clientTop;
        }
        return { x, y, text: target.innerText || target.textContent || '', tag: target.tagName, paragraphCount: paragraphs.length };
      }
      return null;
    })()`);
    if (!point) throw new DebuggerEditorError('upload_images', 'image_anchor_not_found', '전체 본문에서 지정된 이미지 위치를 찾지 못했습니다.');
    await this.clickPoint(point);
    // A DOM Range alone does not update SmartEditor's internal caret. Move with
    // real arrow keys and only READ the selection to acknowledge a paragraph edge.
    const remaining = async () => this.evaluate<number>(`(() => {
      const docs = [document];
      for (let i = 0; i < docs.length; i++) for (const frame of docs[i].querySelectorAll('iframe')) {
        try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
      }
      for (const doc of docs) {
        const roots = [...doc.querySelectorAll(${JSON.stringify(EDITOR_ROOT_SELECTOR)})].filter(root => {
          const rect = root.getBoundingClientRect(), style = doc.defaultView.getComputedStyle(root);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        }).filter(root => !root.parentElement?.closest(${JSON.stringify(EDITOR_ROOT_SELECTOR)}));
        if (roots.length !== 1) continue;
        const paragraphs = [...roots[0].querySelectorAll(${JSON.stringify(selectors.join(','))})]
          .filter(p => !p.closest('.se-section-documentTitle, .se-documentTitle, .se-section-image') && !p.querySelector('.se-placeholder') && (p.innerText || p.textContent || '').replace(/[\\s\\u200b-\\u200d\\ufeff]/g, ''));
        const target = paragraphs[Math.max(${anchorAfter} - 1, 0)];
        // SmartEditor recreates paragraph DOM nodes on navigation; an attribute
        // on the previous node is not a stable identity. Re-resolve and pin text.
        if (paragraphs.length !== ${point.paragraphCount} || !target || (target.innerText || target.textContent || '') !== ${JSON.stringify(point.text)}) return -1;
        const selection = doc.getSelection();
        if (!selection?.rangeCount || !selection.isCollapsed || !target.contains(selection.anchorNode)) return -1;
        const range = doc.createRange(); range.selectNodeContents(target);
        if (${anchorAfter} === 0) range.setEnd(selection.anchorNode, selection.anchorOffset);
        else range.setStart(selection.anchorNode, selection.anchorOffset);
        return range.toString().length;
      }
      return -1;
    })()`);
    let acknowledged = false;
    {
      let distance = await remaining();
      const started = Date.now();
      for (let step = 0; step <= 2000 && Date.now() - started < 15_000; step++) {
        if (distance === 0) { acknowledged = true; break; }
        if (distance < 0) break;
        await this.pressKey(anchorAfter === 0 ? 'ArrowLeft' : 'ArrowRight', anchorAfter === 0 ? 'ArrowLeft' : 'ArrowRight', anchorAfter === 0 ? 37 : 39);
        let next = await remaining();
        // SmartEditor's hidden input frame applies keyboard navigation on a
        // later render tick. Wait for ACK; do not send another key meanwhile.
        const acknowledgementStarted = Date.now();
        while ((next === distance || next < 0) && Date.now() - acknowledgementStarted < 300) {
          await sleep(20);
          next = await remaining();
        }
        // No movement or leaving the target is not a valid boundary ACK.
        if (next < 0 || next >= distance) break;
        distance = next;
      }
    }
    if (!acknowledged) throw new DebuggerEditorError('upload_images', 'image_caret_unconfirmed', '이미지 삽입 위치의 문단 경계를 확인하지 못했습니다. 본문을 변경하지 않고 중단합니다.');
  }

  private waitForFileChooser(timeoutMs = 10_000): Promise<number> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        debuggerApi.onEvent.removeListener(listener);
        reject(new DebuggerEditorError('upload_images', 'file_chooser_timeout', 'SmartEditor 사진 파일 선택기가 열리지 않았습니다.'));
      }, timeoutMs);
      const listener: DebuggerEvent = (source, method, params) => {
        if (source.tabId !== this.tabId || method !== 'Page.fileChooserOpened') return;
        const backendNodeId = Number(params?.backendNodeId);
        if (!Number.isInteger(backendNodeId) || backendNodeId < 1) return;
        clearTimeout(timeout);
        debuggerApi.onEvent.removeListener(listener);
        resolve(backendNodeId);
      };
      debuggerApi.onEvent.addListener(listener);
    });
  }

  private async editorState(): Promise<EditorState> {
    return await this.evaluate<EditorState>(`(() => {
      const docs = [document];
      for (let i = 0; i < docs.length; i++) for (const frame of docs[i].querySelectorAll('iframe')) {
        try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
      }
      const visible = e => {
        const rect = e.getBoundingClientRect(), style = e.ownerDocument.defaultView.getComputedStyle(e);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const candidates = docs.flatMap(doc => [...doc.querySelectorAll(${JSON.stringify(EDITOR_ROOT_SELECTOR)})])
        .filter(visible).filter(root => !root.parentElement?.closest(${JSON.stringify(EDITOR_ROOT_SELECTOR)}));
      const bodyRoot = candidates.length === 1 ? candidates[0] : null;
      const doc = bodyRoot?.ownerDocument;
      const titleNode = doc && ${JSON.stringify(SELECTORS.title)}.flatMap(s => [...doc.querySelectorAll(s)]).find(visible);
      const paragraphs = bodyRoot ? [...bodyRoot.querySelectorAll(${JSON.stringify(SELECTORS.body.join(','))})]
        .filter(e => !e.closest('.se-section-documentTitle, .se-documentTitle, .se-section-image') && !e.querySelector('.se-placeholder') && (e.innerText || e.textContent || '').replace(/[\\s\\u200b-\\u200d\\ufeff]/g, '')) : [];
      const body = paragraphs.map(e => e.innerText || e.textContent || '').join('\\n');
      const images = bodyRoot ? [...bodyRoot.querySelectorAll('img[src]')].map(image => ({
        source: image.currentSrc || image.src || image.getAttribute('src') || '',
        complete: image.complete && image.naturalWidth > 0,
        anchor_after: paragraphs.filter(p => !!(p.compareDocumentPosition(image) & 4)).length,
      })) : [];
      return {
        title: titleNode && !titleNode.querySelector('.se-placeholder') ? titleNode.innerText || titleNode.textContent || '' : '', body,
        image_count: images.length,
        remote_image_count: images.filter(i => i.complete && /^https:\\/\\/(?:blogfiles|postfiles)\\.pstatic\\.net\\//i.test(i.source)).length,
        images, root_count: candidates.length,
        non_text_count: bodyRoot ? [...bodyRoot.querySelectorAll('.se-component')].filter(e => !e.classList.contains('se-text') && !e.classList.contains('se-documentTitle')).length : 0,
        resume_prompt: docs.some(d => (d.body?.innerText || d.body?.textContent || '').includes('작성 중인 글이 있습니다')),
      };
    })()`);
  }

  private async assertBlankEditor(): Promise<void> {
    if (await this.hasOpenPublishLayer()) throw new DebuggerEditorError('prepare_editor', 'publish_layer_already_open', '발행 확인 화면이 열려 있어 원고를 변경하지 않고 중단했습니다.');
    const state = await this.editorState();
    if (state.root_count !== 1) throw new DebuggerEditorError('prepare_editor', 'editor_root_ambiguous', '활성 편집기를 명확히 구분하지 못했습니다.');
    if (state.resume_prompt || normalize(state.title) || normalize(state.body) || state.image_count || state.non_text_count) {
      throw new DebuggerEditorError('prepare_editor', 'existing_draft_protected', '이미 작성 중인 내용이 있어 변경하지 않고 중단했습니다. 빈 글쓰기 화면을 준비하세요.');
    }
  }

  async uploadImages(
    assets: PublishCommandAsset[],
    loadAsset: (asset: PublishCommandAsset) => Promise<ArrayBuffer>,
  ): Promise<ImageReceipt[]> {
    const receipts: ImageReceipt[] = [];
    const ordered = [...assets].sort((a, b) => a.position - b.position);
    // Transfer the verified bytes, not a native path which could change after hashing.
    for (const asset of ordered) {
      const bytes = await loadAsset(asset);
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== asset.byte_size || hash !== asset.sha256) {
        throw new DebuggerEditorError('upload_images', 'asset_hash_mismatch', '업로드할 이미지 파일이 승인된 원본과 다릅니다.');
      }
      const before = await this.editorState();
      await this.placeImageCaret(asset.anchor_after);
      await this.send('Page.setInterceptFileChooserDialog', { enabled: true });
      const chooser = this.waitForFileChooser();
      // Attach a rejection handler immediately so a failed toolbar click cannot leave an unhandled rejection.
      void chooser.catch(() => undefined);
      try {
        await this.click(SELECTORS.imageButton, 'upload_images', 'image_button_not_found', 'SmartEditor 사진 버튼을 찾지 못했습니다.', {}, 5_000);
        const backendNodeId = await chooser;
        const node = await this.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId });
        if (!node.object?.objectId) throw new DebuggerEditorError('upload_images', 'image_input_not_found', '사진 파일 입력을 찾지 못했습니다.');
        const data = new Uint8Array(bytes);
        let binary = '';
        for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
        const transferred = await this.send<{ result?: { value?: boolean }; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
          objectId: node.object.objectId,
          functionDeclaration: `function(base64, name, mime) {
            if (this.tagName !== 'INPUT' || this.type !== 'file') return false;
            const view = this.ownerDocument.defaultView, binary = view.atob(base64);
            const data = new view.Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
            const transfer = new view.DataTransfer(); transfer.items.add(new view.File([data], name, { type: mime }));
            this.files = transfer.files; this.dispatchEvent(new view.Event('input', { bubbles: true })); this.dispatchEvent(new view.Event('change', { bubbles: true }));
            return this.files.length === 1;
          }`,
          arguments: [{ value: btoa(binary) }, { value: asset.filename }, { value: asset.mime_type }],
          returnByValue: true, userGesture: true,
        });
        if (transferred.exceptionDetails || !transferred.result?.value) throw new DebuggerEditorError('upload_images', 'file_transfer_rejected', '검증된 이미지 파일 전달에 실패했습니다.');
      } finally {
        await this.send('Page.setInterceptFileChooserDialog', { enabled: false });
      }
      const previous = new Set(before.images.map(i => normalizeRemoteImageUrl(i.source)).filter(Boolean));
      let receipt: ImageReceipt | null = null;
      const started = Date.now();
      while (Date.now() - started < 60_000) {
        const state = await this.editorState();
        const added = state.images.filter(i => i.complete && normalizeRemoteImageUrl(i.source) && !previous.has(normalizeRemoteImageUrl(i.source)));
        if (state.root_count === 1 && state.image_count === before.image_count + 1 && added.length === 1) {
          if (JSON.stringify(state.body.split('\n').map(normalize)) !== JSON.stringify(before.body.split('\n').map(normalize))) throw new DebuggerEditorError('upload_images', 'image_paragraph_changed', '이미지 삽입 중 본문 문단이 나뉘거나 변경되어 중단했습니다. 원고를 확인하세요.');
          if (added[0].anchor_after !== asset.anchor_after) throw new DebuggerEditorError('upload_images', 'image_anchor_mismatch', '이미지가 지정한 본문 위치에 삽입되지 않았습니다.');
          receipt = { asset_id: asset.asset_id, sha256: asset.sha256, remote_url: normalizeRemoteImageUrl(added[0].source)! };
          break;
        }
        await sleep(500);
      }
      if (!receipt) throw new DebuggerEditorError('upload_images', 'remote_image_timeout', '네이버 원격 이미지 업로드 완료를 확인하지 못했습니다.');
      receipts.push(receipt);
    }
    return receipts;
  }

  private async pressKey(key: string, code: string, virtualKeyCode: number): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
  }

  private async hasOpenPublishLayer(): Promise<boolean> {
    return await this.evaluate<boolean>(`(() => {
      const docs = [document];
      for (let i = 0; i < docs.length; i++) for (const frame of docs[i].querySelectorAll('iframe')) {
        try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
      }
      const visible = e => {
        for (let node = e; node; node = node.parentElement) {
          const style = node.ownerDocument.defaultView.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        const rect = e.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
      };
      return docs.some(doc => [...doc.querySelectorAll('#tag-input, input.tag_input, .tag_area, [class*="publish_layer"], [class*="publish_popup"]')].some(visible));
    })()`);
  }

  private async openTagLayer(stage: 'input_tags' | 'reopen_verify'): Promise<void> {
    if (await this.hasOpenPublishLayer()) throw new DebuggerEditorError(stage, 'publish_layer_already_open', '이미 발행 확인 화면이 열려 있어 발행 버튼을 누르지 않고 중단했습니다.');
    await this.click(SELECTORS.publishButton, stage, 'publish_toolbar_not_found', '안전한 태그용 툴바 버튼을 찾지 못했습니다.');
  }

  private async readTags(): Promise<string[]> {
    return normalizedTags(await this.evaluate<string[]>(`(() => {
      const docs = [document];
      for (let i = 0; i < docs.length; i++) for (const frame of docs[i].querySelectorAll('iframe')) {
        try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
      }
      return docs.flatMap(doc => [...new Set(${JSON.stringify(SELECTORS.tagChip)}.flatMap(s => [...doc.querySelectorAll(s)]))]).filter(e => {
        const rect = e.getBoundingClientRect(), style = e.ownerDocument.defaultView.getComputedStyle(e);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }).map(e => {
        if (e.hasAttribute('data-tag')) return e.getAttribute('data-tag');
        if (e.id.startsWith('tag-item-') && e.hasAttribute('aria-label')) return e.getAttribute('aria-label');
        const clone = e.cloneNode(true); for (const b of clone.querySelectorAll('button, [role="button"]')) b.remove();
        return clone.textContent || '';
      });
    })()`));
  }

  async inputTags(tags: string[]): Promise<void> {
    if (!tags.length) return;
    const expected = normalizedTags(tags);
    await this.openTagLayer('input_tags');
    try {
      await this.locate(SELECTORS.tagInput, 'input_tags', 'tag_input_not_found', '태그 입력란을 찾지 못했습니다.');
      const existing = await this.readTags();
      if (existing.some(tag => !expected.includes(tag))) throw new DebuggerEditorError('input_tags', 'existing_tags_protected', '요청에 없는 기존 태그를 발견해 변경하지 않았습니다.');
      for (const tag of expected) {
        if ((await this.readTags()).includes(tag)) continue;
        await this.replaceText(SELECTORS.tagInput, tag, 'input_tags', 'tag_input_not_found', '태그 입력란을 찾지 못했습니다.');
        await this.pressKey('Enter', 'Enter', 13);
        const started = Date.now();
        while (!(await this.readTags()).includes(tag) && Date.now() - started < 3_000) await sleep(150);
        if (!(await this.readTags()).includes(tag)) throw new DebuggerEditorError('input_tags', 'tag_readback_mismatch', '입력한 태그의 등록을 확인하지 못했습니다.');
      }
      if (JSON.stringify(await this.readTags()) !== JSON.stringify(expected)) {
        throw new DebuggerEditorError('input_tags', 'tag_readback_mismatch', '입력한 태그가 등록되지 않았거나 다른 태그가 있습니다.');
      }
    } finally {
      await this.pressKey('Escape', 'Escape', 27);
    }
  }

  async saveDraft(): Promise<void> {
    // A changed button label alone may be "saving...". Only a fresh completion
    // signal acknowledges the click; saved content still needs separate reopen verification.
    await this.evaluate(`(() => {
      const context = { ack: false, observers: [] };
      window.__ncosSaveContext = context;
      const selectors = ${JSON.stringify(SELECTORS.saveSuccess)};
      const docs = [document];
      for (let i = 0; i < docs.length; i++) for (const frame of docs[i].querySelectorAll('iframe')) {
        try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
      }
      const before = new Map();
      const fingerprint = e => [e.className, e.textContent, e.getAttribute('style')].join('|');
      for (const doc of docs) for (const s of selectors) for (const e of doc.querySelectorAll(s)) before.set(e, fingerprint(e));
      context.observers = docs.map(doc => {
        const observer = new doc.defaultView.MutationObserver(() => {
          for (const s of selectors) for (const e of doc.querySelectorAll(s)) {
            const rect = e.getBoundingClientRect(), style = doc.defaultView.getComputedStyle(e);
            const changed = !before.has(e) || before.get(e) !== fingerprint(e);
            if (changed && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && /저장.*완료|완료.*저장/.test(e.textContent || '')) context.ack = true;
          }
        });
        observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true }); return observer;
      });
      return true;
    })()`);
    try {
      await this.click(SELECTORS.saveButton, 'draft_save', 'draft_save_not_found', 'SmartEditor 임시저장 버튼을 찾지 못했습니다.');
      const started = Date.now();
      while (Date.now() - started < 8_000) {
        if (await this.evaluate<boolean>('Boolean(window.__ncosSaveContext?.ack)')) return;
        await sleep(200);
      }
      throw new DebuggerEditorError('draft_save', 'draft_save_unconfirmed', '저장 완료 신호를 확인하지 못했습니다. 저장 여부는 재열기 검증이 필요합니다.');
    } finally {
      await this.evaluate('window.__ncosSaveContext?.observers.forEach(o => o.disconnect()); delete window.__ncosSaveContext; true').catch(() => undefined);
    }
  }

  private async dismissResumePrompt(): Promise<boolean> {
    return await this.evaluate<boolean>(`(() => {
      const docs = [document];
      for (let index = 0; index < docs.length; index += 1) {
        for (const frame of docs[index].querySelectorAll('iframe')) {
          try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
        }
      }
      for (const doc of docs) {
        for (const element of doc.querySelectorAll('div,section,aside')) {
          const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ');
          if (!text.includes('작성 중인 글이 있습니다') || !text.includes('이어서 작성하시겠습니까')) continue;
          const cancel = [...element.querySelectorAll('button')].find((button) =>
            (button.innerText || button.textContent || '').trim() === '취소');
          if (cancel) { cancel.click(); return true; }
        }
      }
      return false;
    })()`).catch(() => false);
  }

  async execute(
    command: PublishCommand,
    report: (stage: string, status: 'running' | 'passed', detail?: string, verification?: Record<string, unknown>) => Promise<unknown>,
    loadAsset: (asset: PublishCommandAsset) => Promise<ArrayBuffer>,
  ): Promise<ImageReceipt[]> {
    const step = async (stage: string, action: () => Promise<unknown>, detail = '') => {
      await report(stage, 'running');
      let result: unknown;
      try { result = await action(); }
      catch (error) {
        if (error instanceof DebuggerEditorError) throw error;
        throw new DebuggerEditorError(stage, 'debugger_command_failed', error instanceof Error ? error.message : 'Chrome debugger command failed');
      }
      await report(stage, 'passed', detail, stage === 'upload_images' ? { image_receipts: result } : undefined);
      return result;
    };
    validateCommand(command);
    await this.attach();
    try {
      if (command.resume_stage === 'upload_images') {
        const receipts = await step('upload_images', async () => {
          await this.assertBodyReadyForImages(command);
          return this.uploadImages(command.assets, loadAsset);
        }, 'existing text and empty image set revalidated; remote images confirmed') as ImageReceipt[];
        await step('input_tags', () => this.inputTags(command.tags), 'tag chips confirmed');
        await step('draft_save', () => this.saveDraft(), 'fresh save acknowledgement received; reopen verification required');
        return receipts;
      }
      if (command.resume_stage === 'input_tags') {
        await step('input_tags', async () => {
          await this.assertUploadedContent(command);
          await this.inputTags(command.tags);
        }, 'existing content revalidated; tag chips confirmed');
        await step('draft_save', () => this.saveDraft(), 'fresh save acknowledgement received; reopen verification required');
        return command.image_receipts!;
      }
      await step('health_check', () => this.waitUntilReady());
      await step('prepare_editor', async () => {
        await this.assertBlankEditor();
        await this.dismissPopups();
      });
      await step('input_title', async () => { await this.assertBlankEditor(); await this.inputTitle(command.title); });
      await step('input_body', async () => {
        const state = await this.editorState();
        if (state.root_count !== 1 || normalize(state.body) || state.image_count || normalize(state.title) !== normalize(command.title)) {
          throw new DebuggerEditorError('input_body', 'existing_draft_protected', '본문 입력 전 편집기가 변경되어 중단했습니다.');
        }
        await this.inputBody(command.body);
        const after = await this.editorState();
        if (await contentHash(after.title) !== command.title_hash || await contentHash(after.body) !== command.body_hash) {
          throw new DebuggerEditorError('input_body', 'input_readback_mismatch', '전체 원고 내용이 요청과 다릅니다.');
        }
      });
      const receipts = await step('upload_images', () => this.uploadImages(command.assets, loadAsset), `${command.assets.length} remote images confirmed`) as ImageReceipt[];
      await step('input_tags', () => this.inputTags(command.tags), 'tag chips confirmed');
      await step('draft_save', () => this.saveDraft(), 'fresh save acknowledgement received; reopen verification required');
      return receipts;
    } finally { await this.detach(); }
  }

  private async assertUploadedContent(command: PublishCommand): Promise<void> {
    const state = await this.editorState();
    const receipts = command.image_receipts ?? [];
    const ordered = [...command.assets].sort((a, b) => a.position - b.position);
    const matches = state.root_count === 1 && !state.resume_prompt
      && await contentHash(state.title) === command.title_hash
      && await contentHash(state.body) === command.body_hash
      && receipts.length === ordered.length && state.images.length === ordered.length
      && ordered.every((asset, index) => {
        const receipt = receipts.find(r => r.asset_id === asset.asset_id && r.sha256 === asset.sha256);
        const actual = state.images[index];
        return receipt && actual.complete && normalizeRemoteImageUrl(actual.source)
          && normalizeRemoteImageUrl(actual.source) === normalizeRemoteImageUrl(receipt.remote_url)
          && actual.anchor_after === asset.anchor_after;
      });
    if (!matches) throw new DebuggerEditorError('input_tags', 'resume_content_mismatch', '현재 원고와 업로드 체크포인트가 달라 재입력하지 않고 중단했습니다.');
  }

  private async assertBodyReadyForImages(command: PublishCommand): Promise<void> {
    const state = await this.editorState();
    const paragraphs = (value: string) => value.replace(/\r\n?/g, '\n').split('\n').map(normalize).filter(Boolean);
    const matches = state.root_count === 1 && !state.resume_prompt && !state.image_count && !state.non_text_count
      && await contentHash(state.title) === command.title_hash && await contentHash(state.body) === command.body_hash
      && JSON.stringify(paragraphs(state.body)) === JSON.stringify(paragraphs(command.body));
    if (!matches || await this.hasOpenPublishLayer()) throw new DebuggerEditorError('upload_images', 'resume_content_mismatch', '현재 본문이 다르거나 일부 이미지가 있어 자동 재입력하지 않고 중단했습니다. 원고를 확인하세요.');
  }

  private async reopenFromDraftList(title: string): Promise<void> {
    // Never accept an already-open matching title as proof of a saved draft.
    const startedOpening = Date.now();
    let requested = false;
    while (Date.now() - startedOpening < 8_000) {
      // Recovery UI may arrive after the editor fields are already ready.
      // A single early check + click can hit its backdrop instead of the list.
      if (await this.dismissResumePrompt()) requested = false;
      if (!requested) {
        await this.click(SELECTORS.savedDraftListButton, 'reopen_verify', 'draft_list_button_not_found', '임시저장된 글 목록 버튼을 찾지 못했습니다.', {}, 8_000);
        requested = true;
      }
      const list = await this.evaluate<boolean>(this.elementExpression(SELECTORS.savedDraftItem));
      if (list) break;
      await sleep(250);
    }
    await this.click(
      SELECTORS.savedDraftItem,
      'reopen_verify',
      'saved_draft_not_found',
      '목록에서 저장한 제목을 고유하게 찾지 못했습니다.',
      { textIncludes: title, unique: true },
      12_000,
    );
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      if (normalize((await this.editorState()).title) === normalize(title)) return;
      await sleep(400);
    }
    throw new DebuggerEditorError('reopen_verify', 'saved_draft_open_timeout', '임시저장 글을 다시 여는 데 실패했습니다.');
  }

  async verify(command: PublishCommand): Promise<Record<string, unknown>> {
    await this.attach();
    try {
      await this.waitUntilReady();
      await this.reopenFromDraftList(command.title);
      // Reopened off-screen images initially render a data: SVG placeholder.
      // Bring each pending image into view and wait for its real remote bytes;
      // never treat the placeholder or an expected URL as observed evidence.
      const imageWaitStarted = Date.now();
      while (true) {
        const loaded = await this.editorState();
        if (loaded.root_count !== 1 || loaded.image_count !== command.assets.length) break;
        if (loaded.remote_image_count === command.assets.length) break;
        if (Date.now() - imageWaitStarted >= 20_000) break;
        await this.evaluate(`(() => {
          const docs = [document];
          for (let i = 0; i < docs.length; i++) for (const f of docs[i].querySelectorAll('iframe')) {
            try { if (f.contentDocument && !docs.includes(f.contentDocument)) docs.push(f.contentDocument); } catch (_) {}
          }
          for (const doc of docs) for (const root of doc.querySelectorAll(${JSON.stringify(EDITOR_ROOT_SELECTOR)})) {
            const pending = [...root.querySelectorAll('img[src]')].find(i => !i.complete || !i.naturalWidth || !/^https:\\/\\/(?:blogfiles|postfiles)\\.pstatic\\.net\\//i.test(i.currentSrc || i.src));
            if (pending) { pending.scrollIntoView({ block: 'center' }); return true; }
          }
          return false;
        })()`);
        await sleep(250);
      }
      const state = await this.editorState();
      const actualTitleHash = await contentHash(state.title);
      const actualBodyHash = await contentHash(state.body);
      const expected = command.image_receipts ?? [];
      if (state.root_count !== 1 || expected.length !== command.assets.length || state.images.length !== expected.length) {
        throw new DebuggerEditorError('reopen_verify', 'image_receipts_mismatch', '저장된 이미지 구성이 요청과 다릅니다.');
      }
      const imageReceipts = command.assets.map(asset => {
        const receipt = expected.find(r => r.asset_id === asset.asset_id && r.sha256 === asset.sha256);
        const matches = receipt ? state.images.filter(i => i.complete && normalizeRemoteImageUrl(i.source) === normalizeRemoteImageUrl(receipt.remote_url)) : [];
        if (!receipt || matches.length !== 1 || matches[0].anchor_after !== asset.anchor_after) {
          throw new DebuggerEditorError('reopen_verify', 'image_receipts_mismatch', '재열기 이미지 원본 또는 본문 위치가 일치하지 않습니다.');
        }
        return { asset_id: asset.asset_id, sha256: asset.sha256, remote_url: normalizeRemoteImageUrl(matches[0].source)! };
      });
      const paragraphs = (value: string) => value.replace(/\r\n?/g, '\n').split('\n').map(normalize).filter(Boolean);
      if (JSON.stringify(paragraphs(state.body)) !== JSON.stringify(paragraphs(command.body))) {
        throw new DebuggerEditorError('reopen_verify', 'body_structure_mismatch', '재열기 본문의 문단 구성이 원고와 달라 저장 검증을 통과하지 못했습니다.');
      }
      await this.openTagLayer('reopen_verify');
      let actualTags: string[];
      try {
        await this.locate(SELECTORS.tagInput, 'reopen_verify', 'tag_input_not_found', '저장된 태그 입력란을 찾지 못했습니다.');
        actualTags = await this.readTags();
      } finally { await this.pressKey('Escape', 'Escape', 27); }
      if (JSON.stringify(actualTags) !== JSON.stringify(normalizedTags(command.tags))) {
        throw new DebuggerEditorError('reopen_verify', 'tags_mismatch', '저장된 태그가 요청과 일치하지 않습니다.');
      }
      return {
        actual_tags: actualTags,
        image_receipts: imageReceipts,
        asset_manifest_hash: command.asset_manifest_hash,
        actual_title_hash: actualTitleHash,
        actual_body_hash: actualBodyHash,
        body_chars: state.body.length,
        image_count: state.image_count,
        remote_image_count: state.remote_image_count,
        title_hash_match: actualTitleHash === command.title_hash,
        body_hash_match: actualBodyHash === command.body_hash,
        verified_url: (await browser.tabs.get(this.tabId)).url ?? '',
      };
    } finally {
      await this.detach();
    }
  }
}
