// Type-only import: keeps this module free of a runtime dependency on presets.ts
// so presets.ts can import GPU_ENCODERS without creating a require cycle.
import type { GPUCodec, GPUVendor } from './presets';

/**
 * Single source of truth for encoder names, shared by the FFmpeg runner, the
 * capability probe, and preset argument construction. Anything that resolves an
 * encoder must read this map: a second copy would let the probe validate one
 * encoder while the conversion invokes another.
 */
export const GPU_ENCODERS: Record<string, Record<GPUVendor, string>> = {
  h264: {
    nvidia: 'h264_nvenc',
    amd: 'h264_amf',
    intel: 'h264_qsv',
    qualcomm: 'h264_mf',
    apple: 'h264_videotoolbox',
    cpu: 'libx264',
  },
  h265: {
    nvidia: 'hevc_nvenc',
    amd: 'hevc_amf',
    intel: 'hevc_qsv',
    qualcomm: 'hevc_mf',
    apple: 'hevc_videotoolbox',
    cpu: 'libx265',
  },
  av1: {
    nvidia: 'av1_nvenc',
    amd: 'av1_amf',
    intel: 'av1_qsv',
    qualcomm: 'av1_mf',
    apple: 'libsvtav1',
    cpu: 'libsvtav1',
  },
};

const VAAPI_ENCODERS: Record<string, string> = {
  h264: 'h264_vaapi',
  h265: 'hevc_vaapi',
  av1: 'av1_vaapi',
};

/** Linux Intel and AMD encode through VAAPI instead of Quick Sync or AMF. */
export const usesVaapi = (gpu: GPUVendor, platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'linux' && (gpu === 'intel' || gpu === 'amd');

/** Encoder name for a codec and vendor. Linux Intel/AMD resolve to VAAPI names. */
export const resolveEncoder = (
  codec: string,
  gpu: GPUVendor,
  platform: NodeJS.Platform = process.platform
): string => {
  if (usesVaapi(gpu, platform)) return VAAPI_ENCODERS[codec];
  return GPU_ENCODERS[codec]?.[gpu];
};

/** Qualcomm's Media Foundation encoders exist only on Windows on Arm (Snapdragon). */
export const supportsQualcomm = (
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): boolean => platform === 'win32' && arch === 'arm64';

/**
 * Vendor a conversion should request before the encoder check. Apple has no AV1
 * encoder, and Qualcomm needs Windows on Arm.
 */
export const effectiveConversionGpu = (
  gpu: GPUVendor,
  codec: GPUCodec | null,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): GPUVendor => {
  if (gpu === 'qualcomm' && !supportsQualcomm(platform, arch)) return 'cpu';
  return gpu === 'apple' && codec === 'av1' ? 'cpu' : gpu;
};

export const GPU_NAMES: Record<GPUVendor, string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  intel: 'Intel',
  qualcomm: 'Qualcomm',
  apple: 'Apple',
  cpu: 'CPU',
};

export const CODEC_NAMES: Record<string, string> = {
  h264: 'H.264',
  h265: 'H.265/HEVC',
  av1: 'AV1',
};
