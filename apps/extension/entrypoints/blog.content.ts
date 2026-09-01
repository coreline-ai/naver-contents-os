import { browser } from 'wxt/browser';
import { MSG_GET_BLOG } from '~/lib/messages';
import { parseBlogPost } from '~/lib/parsers/blog';

export default defineContentScript({
  matches: ['*://blog.naver.com/*'],
  allFrames: true, // the post body lives in the mainFrame iframe (docs/05 dual path)
  main() {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== MSG_GET_BLOG) return false;
      const parsed = parseBlogPost(document);
      if (!parsed.found) return false; // let the frame that has the post answer
      sendResponse(parsed);
      return false;
    });
  },
});
