import { browser } from 'wxt/browser';

export default defineBackground(() => {
  // Toolbar click opens the side panel.
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
