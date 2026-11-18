// Ambient global declarations for the renderer. IPC payload shapes come from
// src/generated/ipc-types.ts, command names from src/commands.ts, and the API
// object from src/api.ts.

interface Window {
  __CONV2_RENDERER_STARTUP_READY__: Promise<void>;
}
