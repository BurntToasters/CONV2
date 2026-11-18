// Generated from src-tauri/src/types.rs by the ts_bindings test. Do not edit.

export type GpuVendor = "nvidia" | "amd" | "intel" | "qualcomm" | "apple" | "cpu";

export type GpuMode = "auto" | "manual";

export type GpuCodec = "h264" | "h265" | "av1";

export type QueueItemStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export type ThemePreference = "system" | "dark" | "light" | "custom";

export type CustomThemeId = "midnight-blue" | "high-contrast-dark";

export type InterfaceStyle = "glass" | "flat";

export type UpdateChannel = "auto" | "stable" | "beta";

export type GifLoopMode = "forever" | "once";

export type GifDither = "sierra2_4a" | "floyd_steinberg" | "bayer" | "none";

export type VideoPreset = "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow" | "placebo";

export type AviCodec = "h264" | "h265";

export type UpdatePhase = "checking" | "available" | "not-available" | "downloading" | "downloaded" | "installing" | "error" | "disabled" | "already-checking";

export type FFmpegStatusReason = "ok" | "missing" | "verification-failed" | "not-runnable";

export type UIPanelSettings = { presetExpanded: boolean, gpuExpanded: boolean, };

export type GifTierSettings = { fps: number, maxDimension: number, maxColors: number, dither: GifDither, };

export type GifTierCollection = { bestQuality: GifTierSettings, quality: GifTierSettings, balanced: GifTierSettings, bestCompression: GifTierSettings, };

export type GifAdvancedSettings = { loopMode: GifLoopMode, tiers: GifTierCollection, };

export type WebpTierSettings = { fps: number, maxDimension: number, quality: number, };

export type WebpTierCollection = { bestQuality: WebpTierSettings, quality: WebpTierSettings, balanced: WebpTierSettings, bestCompression: WebpTierSettings, };

export type WebpAdvancedSettings = { loopMode: GifLoopMode, tiers: WebpTierCollection, };

export type Av1TierSettings = { quality: number, cpuPreset: number, audioBitrateKbps: number, };

export type Av1TierCollection = { bestQuality: Av1TierSettings, quality: Av1TierSettings, balanced: Av1TierSettings, bestCompression: Av1TierSettings, compression: Av1TierSettings, };

export type Av1AdvancedSettings = { tiers: Av1TierCollection, };

export type H264TierSettings = { quality: number, preset: VideoPreset, audioBitrateKbps: number, };

export type H264TierCollection = { fast: H264TierSettings, quality: H264TierSettings, };

export type H264AdvancedSettings = { tiers: H264TierCollection, };

export type H265TierSettings = { quality: number, preset: VideoPreset, audioBitrateKbps: number, useAdvancedParams: boolean, };

export type H265TierCollection = { bestQuality: H265TierSettings, quality: H265TierSettings, balanced: H265TierSettings, bestCompression: H265TierSettings, };

export type H265AdvancedSettings = { tiers: H265TierCollection, };

export type AviTierSettings = { codec: AviCodec, quality: number, preset: VideoPreset, audioBitrateKbps: number, useAdvancedParams: boolean, };

export type AviTierCollection = { bestQuality: AviTierSettings, bestCompression: AviTierSettings, balanced: AviTierSettings, };

export type AviAdvancedSettings = { tiers: AviTierCollection, };

export type AdvancedFormatSettings = { gif: GifAdvancedSettings, webp: WebpAdvancedSettings, av1: Av1AdvancedSettings, h264: H264AdvancedSettings, h265: H265AdvancedSettings, avi: AviAdvancedSettings, };

export type AppSettings = { settingsSchemaVersion: number, outputDirectory: string, gpu: GpuVendor, gpuMode: GpuMode, gpuManualVendor: GpuVendor, theme: ThemePreference, customTheme: CustomThemeId, interfaceStyle: InterfaceStyle, showDebugOutput: boolean, autoCheckUpdates: boolean, useSystemFfmpeg: boolean, useCpuDecodingWhenGpu: boolean, moveOriginalToTrashOnSuccess: boolean, updateChannel: UpdateChannel, showAdvancedPresets: boolean, removeSpacesFromFilenames: boolean, showAllGpuVendors: boolean, notifyOnConversionComplete: boolean, preventSleepWhileConverting: boolean, setupWizardCompleted: boolean, recentPresetIds: Array<string>, uiPanels: UIPanelSettings, advancedFormatSettings: AdvancedFormatSettings, };

export type QueueItemSnapshot = { id: string, inputPath: string, fileName: string, status: QueueItemStatus, error?: string | null, 
/**
 * Raw FFmpeg stderr tail (paths redacted) for the Details view.
 */
errorDetail?: string | null, outputPath?: string | null, usedCpuFallback?: boolean | null, };

export type QueueSnapshot = { active: boolean, presetId: string, currentIndex: number, total: number, items: Array<QueueItemSnapshot>, };

export type ConversionProgress = { percent: number, frame: number, fps: number, time: string, bitrate: string, speed: string, };

export type VideoInfo = { duration: number, size: number, width: number, height: number, codec: string, format: string, pixFmt?: string | null, colorPrimaries?: string | null, colorTransfer?: string | null, colorSpace?: string | null, colorRange?: string | null, 
/**
 * First audio stream's codec, used for remux container compatibility.
 */
audioCodec?: string | null, 
/**
 * Codec names of every subtitle stream, in subtitle-stream order.
 */
subtitleCodecs?: Array<string> | null, 
/**
 * Channel count of every audio stream, in audio-stream order (0 when unknown).
 */
audioChannels?: Array<number> | null, 
/**
 * False when the probe found no video stream (audio-only files).
 */
hasVideo?: boolean | null, };

export type GPUCapabilityStatus = { available: boolean, reason: string, encoder: string, };

export type GPUCapabilitiesPayload = { platform: string, requestedCodec: GpuCodec | null, checkedCodecs: Array<GpuCodec>, matrix: { [key in string]: { [key in string]: GPUCapabilityStatus } }, recommendedVendor: GpuVendor, recommendationReason: string, };

export type UpdateStatePayload = { phase: UpdatePhase, manual: boolean, message?: string | null, percent?: number | null, };

export type FFmpegStatus = { ok: boolean, reason: FFmpegStatusReason, usingBundled: boolean, };

export type RendererPreset = { id: string, name: string, description: string, category: string, categoryLabel: string, categoryOrder: number, isAdvanced: boolean, extension: string, 
/**
 * AVI preset tier name, or null for every non-AVI preset.
 */
aviTier: string | null, };

export type StartConversionQueuePayload = { inputPaths: Array<string>, presetId: string, gpu: GpuVendor, removeSpacesFromFilenames?: boolean | null, outputDirectory?: string | null, showDebugOutput?: boolean | null, };

export type GPUEncoderError = { type: "encoder_unavailable" | "gpu_capability" | "driver_error" | "unknown", message: string, details: string, suggestion: string, canRetryWithCPU: boolean, codec?: string | null, gpu?: GpuVendor | null, };

export type ConversionMenuStatePayload = { converting: boolean, hasOutput: boolean, };

export type IpcError = { code: "VALIDATION_ERROR" | "INVALID_PATH" | "NOT_AVAILABLE" | "INTERNAL_ERROR", message: string, details?: string | null, };
