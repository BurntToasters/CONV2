import { GPUVendor } from './presets';

/** Shared GPU/CPU encoder map used by FFmpeg runner and capability checks. */
export const GPU_ENCODERS: Record<string, Record<GPUVendor, string>> = {
  h264: {
    nvidia: 'h264_nvenc',
    amd: 'h264_amf',
    intel: 'h264_qsv',
    apple: 'h264_videotoolbox',
    cpu: 'libx264',
  },
  h265: {
    nvidia: 'hevc_nvenc',
    amd: 'hevc_amf',
    intel: 'hevc_qsv',
    apple: 'hevc_videotoolbox',
    cpu: 'libx265',
  },
  av1: {
    nvidia: 'av1_nvenc',
    amd: 'av1_amf',
    intel: 'av1_qsv',
    apple: 'libsvtav1',
    cpu: 'libsvtav1',
  },
};

export const GPU_NAMES: Record<GPUVendor, string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  intel: 'Intel',
  apple: 'Apple',
  cpu: 'CPU',
};

export const CODEC_NAMES: Record<string, string> = {
  h264: 'H.264',
  h265: 'H.265/HEVC',
  av1: 'AV1',
};
