import type { PublishCommand, PublishCommandAsset } from '@ncos/contracts';
import { browser } from 'wxt/browser';

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
  publishButton: [
    'button.publish_btn__WEpYf',
    'button[class^="publish_btn__"]',
    'button[class*=" publish_btn__"]',
    'button[data-click-area="tpb.publish"]',
  ],
  tagInput: ['#tag-input', 'input.tag_input', '.tag_area input'],
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
  closeHelp: ['button.se-help-panel-close-button', '.se-popup-button-cancel', 'button[data-name="close"]'],
} as const;

export class DebuggerEditorError extends Error {
  constructor(public stage: string, public code: string, message: string) {
    super(message);
  }
}

type ElementInfo = { x: number; y: number; text: string; tag: string };
type EditorState = { title: string; body: string; image_count: number; remote_image_count: number };

function normalize(value: string): string {
  return (value || '').replace(/[\s\u200b-\u200d\ufeff]+/g, '');
}

async function contentHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalize(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
    options: { focus?: boolean; selectContents?: boolean; textIncludes?: string; closestClickable?: boolean } = {},
  ): string {
    return `(() => {
      const selectors = ${JSON.stringify(selectors)};
      const textIncludes = ${JSON.stringify(options.textIncludes ?? '')};
      const roots = [];
      const visit = (doc, offsetX, offsetY) => {
        roots.push({ doc, offsetX, offsetY });
        for (const frame of doc.querySelectorAll('iframe')) {
          try {
            if (!frame.contentDocument) continue;
            const rect = frame.getBoundingClientRect();
            visit(frame.contentDocument, offsetX + rect.left, offsetY + rect.top);
          } catch (_) {}
        }
      };
      visit(document, 0, 0);
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
          candidates = [...root.doc.querySelectorAll('button,a,[role="button"],li,div,span,p')];
        }
        let element = candidates.find((candidate) => visible(candidate)
          && (!textIncludes || (candidate.innerText || candidate.textContent || '').replace(/\\s+/g, ' ').includes(textIncludes)));
        if (!element) continue;
        if (${Boolean(options.closestClickable)}) {
          element = element.closest('button,a,[role="button"],li') || element;
        }
        element.scrollIntoView({ block: 'center', inline: 'center' });
        if (${Boolean(options.focus)}) element.focus({ preventScroll: true });
        if (${Boolean(options.selectContents)}) {
          const selection = element.ownerDocument.getSelection();
          const range = element.ownerDocument.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const rect = element.getBoundingClientRect();
        return {
          x: root.offsetX + rect.left + rect.width / 2,
          y: root.offsetY + rect.top + rect.height / 2,
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
    options: { focus?: boolean; selectContents?: boolean; textIncludes?: string; closestClickable?: boolean } = {},
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
    options: { textIncludes?: string; closestClickable?: boolean } = {},
    timeoutMs = 15_000,
  ): Promise<void> {
    await this.clickPoint(await this.locate(selectors, stage, code, message, options, timeoutMs));
  }

  private async selectAllAndInsert(value: string): Promise<void> {
    // locate(..., selectContents: true) already scopes the selection to the
    // requested title/body node. Meta+A would expand it to the whole editor
    // document and can erase the title while replacing the body.
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    });
    await this.send('Input.insertText', { text: value });
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
            return element.innerText || element.textContent || '';
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
    await this.locate(selectors, stage, code, message, { focus: true, selectContents: true });
    await this.selectAllAndInsert(value);
    const expected = normalize(value);
    const started = Date.now();
    while (Date.now() - started < 3_000) {
      if (normalize(await this.readText(selectors)) === expected) return;
      await sleep(200);
    }
    // SmartEditor updates its visible React tree before every duplicate DOM
    // reader is synchronized. Do not fail on this advisory read-back: the
    // mandatory reopen verification compares exact title/body hashes after the
    // draft has been saved and remains the authoritative acceptance gate.
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
    const placed = await this.evaluate<boolean>(`(() => {
      try {
      const selectors = ${JSON.stringify(SELECTORS.bodyContainer)};
      const docs = [document];
      for (let index = 0; index < docs.length; index += 1) {
        for (const frame of docs[index].querySelectorAll('iframe')) {
          try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
        }
      }
      for (const doc of docs) {
        let container = null;
        for (const selector of selectors) { container = doc.querySelector(selector); if (container) break; }
        if (!container) continue;
        const paragraphs = [...container.querySelectorAll('.se-text-paragraph,p,[contenteditable="true"]')];
        const target = paragraphs[Math.min(Math.max(${anchorAfter} - 1, 0), Math.max(paragraphs.length - 1, 0))] || container;
        target.focus({ preventScroll: true });
        const range = target.ownerDocument.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        const selection = target.ownerDocument.getSelection();
        if (!selection) return false;
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      }
      return false;
      } catch (_) {
        return false;
      }
    })()`).catch(() => false);
    if (!placed) {
      await this.locate(
        SELECTORS.body,
        'upload_images',
        'image_anchor_not_found',
        '이미지를 넣을 본문 위치를 찾지 못했습니다.',
        { focus: true },
        5_000,
      );
    }
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
      for (let index = 0; index < docs.length; index += 1) {
        for (const frame of docs[index].querySelectorAll('iframe')) {
          try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
        }
      }
      const read = (selectors) => {
        for (const doc of docs) for (const selector of selectors) {
          for (const element of doc.querySelectorAll(selector)) {
            const view = element.ownerDocument && element.ownerDocument.defaultView;
            const rect = element.getBoundingClientRect();
            if (!view || !(element instanceof view.HTMLElement)) continue;
            const style = view.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) continue;
            return element.innerText || element.textContent || '';
          }
        }
        return '';
      };
      const readBody = () => {
        for (const doc of docs) for (const selector of ${JSON.stringify(SELECTORS.body)}) {
          const values = [];
          for (const element of doc.querySelectorAll(selector)) {
            const view = element.ownerDocument && element.ownerDocument.defaultView;
            const rect = element.getBoundingClientRect();
            if (!view || !(element instanceof view.HTMLElement)) continue;
            const style = view.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) continue;
            if (element.closest('.se-section-documentTitle, .se-section-image')) continue;
            const value = element.innerText || element.textContent || '';
            if (!element.querySelector('.se-placeholder')) values.push(value);
          }
          if (values.some((value) => value.trim())) return values.join('\\n');
        }
        return '';
      };
      let images = [];
      for (const doc of docs) {
        let body = null;
        for (const selector of ${JSON.stringify(SELECTORS.bodyContainer)}) { body = doc.querySelector(selector); if (body) break; }
        if (body) images.push(...body.querySelectorAll('img[src]'));
        // SmartEditor may keep multiple editor roots while React is
        // synchronizing. The first .se-main-container can be a stale root,
        // while the uploaded image is already visible in the active root.
        images.push(...doc.querySelectorAll('img.se-image-resource[src], img[src*=".pstatic.net/"]'));
      }
      const sources = [...new Set(images.map((image) => image.currentSrc || image.src || image.getAttribute('src') || ''))];
      return {
        title: read(${JSON.stringify(SELECTORS.title)}),
        body: readBody(),
        image_count: sources.length,
        remote_image_count: sources.filter((source) => {
          const value = String(source).toLowerCase();
          return value.startsWith('https://') && value.includes('.pstatic.net/');
        }).length,
      };
    })()`);
  }

  private async hasUploadedAsset(sha256: string): Promise<boolean> {
    return await this.evaluate<boolean>(`(() => {
      const expected = ${JSON.stringify(sha256.toLowerCase())};
      const docs = [document];
      for (let index = 0; index < docs.length; index += 1) {
        for (const frame of docs[index].querySelectorAll('iframe')) {
          try { if (frame.contentDocument && !docs.includes(frame.contentDocument)) docs.push(frame.contentDocument); } catch (_) {}
        }
      }
      for (const doc of docs) {
        // Search every image rather than only the first matching body root.
        // SmartEditor can retain a stale .se-main-container during updates.
        for (const image of doc.querySelectorAll('img')) {
          if (String(image.outerHTML || '').toLowerCase().includes(expected)) return true;
        }
      }
      return false;
    })()`).catch(() => false);
  }

  async uploadImages(assets: PublishCommandAsset[]): Promise<void> {
    const ordered = [...assets].sort((left, right) => left.position - right.position);
    for (const [index, asset] of ordered.entries()) {
      if (!asset.native_path) {
        throw new DebuggerEditorError('upload_images', 'asset_native_path_missing', `이미지 ${index + 1}의 로컬 파일 경로가 없습니다.`);
      }
      if (await this.hasUploadedAsset(asset.sha256)) continue;
      const before = (await this.editorState()).image_count;
      await this.placeImageCaret(asset.anchor_after);
      await this.send('Page.setInterceptFileChooserDialog', { enabled: true });
      const chooser = this.waitForFileChooser();
      try {
        await this.click(
          SELECTORS.imageButton,
          'upload_images',
          'image_button_not_found',
          'SmartEditor 사진 버튼을 찾지 못했습니다.',
          {},
          3_000,
        );
      } catch (error) {
        if (!(error instanceof DebuggerEditorError) || error.code !== 'image_button_not_found') throw error;
        await this.click(
          [],
          'upload_images',
          'image_button_not_found',
          'SmartEditor 사진 버튼을 찾지 못했습니다.',
          { textIncludes: '사진 추가', closestClickable: true },
          5_000,
        );
      }
      const backendNodeId = await chooser;
      await this.send('DOM.setFileInputFiles', { files: [asset.native_path], backendNodeId });
      await this.send('Page.setInterceptFileChooserDialog', { enabled: false });
      const started = Date.now();
      while (Date.now() - started < 60_000) {
        if (await this.hasUploadedAsset(asset.sha256)) break;
        if ((await this.editorState()).image_count >= before + 1) break;
        await sleep(500);
      }
      if (!(await this.hasUploadedAsset(asset.sha256)) && (await this.editorState()).image_count < before + 1) {
        throw new DebuggerEditorError('upload_images', 'remote_image_timeout', `이미지 ${index + 1}의 네이버 업로드 완료를 확인하지 못했습니다.`);
      }
    }
  }

  private async pressKey(key: string, code: string, virtualKeyCode: number): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
  }

  async inputTags(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    await this.click(SELECTORS.publishButton, 'input_tags', 'publish_layer_not_found', '태그 입력 화면을 열지 못했습니다.');
    for (const tag of tags.slice(0, 10)) {
      await this.locate(SELECTORS.tagInput, 'input_tags', 'tag_input_not_found', '태그 입력란을 찾지 못했습니다.', { focus: true, selectContents: true }, 8_000);
      await this.selectAllAndInsert(tag.replace(/\s+/g, ''));
      await this.pressKey('Enter', 'Enter', 13);
      await sleep(150);
    }
    await this.pressKey('Escape', 'Escape', 27);
  }

  async saveDraft(): Promise<void> {
    await this.click(SELECTORS.saveButton, 'draft_save', 'draft_save_not_found', 'SmartEditor 임시저장 버튼을 찾지 못했습니다.');
    await sleep(3_000);
  }

  private async dismissResumePrompt(): Promise<void> {
    await this.evaluate(`(() => {
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
    await sleep(300);
  }

  async execute(
    command: PublishCommand,
    report: (stage: string, status: 'running' | 'passed', detail?: string) => Promise<unknown>,
  ): Promise<void> {
    const step = async (stage: string, action: () => Promise<void>, detail = '') => {
      await report(stage, 'running');
      try {
        await action();
      } catch (error) {
        if (error instanceof DebuggerEditorError) throw error;
        throw new DebuggerEditorError(
          stage,
          'debugger_command_failed',
          error instanceof Error ? error.message : 'Chrome debugger command failed',
        );
      }
      await report(stage, 'passed', detail);
    };
    await this.attach();
    try {
      await step('health_check', () => this.waitUntilReady());
      await step('prepare_editor', () => this.dismissPopups());
      await step('input_title', () => this.inputTitle(command.title));
      await step('input_body', () => this.inputBody(command.body));
      await step('upload_images', () => this.uploadImages(command.assets), `${command.assets.length} images uploaded to Naver`);
      await step('input_tags', () => this.inputTags(command.tags), `${command.tags.length} tags entered`);
      await step('draft_save', () => this.saveDraft(), 'temporary save control clicked');
    } finally {
      await this.detach();
    }
  }

  private async reopenFromDraftList(title: string): Promise<void> {
    const before = await this.editorState();
    if (normalize(before.title) === normalize(title)) return;
    await this.dismissResumePrompt();
    await this.click(
      SELECTORS.savedDraftListButton,
      'reopen_verify',
      'draft_list_button_not_found',
      '임시저장된 글 목록 버튼을 찾지 못했습니다.',
      {},
      8_000,
    );
    await sleep(500);
    await this.click(
      [],
      'reopen_verify',
      'saved_draft_not_found',
      '방금 저장한 임시 글을 목록에서 찾지 못했습니다.',
      { textIncludes: title, closestClickable: true },
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
      const state = await this.editorState();
      const actualTitleHash = await contentHash(state.title);
      const actualBodyHash = await contentHash(state.body);
      return {
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
