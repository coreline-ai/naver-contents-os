// Runs before styles/React under script-src 'self'. Keep the preference contract
// aligned with src/theme.ts (the bootstrap contract is covered by theme tests).
(function () {
  var preference = 'system';
  try {
    var saved = localStorage.getItem('ncos-web-theme');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch (_) { /* Storage may be disabled; use the device preference. */ }
  var dark = false;
  try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (_) {}
  document.documentElement.dataset.theme = preference === 'system' ? (dark ? 'dark' : 'light') : preference;
}());
