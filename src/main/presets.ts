import { GPU_ENCODERS } from './gpuEncoders';
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

/** Stream layout of the input, probed before arguments are built. */
export interface SourceStreamInfo {
  videoCodec?: string;
  audioCodec?: string;
  /** Codec names of the input's subtitle streams, in subtitle-stream order. */
  subtitleCodecs?: string[];
}

export interface PresetContext {
  advancedFormatSettings?: AdvancedFormatSettings;
  sourceStreams?: SourceStreamInfo;
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

const getVideoEncoder = (codec: 'h264' | 'h265' | 'av1', gpu: GPUVendor): string =>
  GPU_ENCODERS[codec][gpu];

/**
 * NVENC `-cq`, AMF `-qp_i`/`-qp_p` and QSV `-global_quality` are all 0-51 QP
 * scales. AV1 tier settings allow up to 63 because libsvtav1's CRF range is
 * 0-63, so hardware values must be clamped or FFmpeg rejects them as
 * out-of-range option values.
 */
const GPU_QP_MAX = 51;

/**
 * Resolves the vendor whose argument style actually applies.
 *
 * Some vendor/codec pairs have no hardware encoder and fall back to the CPU
 * encoder (Apple has no AV1 encoder, so it maps to libsvtav1). In that case the
 * quality and preset arguments must follow the CPU form; emitting VideoToolbox
 * flags for a software encoder would fail.
 */
export const resolveEncodeVendor = (codec: 'h264' | 'h265' | 'av1', gpu: GPUVendor): GPUVendor => {
  const encoder = GPU_ENCODERS[codec]?.[gpu];
  const cpuEncoder = GPU_ENCODERS[codec]?.cpu;
  if (!encoder || encoder === cpuEncoder) {
    return 'cpu';
  }
  return gpu;
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

export const getQualityArgs = (
  gpu: GPUVendor,
  quality: number,
  codec: 'h264' | 'h265' | 'av1' = 'h264'
): string[] => {
  // Hardware QP scales stop at 51; CPU encoders keep the full requested range
  // (libsvtav1 accepts CRF up to 63).
  const hwQuality = String(Math.max(0, Math.min(GPU_QP_MAX, Math.round(quality))));

  switch (resolveEncodeVendor(codec, gpu)) {
    case 'nvidia': {
      // -b:v 0 enables true CQ mode; p7 = highest quality preset; multipass = two-pass encode
      const args = ['-cq', hwQuality, '-b:v', '0', '-preset', 'p7', '-multipass', 'fullres'];
      if (codec !== 'av1') {
        // -tune hq, spatial/temporal AQ not supported on av1_nvenc
        args.push('-tune', 'hq', '-spatial_aq', '1', '-temporal_aq', '1');
      }
      return args;
    }
    case 'amd':
      // -quality quality = highest quality preset for AMF
      return ['-rc', 'cqp', '-qp_i', hwQuality, '-qp_p', hwQuality, '-quality', 'quality'];
    case 'intel': {
      // look_ahead + extbrc improve quality for H.264/H.265; not supported on QSV AV1
      const args = ['-global_quality', hwQuality];
      if (codec !== 'av1') {
        args.push('-look_ahead', '1', '-look_ahead_depth', '60', '-extbrc', '1');
      }
      return args;
    }
    case 'apple': {
      const vtQuality = Math.max(
        1,
        Math.min(100, Math.round((1 - Number(hwQuality) / GPU_QP_MAX) * 100))
      );
      return ['-q:v', String(vtQuality), '-allow_sw', '1', '-realtime', '0'];
    }
    default:
      return ['-crf', String(Math.round(quality))];
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
  const bscale = tierSettings.dither === 'bayer' ? ':bayer_scale=5' : '';
  const filter = `[0:v]fps=${tierSettings.fps},scale=${tierSettings.maxDimension}:${tierSettings.maxDimension}:flags=lanczos:force_original_aspect_ratio=decrease,split[v0][v1];[v0]palettegen=max_colors=${tierSettings.maxColors}:stats_mode=full[palette];[v1][palette]paletteuse=dither=${tierSettings.dither}${bscale}:diff_mode=rectangle[gifout]`;

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
  context?: PresetContext
): string[] => {
  const tierSettings = getAv1TierSettings(tier, context);
  const encoder = getVideoEncoder('av1', gpu);
  const args = [
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    encoder,
    ...getQualityArgs(gpu, tierSettings.quality, 'av1'),
  ];

  if (resolveEncodeVendor('av1', gpu) === 'cpu') {
    args.push('-preset', String(tierSettings.cpuPreset));
    // libsvtav1 tuning applies to every tier for consistent perceptual quality.
    args.push('-svtav1-params', SVTAV1_ADVANCED_PARAMS);
    // 10-bit encoding improves AV1 compression efficiency and reduces banding,
    // even from an 8-bit source. Runtime injection may also add this for 10-bit
    // sources; a duplicate flag with the same value is harmless.
    args.push('-pix_fmt', 'yuv420p10le');
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
  const args = [
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    encoder,
    ...getQualityArgs(gpu, tierSettings.quality, 'h264'),
  ];

  if (resolveEncodeVendor('h264', gpu) === 'cpu') {
    args.push('-preset', tierSettings.preset);
    // Force 4:2:0 8-bit output for maximum player/device compatibility
    args.push('-pix_fmt', 'yuv420p');
  }

  args.push('-c:a', 'aac', '-b:a', toBitrateKbps(tierSettings.audioBitrateKbps), output);
  return args;
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
    '0:a?',
    '-c:v',
    encoder,
    ...getQualityArgs(gpu, tierSettings.quality, 'h265'),
  ];

  if (resolveEncodeVendor('h265', gpu) === 'cpu') {
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
    '0:a?',
    '-c:v',
    encoder,
    ...getQualityArgs(gpu, tierSettings.quality, tierSettings.codec),
  ];

  if (resolveEncodeVendor(tierSettings.codec, gpu) === 'cpu') {
    args.push('-preset', tierSettings.preset);
    if (tierSettings.codec === 'h264') {
      // Force 4:2:0 8-bit for maximum player/device compatibility (matches buildH264Args)
      args.push('-pix_fmt', 'yuv420p');
    } else if (tierSettings.useAdvancedParams) {
      args.push('-x265-params', X265_ADVANCED_PARAMS);
    }
  }

  args.push('-c:a', 'libmp3lame', '-b:a', toBitrateKbps(tierSettings.audioBitrateKbps), output);
  return args;
};

/**
 * Text-based subtitle codecs, which FFmpeg can convert into the text subtitle
 * format a container supports. Bitmap subtitles (PGS, DVD, DVB) have no text
 * representation and are left out of the output instead of failing the remux.
 */
const TEXT_SUBTITLE_CODECS: ReadonlySet<string> = new Set([
  'ass',
  'jacosub',
  'microdvd',
  'mov_text',
  'mpl2',
  'pjs',
  'realtext',
  'sami',
  'ssa',
  'srt',
  'stl',
  'subrip',
  'subviewer',
  'subviewer1',
  'text',
  'vplayer',
  'webvtt',
]);

export const isTextSubtitleCodec = (codec: string | undefined): boolean =>
  typeof codec === 'string' && TEXT_SUBTITLE_CODECS.has(codec.toLowerCase());

/** Text subtitle codec each container can carry. */
const REMUX_SUBTITLE_ENCODER: Record<string, string> = {
  mp4: 'mov_text',
  webm: 'webvtt',
};

/**
 * Builds remux arguments for a container.
 *
 * MKV can carry every stream type FFmpeg copies, so the file is preserved
 * wholesale. MP4 and WebM cannot: copying a SubRip stream into MP4 fails with
 * "Could not find tag for codec subrip", and `-map 0` also drags in MKV
 * attachments that MP4 rejects. For those containers streams are mapped
 * explicitly and text subtitles are converted to the container's text format.
 */
const buildRemuxArgs = (
  input: string,
  output: string,
  extension: string,
  context?: PresetContext
): string[] => {
  if (extension === 'mkv') {
    return ['-i', input, '-map', '0', '-map_metadata', '0', '-c', 'copy', output];
  }

  const subtitleCodecs = context?.sourceStreams?.subtitleCodecs ?? [];
  const textSubtitleIndices = subtitleCodecs
    .map((codec, index) => ({ codec, index }))
    .filter((entry) => isTextSubtitleCodec(entry.codec))
    .map((entry) => entry.index);

  const args = ['-i', input, '-map', '0:v:0?', '-map', '0:a?'];
  for (const index of textSubtitleIndices) {
    args.push('-map', `0:s:${index}`);
  }
  args.push('-map_metadata', '0', '-c', 'copy');

  const subtitleEncoder = REMUX_SUBTITLE_ENCODER[extension];
  if (textSubtitleIndices.length > 0 && subtitleEncoder) {
    args.push('-c:s', subtitleEncoder);
  }

  args.push(output);
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

export const ADVANCED_PRESET_CATEGORIES: PresetCategory[] = ['avi'];

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
    description: 'Maximum quality, 10-bit, with strong compression (CRF 18, preset 2)',
    category: 'av1',
    gpuCodec: 'av1',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) =>
      buildAv1Args(input, output, gpu, 'bestQuality', context),
  },
  {
    id: 'av1-best-compression',
    name: 'AV1 - Best Compression',
    description: 'Smallest file size with comparable quality (CRF 38, preset 2)',
    category: 'av1',
    gpuCodec: 'av1',
    extension: 'mp4',
    getArgs: (input, output, gpu, context) =>
      buildAv1Args(input, output, gpu, 'bestCompression', context),
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
    description: 'AVI container with H.264 best quality encoding (CRF 16, veryslow)',
    category: 'avi',
    aviTier: 'bestQuality',
    gpuCodec: 'h264',
    extension: 'avi',
    getArgs: (input, output, gpu, context) =>
      buildAviArgs(input, output, gpu, 'bestQuality', context),
  },
  {
    id: 'avi-best-compression',
    name: 'AVI - Best Compression',
    description: 'AVI container with H.264 best compression (CRF 26, veryslow)',
    category: 'avi',
    aviTier: 'bestCompression',
    gpuCodec: 'h264',
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
    getArgs: (input, output, _gpu, context) => buildRemuxArgs(input, output, 'mp4', context),
  },
  {
    id: 'remux-mkv',
    name: 'Remux to MKV',
    description: 'Copy streams to MKV container (no re-encoding)',
    category: 'remux',
    extension: 'mkv',
    getArgs: (input, output, _gpu, context) => buildRemuxArgs(input, output, 'mkv', context),
  },
  {
    id: 'remux-webm',
    name: 'Remux to WebM',
    description: 'Copy streams to WebM container (no re-encoding)',
    category: 'remux',
    extension: 'webm',
    getArgs: (input, output, _gpu, context) => buildRemuxArgs(input, output, 'webm', context),
  },
  {
    id: 'audio-mp3',
    name: 'Extract Audio (MP3)',
    description: 'Extract audio track as MP3',
    category: 'audio',
    extension: 'mp3',
    getArgs: (input, output) => [
      '-i',
      input,
      '-vn',
      '-map_metadata',
      '0',
      '-c:a',
      'libmp3lame',
      '-q:a',
      '2',
      output,
    ],
  },
  {
    id: 'audio-aac',
    name: 'Extract Audio (AAC)',
    description: 'Extract audio track as AAC',
    category: 'audio',
    extension: 'aac',
    getArgs: (input, output) => [
      '-i',
      input,
      '-vn',
      '-map_metadata',
      '0',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      output,
    ],
  },
  {
    id: 'audio-flac',
    name: 'Extract Audio (FLAC)',
    description: 'Extract audio track as lossless FLAC',
    category: 'audio',
    extension: 'flac',
    getArgs: (input, output) => ['-i', input, '-vn', '-map_metadata', '0', '-c:a', 'flac', output],
  },
];

export const getPresetById = (id: string): Preset | undefined => {
  return presets.find((p) => p.id === id);
};

export const getPresetsByCategory = (category: Preset['category']): Preset[] => {
  return presets.filter((p) => p.category === category);
};
