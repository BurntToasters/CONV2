// Applies the persisted theme before the stylesheet loads to avoid a
// flash of the wrong theme. Loaded as an external 'self' script so it runs
// under the page CSP (script-src 'self'); an inline script would be blocked.
// The renderer writes the same localStorage keys when it applies the theme.
(function () {
  try {
    var theme = localStorage.getItem('theme');
    if (theme !== 'dark' && theme !== 'light' && theme !== 'custom') {
      theme = 'system';
    }
    if (theme === 'system') {
      theme =
        window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    } else if (theme === 'custom') {
      theme =
        localStorage.getItem('customTheme') === 'high-contrast-dark'
          ? 'high-contrast-dark'
          : 'midnight-blue';
    }
    document.documentElement.dataset.theme = theme;

    document.documentElement.dataset.uiStyle =
      localStorage.getItem('interfaceStyle') === 'flat' ? 'flat' : 'glass';
  } catch (e) {}
})();
