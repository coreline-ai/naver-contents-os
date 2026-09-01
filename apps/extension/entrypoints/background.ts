export default defineBackground(() => {
  // Toolbar click opens the side panel.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
