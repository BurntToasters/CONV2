import {
  AdvancedFormatSettings,
  Av1TierCollection,
  AviTierCollection,
  GifTierCollection,
  H264TierCollection,
  H265TierCollection,
  createDefaultAdvancedFormatSettings,
  normalizeAdvancedFormatSettings,
} from './advancedFormats';

export type GPUVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'cpu';
export type PresetCategory = 'av1' | 'h264' | 'h265' | 'avi' | 'gif' | 'remux' | 'audio' | 'custom';
export type GPUCodec = 'av1' | 'h264' | 'h265';

export interface PresetContext {
  advancedFormatSettings?: AdvancedFormatSettings;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  category: PresetCategory;
  extension: string;
  gpuCodec?: GPUCodec;
  aviTier?: keyof AviTierCollection;
  getArgs: (
    inputFile: string,
    outputFile: string,
    gpu: GPUVendor,
    context?: PresetContext
  ) => string[];
}

const getVideoEncoder = (codec: 'h264' | 'h265' | 'av1', gpu: GPUVendor): string => {
  const encoders: Record<string, Record<GPUVendor, string>> = {
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
  return encoders[codec][gpu];
};

const defaultAdvancedFormatSettings = createDefaultAdvancedFormatSettings();
const X265_ADVANCED_PARAMS =
  'aq-mode=3:rd=6:psy-rd=2.0:psy-rdoq=1.0:rdoq-level=2:rc-lookahead=60:bframes=8:ref=6';
const SVTAV1_ADVANCED_PARAMS = 'tune=0:film-grain=0:enable-overlays=1:scd=1:scm=0';

const getNormalizedAdvancedSettings = (context?: PresetContext): AdvancedFormatSettings => {
  return normalizeAdvancedFormatSettings(context?.advancedFormatSettings);
};

const getGifTierSettings = (tier: keyof GifTierCollection, context?: PresetContext) => {
  const normalized = getNormalizedAdvancedSettings(context);
  return normalized.gif.tiers[tier] ?? defaultAdvancedFormatSettings.gif.tiers[tier];
};

const getAv1TierSettings = (tier: keyof Av1TierCollection, context?: PresetContext) => {
  const normalized = getNormalizedAdvancedSettings(context);
  return normalized.av1.tiers[tier] ?? defaultAdvancedFormatSettings.av1.tiers[tier];
};

const getH264TierSettings = (tier: keyof H264TierCollection, context?: PresetContext) => {
  const normalized = getNormalizedAdvancedSettings(context);
  return normalized.h264.tiers[tier] ?? defaultAdvancedFormatSettings.h264.tiers[tier];
};

const getH265TierSettings = (tier: keyof H265TierCollection, context?: PresetContext) => {
  const normalized = getNormalizedAdvancedSettings(context);
  return normalized.h265.tiers[tier] ?? defaultAdvancedFormatSettings.h265.tiers[tier];
};

const getAviTierSettings = (tier: keyof AviTierCollection, context?: PresetContext) => {
  const normalized = getNormalizedAdvancedSettings(context);
  return normalized.avi.tiers[tier] ?? defaultAdvancedFormatSettings.avi.tiers[tier];
};

const getGifLoopArg = (context?: PresetContext): string => {
  const normalized = getNormalizedAdvancedSettings(context);
  return normalized.gif.loopMode === 'once' ? '-1' : '0';
};

const toBitrateKbps = (value: number): string => `${value}k`;

const getQualityArgs = (gpu: GPUVendor, quality: number): string[] => {
  switch (gpu) {
    case 'nvidia':
      // -b:v 0 required to enable proper CQ mode; without it, NVENC uses unconstrained VBR
      return ['-cq', String(quality), '-b:v', '0'];
    case 'amd':
      return ['-rc', 'cqp', '-qp_i', String(quality), '-qp_p', String(quality)];
    case 'intel':
      return ['-global_quality', String(quality)];
    default:
      return ['-crf', String(quality)];
  }
};

const getGifPaletteArgs = (
  input: string,
  output: string,
  tier: keyof GifTierCollection,
  context?: PresetContext
): string[] => {
  const tierSettings = getGifTierSettings(tier, context);
  const loop = getGifLoopArg(context);
  const filter = `[0:v]fps=${tierSettings.fps},scale=${tierSettings.maxDimension}:${tierSettings.maxDimension}:flags=lanczos:force_original_aspect_ratio=decrease,split[v0][v1];[v0]palettegen=max_colors=${tierSettings.maxColors}[palette];[v1][palette]paletteuse=dither=${tierSettings.dither}[gifout]`;

  return [
    '-i',
    input,
    '-filter_complex',
    filter,
    '-map',
    '[gifout]',
    '-an',
    '-sn',
    '-dn',
    '-loop',
    loop,
    output,
  ];
};

const buildAv1Args = (
  input: string,
  output: string,
  gpu: GPUVendor,
  tier: keyof Av1TierCollection,
  context?: PresetContext,
  includeAdvancedParams = false
): string[] => {
  const tierSettings = getAv1TierSettings(tier, context);
  const encoder = getVideoEncoder('av1', gpu);
  const args = [
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a',
    '-c:v',
    encoder,
    ...getQualityArgs(gpu, tierSettings.quality),
  ];

  if (gpu === 'cpu') {
    args.push('-preset', String(tierSettings.cpuPreset));
    if (includeAdvancedParams) {
      args.push('-svtav1-params', SVTAV1_ADVANCED_PARAMS);
    }
  }

  args.push('-c:a', 'libopus', '-b:a', toBitrateKbps(tierSettings.audioBitrateKbps), output);
  return args;
};

const buildH264Args = (
  input: string,
  output: string,
  gpu: GPUVendor,
  tier: keyof H264TierCollection,
  context?: PresetContext
): string[] => {
  const tierSettings = getH264TierSettings(tier, context);
  const encoder = getVideoEncoder('h264', gpu);
  return [
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a',
    '-c:v',
    encoder,
    ...getQualityArgs(gpu, tierSettings.quality),
    '-preset',
    tierSettings.preset,
    '-c:a',
    'aac',
    '-b:a',
    toBitrateKbps(tierSettings.audioBitrateKbps),
    output,
  ];
};

const buildH265Args = (
  input: string,
  output: string,
  gpu: GPUVendor,
  tier: keyof H265TierCollection,
  context?: PresetContext
): string[] => {
  const tierSettings = getH265TierSettings(tier, context);
  const encoder = getVideoEncoder('h265', gpu);
  const args = [
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a',
    '-c:v',
    encoder,
    ...getQualityArgs(gpu, tierSettings.quality),
  ];

  if (gpu === 'cpu') {
    args.push('-preset', tierSettings.preset);
    if (tierSettings.useAdvancedParams) {
      args.push('-x265-params', X265_ADVANCED_PARAMS);
    }
  }

  args.push('-c:a', 'aac', '-b:a', toBitrateKbps(tierSettings.audioBitrateKbps), output);
  return args;
};

const buildAviArgs = (
  input: string,
  output: string,
  gpu: GPUVendor,
  tier: keyof AviTierCollection,
  context?: PresetContext
): string[] => {
  const tierSettings = getAviTierSettings(tier, context);
  const encoder = getVideoEncoder(tierSettings.codec, gpu);
  const args = [
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a',
    '-c:v',
    encoder,
    ...getQualityArgs(gpu, tierSettings.quality),
  ];

  if (tierSettings.codec === 'h264') {
    args.push('-preset', tierSettings.preset);
  } else if (gpu === 'cpu') {
    args.push('-preset', tierSettings.preset);
    if (tierSettings.useAdvancedParams) {
      args.push('-x265-params', X265_ADVANCED_PARAMS);
    }
  }

  args.push('-c:a', 'aac', '-b:a', toBitrateKbps(tierSettings.audioBitrateKbps), output);
  return args;
};

export const PRESET_CATEGORY_ORDER: PresetCategory[] = [
  'av1',
  'h264',
  'h265',
  'avi',
  'gif',
  'remux',
  'audio',
];

export const ADVANCED_PRESET_CATEGORIES: PresetCategory[] = ['avi', 'gif'];

export const PRESET_CATEGORY_LABELS: Record<PresetCategory, string> = {
  av1: 'AV1',
  h264: 'H.264',
  h265: 'H.265/HEVC',
  avi: 'AVI',
  gif: 'GIF',
  remux: 'Remux',
  audio: 'Audio',
  custom: 'Custom',
};

export const isPresetCategoryAdvanced = (category: PresetCategory): boolean => {
  return ADVANCED_PRESET_CATEGORIES.includes(category);
};

export const getVisiblePresetCategories = (showAdvancedPresets: boolean): PresetCategory[] => {
  return PRESET_CATEGORY_ORDER.filter(
    (category) => showAdvancedPresets || !ADVANCED_PRESET_CATEGORIES.includes(category)
  );
};

export const getPresetGpuCodec = (preset: Preset, context?: PresetContext): GPUCodec | null => {
  if (preset.category === 'av1' || preset.category === 'h264' || preset.category === 'h265') {
    return preset.category;
  }

  if (preset.category === 'avi' && preset.aviTier) {
    const settings = getNormalizedAdvancedSettings(context);
    return settings.avi.tiers[preset.aviTier].codec;
  }

  if (preset.gpuCodec) {
    return preset.gpuCodec;
  }
  return null;
};

export const presets: Preset[] = [
  {
    id: 'av1-balanced',
    name: 'AV1 - Balanced',
    description: 'Good balance between quality and file size',
    category: 'av1',
    gpuCodec: 'av1',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) => buildAv1Args(input, output, gpu, 'balanced', context),
  },
  {
    id: 'av1-quality',
    name: 'AV1 - Quality',
    description: 'High quality AV1 encoding',
    category: 'av1',
    gpuCodec: 'av1',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) => buildAv1Args(input, output, gpu, 'quality', context),
  },
  {
    id: 'av1-best-quality',
    name: 'AV1 - Best Quality',
    description: 'Maximum quality with best compression (CRF 15, preset 2)',
    category: 'av1',
    gpuCodec: 'av1',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) =>
      buildAv1Args(input, output, gpu, 'bestQuality', context, true),
  },
  {
    id: 'av1-best-compression',
    name: 'AV1 - Best Compression',
    description: 'Smallest file size with comparable quality (CRF 38, preset 2)',
    category: 'av1',
    gpuCodec: 'av1',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) =>
      buildAv1Args(input, output, gpu, 'bestCompression', context, true),
  },
  {
    id: 'av1-compression',
    name: 'AV1 - Small File',
    description: 'Smaller file size, faster encoding',
    category: 'av1',
    gpuCodec: 'av1',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) =>
      buildAv1Args(input, output, gpu, 'compression', context),
  },
  {
    id: 'h264-fast',
    name: 'H.264 - Fast',
    description: 'Quick encoding, universal compatibility',
    category: 'h264',
    gpuCodec: 'h264',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) => buildH264Args(input, output, gpu, 'fast', context),
  },
  {
    id: 'h264-quality',
    name: 'H.264 - Quality',
    description: 'Better quality H.264 encoding',
    category: 'h264',
    gpuCodec: 'h264',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) => buildH264Args(input, output, gpu, 'quality', context),
  },
  {
    id: 'h265-balanced',
    name: 'H.265/HEVC - Balanced',
    description: 'Good compression with wide device support',
    category: 'h265',
    gpuCodec: 'h265',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) =>
      buildH265Args(input, output, gpu, 'balanced', context),
  },
  {
    id: 'h265-quality',
    name: 'H.265/HEVC - Quality',
    description: 'High quality HEVC encoding',
    category: 'h265',
    gpuCodec: 'h265',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) => buildH265Args(input, output, gpu, 'quality', context),
  },
  {
    id: 'h265-best-quality',
    name: 'H.265/HEVC - Best Quality',
    description: 'Maximum quality with best compression (CRF 16, veryslow)',
    category: 'h265',
    gpuCodec: 'h265',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) =>
      buildH265Args(input, output, gpu, 'bestQuality', context),
  },
  {
    id: 'h265-best-compression',
    name: 'H.265/HEVC - Best Compression',
    description: 'Smallest file size, some quality sacrificed (CRF 32, veryslow)',
    category: 'h265',
    gpuCodec: 'h265',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) =>
      buildH265Args(input, output, gpu, 'bestCompression', context),
  },
  {
    id: 'avi-best-quality',
    name: 'AVI - Best Quality',
    description: 'AVI container with H.265 best quality encoding (CRF 16, veryslow)',
    category: 'avi',
    aviTier: 'bestQuality',
    gpuCodec: 'h265',
    extension: 'avi',
    getArgs: (input, output, gpu, context) =>
      buildAviArgs(input, output, gpu, 'bestQuality', context),
  },
  {
    id: 'avi-best-compression',
    name: 'AVI - Best Compression',
    description: 'AVI container with H.265 best compression (CRF 26, veryslow)',
    category: 'avi',
    aviTier: 'bestCompression',
    gpuCodec: 'h265',
    extension: 'avi',
    getArgs: (input, output, gpu, context) =>
      buildAviArgs(input, output, gpu, 'bestCompression', context),
  },
  {
    id: 'avi-balanced',
    name: 'AVI - Balanced',
    description: 'AVI container with H.264 balanced encoding',
    category: 'avi',
    aviTier: 'balanced',
    gpuCodec: 'h264',
    extension: 'avi',
    getArgs: (input, output, gpu, context) => buildAviArgs(input, output, gpu, 'balanced', context),
  },
  {
    id: 'gif-best-quality',
    name: 'GIF - Best Quality',
    description: 'Maximum GIF quality with highest color detail',
    category: 'gif',
    extension: 'gif',
    getArgs: (input, output, _gpu, context) =>
      getGifPaletteArgs(input, output, 'bestQuality', context),
  },
  {
    id: 'gif-quality',
    name: 'GIF - Quality',
    description: 'High quality GIF with smaller file size',
    category: 'gif',
    extension: 'gif',
    getArgs: (input, output, _gpu, context) => getGifPaletteArgs(input, output, 'quality', context),
  },
  {
    id: 'gif-balanced',
    name: 'GIF - Balanced',
    description: 'Balanced GIF output for quality and compression',
    category: 'gif',
    extension: 'gif',
    getArgs: (input, output, _gpu, context) =>
      getGifPaletteArgs(input, output, 'balanced', context),
  },
  {
    id: 'gif-best-compression',
    name: 'GIF - Best Compression',
    description: 'Smallest GIF size with comparable quality',
    category: 'gif',
    extension: 'gif',
    getArgs: (input, output, _gpu, context) =>
      getGifPaletteArgs(input, output, 'bestCompression', context),
  },
  {
    id: 'remux-mp4',
    name: 'Remux to MP4',
    description: 'Copy streams to MP4 container (no re-encoding)',
    category: 'remux',
    extension: 'mp4',
    getArgs: (input, output) => ['-i', input, '-map', '0', '-c', 'copy', output],
  },
  {
    id: 'remux-mkv',
    name: 'Remux to MKV',
    description: 'Copy streams to MKV container (no re-encoding)',
    category: 'remux',
    extension: 'mkv',
    getArgs: (input, output) => ['-i', input, '-map', '0', '-c', 'copy', output],
  },
  {
    id: 'remux-webm',
    name: 'Remux to WebM',
    description: 'Copy streams to WebM container (no re-encoding)',
    category: 'remux',
    extension: 'webm',
    getArgs: (input, output) => ['-i', input, '-map', '0', '-c', 'copy', output],
  },
  {
    id: 'audio-mp3',
    name: 'Extract Audio (MP3)',
    description: 'Extract audio track as MP3',
    category: 'audio',
    extension: 'mp3',
    getArgs: (input, output) => ['-i', input, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', output],
  },
  {
    id: 'audio-aac',
    name: 'Extract Audio (AAC)',
    description: 'Extract audio track as AAC',
    category: 'audio',
    extension: 'aac',
    getArgs: (input, output) => ['-i', input, '-vn', '-c:a', 'aac', '-b:a', '192k', output],
  },
  {
    id: 'audio-flac',
    name: 'Extract Audio (FLAC)',
    description: 'Extract audio track as lossless FLAC',
    category: 'audio',
    extension: 'flac',
    getArgs: (input, output) => ['-i', input, '-vn', '-c:a', 'flac', output],
  },
];

export const getPresetById = (id: string): Preset | undefined => {
  return presets.find((p) => p.id === id);
};

export const getPresetsByCategory = (category: Preset['category']): Preset[] => {
  return presets.filter((p) => p.category === category);
};
