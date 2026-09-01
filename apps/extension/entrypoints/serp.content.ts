import { MSG_GET_SERP } from '~/lib/messages';
import { parseSerp } from '~/lib/parsers/serp';

export default defineContentScript({
  matches: ['*://search.naver.com/*'],
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== MSG_GET_SERP) return false;
      // Parser never throws: DOM changes degrade to { ok: false } (docs/12).
      sendResponse(parseSerp(document, location.href));
      return false;
    });
  },
});
