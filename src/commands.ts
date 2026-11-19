// Typed map of the Rust commands the renderer calls. Argument and result
// shapes come from src/generated/ipc-types.ts; src/tests/commands.contract.test.ts
// checks the names against the command list in src-tauri/build.rs.
import { invoke } from '@tauri-apps/api/core';
import type * as Ipc from './generated/ipc-types';

/** Envelope every `IpcResult<T>` command serializes to. */
export type Envelope<T> = { ok: true; data: T } | { ok: false; error: Ipc.IpcError };

/** Error thrown when a command answers `{ ok: false, error }`. */
export class CommandError extends Error {
  readonly code: string;
  readonly details: string | null;

  constructor(error: Ipc.IpcError) {
    super(error.message);
    this.name = 'CommandError';
    this.code = error.code;
    this.details = error.details ?? null;
  }
}

export interface Commands {
  get_settings: { args: void; result: Ipc.AppSettings };
  get_default_settings: { args: void; result: Ipc.AppSettings };
  save_settings: { args: { settings: SaveSettingsInput }; result: void };
  reset_settings: { args: void; result: Ipc.AppSettings };
  start_conversion_queue: {
    args: { payload: Ipc.StartConversionQueuePayload };
    result: Ipc.QueueSnapshot;
  };
  cancel_conversion: { args: { force?: boolean }; result: void };
  get_queue_snapshot: { args: void; result: Ipc.QueueSnapshot | null };
  select_output_directory: { args: void; result: string | null };
  select_input_files: { args: void; result: string[] };
  get_file_info: { args: { filePath: string }; result: Ipc.VideoInfo | null };
  get_presets: { args: void; result: Ipc.RendererPreset[] };
  get_gpu_capabilities: {
    args: { requestedCodec?: Ipc.GpuCodec | null };
    result: Ipc.GPUCapabilitiesPayload;
  };
  refresh_gpu_capabilities: { args: void; result: void };
  check_ffmpeg: { args: void; result: Ipc.FFmpegStatus };
  get_app_platform: { args: void; result: string };
  get_distribution_channel: { args: void; result: string };
  get_system_theme: { args: void; result: 'dark' | 'light' };
  open_external: { args: { url: string }; result: void };
  reveal_path: { args: { filePath: string }; result: void };
  restart_app: { args: void; result: void };
  set_conversion_menu_state: { args: { state: Ipc.ConversionMenuStatePayload }; result: void };
  log_error: { args: { message: string }; result: void };
  mark_main_window_ready: { args: void; result: void };
  notify_settings_flushed: { args: { generation: number }; result: void };
  check_for_updates: { args: void; result: void };
  download_update: { args: void; result: void };
  install_update: { args: void; result: void };
  cancel_update_download: { args: void; result: void };
  set_update_channel: { args: { channel: Ipc.UpdateChannel }; result: void };
}

/** Partial settings patch, as v1's SaveSettingsPayload accepted. The update
 * channel has its own command so the updater engine observes the transition. */
export type SaveSettingsInput = Omit<
  Partial<Ipc.AppSettings>,
  'uiPanels' | 'updateChannel' | 'settingsSchemaVersion'
> & {
  uiPanels?: Partial<Ipc.UIPanelSettings>;
  /** Legacy v1 alias, normalized to useSystemFfmpeg by the backend. */
  useSystemFFmpeg?: boolean;
};

export type CommandName = keyof Commands;
export type CommandArgs<K extends CommandName> = Commands[K]['args'] extends void
  ? []
  : [Commands[K]['args']];

// Rust answers IpcResult<T> with an envelope; a few commands return plain
// values instead, so only envelope-shaped results are unwrapped.
function unwrap<T>(result: unknown): T {
  if (result && typeof result === 'object' && 'ok' in result) {
    const envelope = result as Envelope<T>;
    if (envelope.ok) return envelope.data;
    throw new CommandError(envelope.error);
  }
  return result as T;
}

/** Calls a Rust command with its typed arguments; envelopes are unwrapped. */
export function call<K extends CommandName>(
  command: K,
  ...args: CommandArgs<K>
): Promise<Commands[K]['result']> {
  const [payload] = args;
  const invocation =
    payload === undefined
      ? invoke<Commands[K]['result']>(command)
      : invoke<Commands[K]['result']>(command, payload as Record<string, unknown>);
  return invocation.then(unwrap) as Promise<Commands[K]['result']>;
}

/** Calls a Rust command without waiting; failures are logged to the console. */
export function fire<K extends CommandName>(command: K, ...args: CommandArgs<K>): void {
  call(command, ...args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[conv2] ${command}: ${message}`);
  });
}
