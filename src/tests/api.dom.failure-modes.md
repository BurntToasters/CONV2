# Renderer api surface: failure modes

`src/api.ts` replaces the v1 preload bridge (`window.electronAPI`). These are
the ways the port could break the engine; `api.dom.test.ts` checks each.

1. A v1 method vanishes in the port: the engine call site throws
   "api.X is not a function" at runtime, on a path tests rarely hit.
2. An obsolete v1 method survives (getPathForFile, getLicenses,
   onWindowChromeStyle): the webview cannot honor it and dead surface grows.
3. A rename misses its engine call site (getDefaultAdvancedFormatSettings ->
   getDefaultSettings, isUpdatesDisabled -> getDistributionChannel).
4. A NEW method is dropped (selectInputFiles, cancelUpdateDownload,
   setUpdateChannel, startDragging, onDragDropEvent) and its call site fails.
5. A command-backed method routes to the wrong Rust command name, which only
   fails at runtime with "command not found"; envelopes must unwrap, not
   pass through.
